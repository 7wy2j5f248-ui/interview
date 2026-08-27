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
    assert.match(html, /read one transcript → attach its demographic data/);
    assert.match(html, /A theme is a concept that categorizes codes/);
    assert.match(html, /A code is a categorized\s+expression of keywords/);
});

test("opening the local dashboard redirects to the live HTTPS site", () => {
    assert.match(html, /window\.location\.protocol === "file:"/);
    assert.match(
        html,
        /window\.location\.replace\("https:\/\/intervu\.quest\/researcher\.html"\)/
    );
});

test("Worksheet 1 retains metadata and is the only worksheet with transcript links", () => {
    const themeSource = functionSource("renderThemeWorksheet", "selectedThemeItem");
    const codeSource = functionSource("renderCodeWorksheet", "renderKeywordWorksheet");
    const keywordSource = functionSource("renderKeywordWorksheet", "renderHierarchyView");

    [
        "Participant code",
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
    assert.match(themeSource, /Open case report/);
    assert.match(script, /function openIndividualCaseReport/);
    assert.match(script, /demographicHeading\.textContent = "Demographic data"/);
    assert.match(script, /participantMetadataHeadings\.forEach/);
    assert.match(script, /Form 1 is the theme-level researcher-validation form/);
    assert.match(html, /id="caseReportDialog"/);
    assert.doesNotMatch(codeSource, /openTranscript|openProvenance/);
    assert.doesNotMatch(keywordSource, /openTranscript|openProvenance/);
});

test("Worksheet 1 uses fixed participant-specific T1 to T8 slots", () => {
    const source = functionSource("renderThemeWorksheet", "selectedThemeItem");

    assert.match(script, /const PARTICIPANT_THEME_SLOT_COUNT = 8/);
    assert.match(script, /function participantThemeRecords/);
    assert.match(source, /participantThemeSlotIdentifier\(slotIndex\)/);
    assert.match(source, /participantThemeRecords\(participant\)/);
    assert.match(source, /expressionButton\(\s*theme\.label,\s*theme\.item/);
    assert.match(source, /participantThemeCell/);
    assert.doesNotMatch(
        source,
        /themes\.forEach\(theme => appendHeader|theme\.label,\s*theme\.identifier/
    );
    assert.doesNotMatch(source, /relationCell/);
    assert.match(
        script,
        /T1–T8 contain the broadest one- or two-word concepts/
    );
    assert.match(script, /broadest one- or two-word concept/);
    assert.match(html, /Themes are the broadest concepts/);
    assert.match(html, /Theme concept \(1–2 words\)/);
});

test("worksheet rows use private participant codes rather than source IDs", () => {
    assert.match(script, /participantCode:\s*null/);
    assert.match(script, /participant\.participantCode \|\| "Uncoded participant"/);
    assert.match(script, /appendHeader\(headingRow, "Participant code"\)/);
    assert.doesNotMatch(script, /appendHeader\(headingRow, "Participant ID"\)/);
    assert.match(html, /id="transcriptIdentity"/);
    assert.match(html, /\["Participant code", identity\.participantCode\]/);
    assert.match(html, /\["Participant ID", identity\.participantId\]/);
    assert.match(html, /Transcript hidden because its participant identity does not match/);
    assert.match(html, /transcriptView\.scrollIntoView/);
});

test("Worksheet 2 uses content-free participant-specific code slots", () => {
    const source = functionSource("renderCodeWorksheet", "renderKeywordWorksheet");
    assert.match(script, /const PARTICIPANT_CODE_SLOT_COUNT = 10/);
    assert.match(script, /function participantCodeRecords/);
    assert.match(script, /function participantCodeSlotIdentifier/);
    assert.match(source, /participantCodeSlotIdentifier\(/);
    assert.match(source, /participantCodeRecords\(/);
    assert.match(source, /appendParticipantAnalysisCell\(/);
    assert.doesNotMatch(source, /theme\.label|code\.label/);
    assert.doesNotMatch(source, /"Code #"|"Expression"|relationCell/);
    assert.match(script, /Tn-C1–Tn-C10 are positional headers only/);
});

test("Worksheet 3 uses content-free participant-specific keyword slots", () => {
    const source = functionSource("renderKeywordWorksheet", "renderHierarchyView");
    assert.match(script, /const PARTICIPANT_KEYWORD_SLOT_COUNT = 10/);
    assert.match(script, /function participantKeywordRecords/);
    assert.match(script, /function participantKeywordSlotIdentifier/);
    assert.match(source, /participantKeywordSlotIdentifier\(/);
    assert.match(source, /participantKeywordRecords\(/);
    assert.match(source, /appendParticipantAnalysisCell\(/);
    assert.doesNotMatch(source, /code\.label|keyword\.label/);
    assert.doesNotMatch(source, /"Keyword #"|"Expression"|relationCell/);
    assert.match(script, /Tn-Cn-K1–Tn-Cn-K10 are positional headers only/);
});

test("worksheet identifiers preserve participant-specific hierarchy", () => {
    assert.match(script, /`T\$\{index \+ 1\}`/);
    assert.match(script, /-C\$\{codeIndex \+ 1\}/);
    assert.match(script, /-K\$\{keywordIndex \+ 1\}/);
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
    assert.match(api, /themeSubject\(req\.body\?\.theme\)/);
    assert.match(api, /broad one- or two-word concept/);
});

test("analysis generation is resumable one stored individual case at a time", () => {
    assert.match(api, /async function startAnalysisGeneration/);
    assert.match(api, /async function processGenerationBatch/);
    assert.match(api, /action === "process_generation_batch"/);
    assert.match(api, /input_token_count === null/);
    assert.match(script, /while \(canResumeGeneration\(\)\)/);
    assert.match(script, /action: "process_generation_batch"/);
    assert.match(script, /Resume individual case reports/);
    assert.match(script, /Generate corrected new analysis run/);
    assert.match(api, /strategy: "individual_case_report"/);
    assert.match(api, /one_transcript_per_case/);
    assert.match(api, /buildIndividualCaseBatches/);
    assert.match(api, /complete_ai_analysis_case/);
    assert.match(api, /This individual case report was incomplete and remains the current case/);
    assert.match(script, /function renderIndividualCaseReports/);
    assert.match(script, /function formOneReady/);
    assert.match(script, /Form 1 will be generated only after every case report is complete/);
    assert.match(script, /Open complete report/);
    assert.match(html, /id="individualCaseReportsList"/);
    assert.match(html, /processing remains on\s+that case and does not move forward/);
});

test("each worksheet supports a traceable Excel round-trip", () => {
    assert.match(script, /Download for Excel/);
    assert.match(script, /Upload grouping to Worksheet 2/);
    assert.match(script, /Upload grouping to Worksheet 3/);
    assert.match(script, /function workbookSnapshot/);
    assert.match(script, /function uploadWorkbook/);
    assert.match(api, /workbookImports/);
    assert.match(html, /traceable researcher-validation layer/);
});
