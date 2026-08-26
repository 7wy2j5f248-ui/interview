import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../researcher.html", import.meta.url), "utf8");
const script = await readFile(
    new URL("../researcher-analysis.js", import.meta.url),
    "utf8"
);
const api = await readFile(new URL("../api/analysis.js", import.meta.url), "utf8");

function functionSource(name, nextName) {
    const start = script.indexOf(`function ${name}`);
    const end = script.indexOf(`function ${nextName}`, start + 1);
    assert.notEqual(start, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${nextName} must follow ${name}`);
    return script.slice(start, end);
}

test("dashboard exposes three named workbook worksheets", () => {
    assert.match(html, /1 · Participants &amp; Themes/);
    assert.match(html, /2 · Codes &amp; Themes/);
    assert.match(html, /3 · Keywords &amp; Codes/);
    assert.match(script, /function renderThemeWorksheet/);
    assert.match(script, /function renderCodeWorksheet/);
    assert.match(script, /function renderKeywordWorksheet/);
    assert.match(script, /let activeAnalysisView = "themes"/);
});

test("Worksheet 1 retains metadata and is the only worksheet with transcript links", () => {
    const themeSource = functionSource("renderThemeWorksheet", "selectedThemeItem");
    const codeSource = functionSource("renderCodeWorksheet", "renderKeywordWorksheet");
    const keywordSource = functionSource("renderKeywordWorksheet", "renderHierarchyView");

    [
        "Participant ID",
        "Link to transcript",
        "Language",
        "Country of residence",
        "Country of origin",
        "Gender",
        "Age",
        "Occupation",
        "Education"
    ].forEach(label => assert.match(script, new RegExp(`"${label}"`)));
    assert.match(themeSource, /openTranscript/);
    assert.doesNotMatch(codeSource, /openTranscript|openProvenance/);
    assert.doesNotMatch(keywordSource, /openTranscript|openProvenance/);
});

test("Worksheet 2 has one row model for each participant-code relationship", () => {
    const source = functionSource("renderCodeWorksheet", "renderKeywordWorksheet");
    assert.match(source, /participantRecords\(\)\.forEach\(participant/);
    assert.match(source, /codes\.forEach\(code/);
    assert.match(source, /"Code #"/);
    assert.match(source, /"Expression"/);
    assert.match(source, /themes\.forEach/);
    assert.match(source, /relations\.some/);
});

test("Worksheet 3 maps recognizable keyword expressions across code columns", () => {
    const source = functionSource("renderKeywordWorksheet", "renderHierarchyView");
    assert.match(source, /keywords\.forEach\(keyword/);
    assert.match(source, /"Keyword #"/);
    assert.match(source, /"Expression"/);
    assert.match(source, /codes\.forEach/);
    assert.match(source, /codeIds\.has\(messageId\)/);
    assert.match(script, /worksheetIdentifier\("K", index\)/);
    assert.match(script, /worksheetIdentifier\("C", index\)/);
});

test("worksheet identifiers are dynamic concept identifiers rather than fixed rows", () => {
    assert.match(script, /padStart\(2, "0"\)/);
    assert.match(script, /const records = new Map\(\)/);
    assert.doesNotMatch(script, /"P06"|previewWorkspace|analysisPreview/);
});

test("real stored corpus participants are returned even before an analysis run exists", () => {
    assert.match(api, /const eligibleSessions = await loadEligibleSessionRows/);
    assert.match(api, /participants: scopedSessions\.map/);
    assert.match(api, /corpusMessages: corpusRows\.map/);
    assert.match(api, /participants: \[\.\.\.provenance\.sessionById\.values\(\)\]/);
    assert.match(script, /workspace\?\.participants/);
    assert.match(script, /Real interview data loaded/);
});

test("AI discussion remains grounded server-side and revisions stay explicit", () => {
    assert.match(api, /"discuss"/);
    assert.match(api, /async function discussAnalysis/);
    assert.match(html, /Discuss this analysis with AI/);
    assert.match(html, /Apply this revision/);
    assert.match(script, /action:\s*"save_feedback"/);
    assert.match(script, /action:\s*"confirm"/);
    assert.match(script, /action:\s*"archive"/);
});
