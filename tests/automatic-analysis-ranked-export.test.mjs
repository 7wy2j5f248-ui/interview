import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile, readdir } from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
    writeRankedAnalysisWorkbook
} from "../api/automatic-analysis-ranked-export.js";
import {
    createTaskLimiter,
    rowsForIds
} from "../server/supabaseBatching.js";
import { rankAnalysisCase } from "../server/analysisFrequencyRanking.js";

async function workbookBuffer(cases) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeRankedAnalysisWorkbook(
        stream,
        cases,
        new Date("2026-08-29T00:00:00.000Z")
    );
    await completed;
    return Buffer.concat(chunks);
}

test("complete workbook uses the shared ranking and contains compact linked references", async () => {
    const ranked = rankAnalysisCase({
        caseNumber: "P0001-S01",
        participantCode: "P0001",
        sessionNumber: 1,
        sessionId: "session-1",
        status: "completed",
        hasReport: true,
        language: "en",
        demographics: {},
        caseInterpretation: "Interpretation",
        codes: [
            { id: "weak", code_number: 1, code_label: "Weak" },
            { id: "strong", code_number: 2, code_label: "Strong" }
        ],
        themes: [
            { id: "weak-theme", theme_number: 1, theme_label: "Weak theme" },
            { id: "strong-theme", theme_number: 2, theme_label: "Strong theme" }
        ],
        themeCodes: [
            { theme_id: "weak-theme", code_id: "weak" },
            { theme_id: "strong-theme", code_id: "strong" }
        ],
        highlights: [
            { id: "w1", code_id: "weak", exact_text: "small" },
            ...Array.from({ length: 3 }, (_, index) => ({
                id: `s${index}`,
                code_id: "strong",
                exact_text: "large"
            }))
        ]
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer([ranked]));

    assert.deepEqual(
        workbook.worksheets.map(sheet => sheet.name),
        ["1 Cases & keywords", "2 Codes", "3 Themes", "4 Notes & sources"]
    );
    const formOne = workbook.getWorksheet("1 Cases & keywords");
    const headers = formOne.getRow(1).values.slice(1);
    assert.deepEqual(headers.slice(0, 3), ["P#", "S#", "Language"]);
    assert.ok(!headers.includes("Session ID"));
    assert.ok(!headers.includes("Case interpretation"));
    const reportColumn = headers.indexOf("Case report") + 1;
    assert.equal(formOne.getRow(2).getCell(reportColumn).value.result, "Available");
    assert.equal(
        formOne.getRow(2).getCell(reportColumn).value.formula,
        "HYPERLINK(\"#'4 Notes & sources'!A2\",\"Available\")"
    );
    assert.equal(formOne.getRow(2).height, 18);
    assert.equal(formOne.getColumn(1).width, 9);
    assert.equal(formOne.getColumn(2).width, 5);
    assert.match(
        workbook.getWorksheet("2 Codes").getCell("D2").value,
        /^3 mentions each · Strong \(1 keyword\)$/
    );
    assert.match(
        workbook.getWorksheet("3 Themes").getCell("D2").value,
        /^3 mentions each · Strong theme \(1 code, 1 keyword\)$/
    );
    const references = workbook.getWorksheet("4 Notes & sources");
    assert.equal(references.getCell("A2").value, "R000001");
    assert.equal(references.getCell("F2").value, "Case briefing");
    assert.equal(references.getCell("H2").value, "Interpretation");
    assert.equal(
        references.getCell("E2").value.formula,
        "HYPERLINK(\"#'1 Cases & keywords'!P2\",\"P2\")"
    );
});

test("workbook groups equal mention ranks and uses stored English source text", async () => {
    const ranked = rankAnalysisCase({
        caseNumber: "P0002-S01",
        participantCode: "P0002",
        sessionNumber: 1,
        sessionId: "session-2",
        status: "completed",
        hasReport: true,
        language: "zh",
        demographics: {},
        caseInterpretation: "Late sleep and night work recur in this case.",
        codes: [
            { id: "work", code_number: 1, code_label: "Work schedule" },
            { id: "sleep", code_number: 2, code_label: "Sleep patterns" }
        ],
        themes: [
            { id: "work-theme", theme_number: 1, theme_label: "Work" },
            { id: "sleep-theme", theme_number: 2, theme_label: "Sleep" }
        ],
        themeCodes: [
            { theme_id: "work-theme", code_id: "work" },
            { theme_id: "sleep-theme", code_id: "sleep" }
        ],
        highlights: [
            {
                id: "s1",
                code_id: "sleep",
                message_id: "message-1",
                exact_text: "晚睡",
                source_language: "zh",
                english_translation: "I go to bed late."
            },
            {
                id: "s2",
                code_id: "sleep",
                message_id: "message-2",
                exact_text: "晚睡",
                source_language: "zh",
                english_translation: "I go to bed late."
            },
            {
                id: "w1",
                code_id: "work",
                message_id: "message-3",
                exact_text: "夜班",
                source_language: "zh",
                english_translation: "I work night shifts."
            },
            {
                id: "w2",
                code_id: "work",
                message_id: "message-4",
                exact_text: "夜班",
                source_language: "zh",
                english_translation: "I work night shifts."
            }
        ]
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer([ranked]));

    const formOne = workbook.getWorksheet("1 Cases & keywords");
    const headers = formOne.getRow(1).values.slice(1);
    const keywordColumn = headers.indexOf("K1") + 1;
    const keywordCell = formOne.getRow(2).getCell(keywordColumn);
    assert.match(keywordCell.value.result, /^2 mentions each/);
    assert.match(keywordCell.value.result, /I go to bed late\./);
    assert.match(keywordCell.value.result, /I work night shifts\./);
    assert.doesNotMatch(keywordCell.value.result, /晚睡|夜班/);
    assert.match(keywordCell.value.formula, /#'4 Notes & sources'!A3/);

    const references = workbook.getWorksheet("4 Notes & sources");
    const keywordReference = references.getCell("H3").value;
    assert.match(keywordReference, /晚睡/);
    assert.match(keywordReference, /夜班/);
    assert.match(keywordReference, /message-1/);
    assert.match(keywordReference, /message-4/);

    const codeSheet = workbook.getWorksheet("2 Codes");
    assert.equal(codeSheet.getCell("D1").value, "C1");
    assert.equal(codeSheet.getCell("E1").value, null);
    assert.match(
        codeSheet.getCell("D2").value,
        /^2 mentions each · Sleep patterns \(1 keyword\); Work schedule \(1 keyword\)$/
    );

    const themeSheet = workbook.getWorksheet("3 Themes");
    assert.equal(themeSheet.getCell("D1").value, "T1");
    assert.equal(themeSheet.getCell("E1").value, null);
    assert.match(
        themeSheet.getCell("D2").value,
        /^2 mentions each · Sleep \(1 code, 1 keyword\); Work \(1 code, 1 keyword\)$/
    );
});

test("streamed complete workbook represents 10,000 cases in one file", async () => {
    const cases = Array.from({ length: 10_000 }, (_, index) => ({
        caseNumber: `P${String(index + 1).padStart(5, "0")}-S01`,
        participantCode: `P${String(index + 1).padStart(5, "0")}`,
        sessionNumber: 1,
        sessionId: `session-${index + 1}`,
        status: "pending",
        hasReport: false,
        language: "en",
        demographics: {},
        caseInterpretation: "",
        rankedCodes: [],
        rankedThemes: [],
        rankedKeywords: [],
        rankedCodeGroups: [],
        rankedThemeGroups: [],
        rankedKeywordGroups: []
    }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(cases));

    assert.equal(workbook.getWorksheet("1 Cases & keywords").rowCount, 10_001);
    assert.equal(workbook.getWorksheet("1 Cases & keywords").getCell("A10001").value, "P10000");
    assert.equal(workbook.worksheets.length, 4);
    assert.equal(workbook.getWorksheet("4 Notes & sources").rowCount, 1);
});

test("generated XLSX package contains no legacy comments or VML drawings", async () => {
    const ranked = rankAnalysisCase({
        caseNumber: "P0003-S01",
        participantCode: "P0003",
        sessionNumber: 1,
        sessionId: "session-3",
        status: "completed",
        hasReport: true,
        language: "zh",
        demographics: {},
        caseInterpretation: "Compact case briefing.",
        codes: [{ id: "code-1", code_number: 1, code_label: "Sleep" }],
        themes: [{ id: "theme-1", theme_number: 1, theme_label: "Rest" }],
        themeCodes: [{ theme_id: "theme-1", code_id: "code-1" }],
        highlights: [{
            id: "highlight-1",
            code_id: "code-1",
            message_id: "message-1",
            exact_text: "晚睡",
            source_language: "zh",
            english_translation: "I go to bed late."
        }]
    });
    const zip = await JSZip.loadAsync(await workbookBuffer([ranked]));
    const paths = Object.keys(zip.files);
    const commentsOrVml = paths.filter(path =>
        /^xl\/comments\d+\.xml$/i.test(path)
        || /^xl\/drawings\/vmlDrawing\d+\.vml$/i.test(path)
    );
    assert.deepEqual(commentsOrVml, []);

    const contentTypes = await zip.file("[Content_Types].xml").async("string");
    const caseSheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    assert.doesNotMatch(contentTypes, /comments/i);
    assert.doesNotMatch(caseSheet, /legacyDrawing/i);
    assert.ok(!zip.file("xl/worksheets/_rels/sheet1.xml.rels"));
    assert.match(caseSheet, /HYPERLINK\(&quot;#&apos;4 Notes &amp; sources&apos;!A2&quot;/);
});

test("10,000-ID related reads are bounded but no longer sequential", async () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `id-${index}`);
    const schedule = createTaskLimiter(8);
    let active = 0;
    let maximumActive = 0;
    let queryCount = 0;

    const rows = await rowsForIds(
        ids,
        chunk => ({
            async range() {
                queryCount += 1;
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await new Promise(resolve => setTimeout(resolve, 1));
                active -= 1;
                return { data: [{ first: chunk[0] }], error: null };
            }
        }),
        "Synthetic related rows failed.",
        { schedule }
    );

    assert.equal(queryCount, 100);
    assert.equal(rows.length, 100);
    assert.ok(maximumActive > 1);
    assert.ok(maximumActive <= 8);
});

test("active export excludes archived jobs and legacy URL redirects to the canonical handler", async () => {
    const rankedExport = await readFile(
        new URL("../api/automatic-analysis-ranked-export.js", import.meta.url),
        "utf8"
    );
    const vercelConfig = JSON.parse(await readFile(
        new URL("../vercel.json", import.meta.url),
        "utf8"
    ));
    const highlightSources = await readFile(
        new URL("../server/analysisHighlightSources.js", import.meta.url),
        "utf8"
    );

    assert.match(
        rankedExport,
        /automatic_case_analysis_jobs[\s\S]*\.is\("archived_at", null\)/
    );
    assert.match(rankedExport, /enrichAnalysisHighlightSources/);
    assert.match(
        highlightSources,
        /select\("id, Language, EnglishTranslation"\)/
    );
    assert.deepEqual(vercelConfig.redirects, [{
        source: "/api/automatic-analysis-export",
        destination: "/api/automatic-analysis-ranked-export",
        permanent: true
    }]);
});

test("Vercel function entries remain within the Hobby deployment limit", async () => {
    const apiFiles = (await readdir(new URL("../api/", import.meta.url)))
        .filter(name => name.endsWith(".js"))
        .sort();

    assert.ok(apiFiles.length <= 12);
    assert.equal(apiFiles.length, 12);
    assert.ok(apiFiles.includes("automatic-analysis-review.js"));
    assert.ok(!apiFiles.includes("participants.js"));
    assert.ok(!apiFiles.includes("sessions.js"));
    assert.ok(!apiFiles.includes("automatic-analysis-export.js"));
});

test("separate keyword records are rebuilt from each fully loaded page set", async () => {
    const dashboard = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );
    const dashboardApi = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /const remainingPages = await fetchRemainingDashboardPages/);
    assert.match(dashboard, /DASHBOARD_PAGE_CONCURRENCY = 4/);
    assert.match(dashboard, /payload = \{ \.\.\.firstPage, cases \};[\s\S]*render\(\)/);
    assert.match(dashboard, /function renderKeywords[\s\S]*caseRecord\.highlights/);
    assert.match(dashboard, /Framework \/ report provenance/);
    assert.match(dashboard, /Open exact evidence/);
    assert.match(dashboard, /tableHost\.replaceChildren\(scroll\)/);
    assert.doesNotMatch(dashboard, /dataset\.frequencyKeywords/);
    assert.match(dashboardApi, /import \{ rankAnalysisCase \}/);
    assert.match(dashboardApi, /return rankAnalysisCase\(\{/);
});
