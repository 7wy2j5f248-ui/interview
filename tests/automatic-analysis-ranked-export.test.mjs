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

test("complete workbook uses MU CO CA TH headers and content-only analytical cells", async () => {
    const caseRecord = {
        caseNumber: "P0001-S01",
        participantCode: "P0001",
        sessionNumber: 1,
        sessionId: "session-1",
        status: "completed",
        hasReport: true,
        language: "en",
        demographics: {},
        caseInterpretation: "Interpretation",
        codes: [{ id: "code-1", code_number: 1, code_label: "Sleep interruption" }],
        categories: [{ id: "category-1", category_number: 1, category_label: "Interrupted sleep" }],
        themes: [{ id: "theme-1", theme_number: 1, theme_label: "Work disrupting boundaries around sleep" }],
        meaningUnits: [{
            id: "unit-1",
            unit_number: 1,
            message_id: "message-1",
            exact_text: "I keep waking up at three in the morning because I am thinking about tomorrow's work.",
            anchor_expressions: ["waking up at three", "thinking about tomorrow's work"]
        }]
    };
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer([caseRecord]));

    assert.deepEqual(
        workbook.worksheets.map(sheet => sheet.name),
        ["1 Cases & meaning units", "2 Codes", "3 Categories", "4 Themes", "5 Notes & sources"]
    );
    const formOne = workbook.getWorksheet("1 Cases & meaning units");
    const headers = formOne.getRow(1).values.slice(1);
    assert.deepEqual(headers.slice(0, 3), ["P#", "S#", "Language"]);
    assert.ok(!headers.includes("Session ID"));
    assert.ok(!headers.includes("Case interpretation"));
    const reportColumn = headers.indexOf("Case report") + 1;
    assert.equal(formOne.getRow(2).getCell(reportColumn).value.result, "Available");
    assert.equal(
        formOne.getRow(2).getCell(reportColumn).value.formula,
        "HYPERLINK(\"#'5 Notes & sources'!A2\",\"Available\")"
    );
    assert.equal(formOne.getRow(2).height, 18);
    assert.equal(formOne.getColumn(1).width, 9);
    assert.equal(formOne.getColumn(2).width, 5);
    assert.equal(workbook.getWorksheet("2 Codes").getCell("D1").value, "CO1");
    assert.equal(workbook.getWorksheet("2 Codes").getCell("D2").value, "Sleep interruption");
    assert.equal(workbook.getWorksheet("3 Categories").getCell("D1").value, "CA1");
    assert.equal(workbook.getWorksheet("3 Categories").getCell("D2").value, "Interrupted sleep");
    assert.equal(workbook.getWorksheet("4 Themes").getCell("D1").value, "TH1");
    assert.equal(workbook.getWorksheet("4 Themes").getCell("D2").value, "Work disrupting boundaries around sleep");
    const references = workbook.getWorksheet("5 Notes & sources");
    assert.equal(references.getCell("A2").value, "R000001");
    assert.equal(references.getCell("F2").value, "Case briefing");
    assert.equal(references.getCell("H2").value, "Interpretation");
    assert.equal(
        references.getCell("E2").value.formula,
        "HYPERLINK(\"#'1 Cases & meaning units'!P2\",\"P2\")"
    );
});

test("workbook keeps position identifiers in headers and meaning-unit evidence in notes", async () => {
    const caseRecord = {
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
            { id: "sleep", code_number: 2, code_label: "Sleep timing" }
        ],
        categories: [
            { id: "work-category", category_number: 1, category_label: "Night work scheduling" },
            { id: "sleep-category", category_number: 2, category_label: "Delayed sleep timing" }
        ],
        themes: [{ id: "theme-1", theme_number: 1, theme_label: "Work shifting the timing of sleep" }],
        meaningUnits: [{
            id: "unit-1",
            unit_number: 1,
            message_id: "message-1",
            exact_text: "晚睡",
            source_language: "zh",
            english_translation: "I go to bed late.",
            anchor_expressions: ["晚睡"]
        }]
    };
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer([caseRecord]));

    const formOne = workbook.getWorksheet("1 Cases & meaning units");
    const headers = formOne.getRow(1).values.slice(1);
    const unitColumn = headers.indexOf("MU1") + 1;
    const unitCell = formOne.getRow(2).getCell(unitColumn);
    assert.equal(unitCell.value.result, "晚睡");
    assert.match(unitCell.value.formula, /#'5 Notes & sources'!A3/);

    const references = workbook.getWorksheet("5 Notes & sources");
    const unitReference = references.getCell("H3").value;
    assert.match(unitReference, /晚睡/);
    assert.match(unitReference, /I go to bed late\./);
    assert.match(unitReference, /message-1/);

    const codeSheet = workbook.getWorksheet("2 Codes");
    assert.equal(codeSheet.getCell("D1").value, "CO1");
    assert.equal(codeSheet.getCell("E1").value, "CO2");
    assert.equal(codeSheet.getCell("D2").value, "Work schedule");
    assert.equal(codeSheet.getCell("E2").value, "Sleep timing");
    assert.doesNotMatch(codeSheet.getCell("D2").value, /^CO1:/);

    const categorySheet = workbook.getWorksheet("3 Categories");
    assert.equal(categorySheet.getCell("D1").value, "CA1");
    assert.equal(categorySheet.getCell("D2").value, "Night work scheduling");
    const themeSheet = workbook.getWorksheet("4 Themes");
    assert.equal(themeSheet.getCell("D1").value, "TH1");
    assert.equal(themeSheet.getCell("D2").value, "Work shifting the timing of sleep");
    assert.doesNotMatch(themeSheet.getCell("D2").value, /^TH1:/);
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
        codes: [],
        categories: [],
        themes: [],
        meaningUnits: []
    }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(cases));

    assert.equal(workbook.getWorksheet("1 Cases & meaning units").rowCount, 10_001);
    assert.equal(workbook.getWorksheet("1 Cases & meaning units").getCell("A10001").value, "P10000");
    assert.equal(workbook.worksheets.length, 5);
    assert.equal(workbook.getWorksheet("5 Notes & sources").rowCount, 1);
});

test("generated XLSX package contains no legacy comments or VML drawings", async () => {
    const caseRecord = {
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
        categories: [],
        themes: [],
        meaningUnits: [{
            id: "unit-1",
            unit_number: 1,
            message_id: "message-1",
            exact_text: "晚睡",
            source_language: "zh",
            english_translation: "I go to bed late.",
            anchor_expressions: ["晚睡"]
        }]
    };
    const zip = await JSZip.loadAsync(await workbookBuffer([caseRecord]));
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
    assert.match(caseSheet, /HYPERLINK\(&quot;#&apos;5 Notes &amp; sources&apos;!A2&quot;/);
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
    assert.deepEqual(vercelConfig.redirects.find(item =>
        item.source === "/api/automatic-analysis-export"
    ), {
        source: "/api/automatic-analysis-export",
        destination: "/api/automatic-analysis-ranked-export",
        permanent: true
    });
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
    assert.match(dashboard, /function renderKeywords[\s\S]*analysisUnits\(caseRecord\)/);
    assert.match(dashboard, /keywordExpressions\(unit\)/);
    assert.match(dashboard, /Framework \/ report provenance/);
    assert.match(dashboard, /Open exact evidence/);
    assert.match(dashboard, /tableHost\.replaceChildren\(scroll\)/);
    assert.doesNotMatch(dashboard, /dataset\.frequencyKeywords/);
    assert.match(dashboardApi, /import \{ rankAnalysisCase \}/);
    assert.match(dashboardApi, /return rankAnalysisCase\(\{/);
});
