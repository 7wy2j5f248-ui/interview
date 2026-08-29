import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile, readdir } from "node:fs/promises";
import ExcelJS from "exceljs";
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

test("complete workbook uses the shared ranking and contains Forms 1-3", async () => {
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
        ["1 Cases & keywords", "2 Codes", "3 Themes"]
    );
    const formOne = workbook.getWorksheet("1 Cases & keywords");
    const headers = formOne.getRow(1).values.slice(1);
    assert.deepEqual(headers.slice(0, 3), ["P#", "S#", "Language"]);
    assert.ok(!headers.includes("Session ID"));
    assert.ok(!headers.includes("Case interpretation"));
    const reportColumn = headers.indexOf("Case report") + 1;
    assert.equal(formOne.getRow(2).getCell(reportColumn).value, "Available");
    assert.match(
        JSON.stringify(formOne.getRow(2).getCell(reportColumn).note),
        /Interpretation/
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
    assert.match(keywordCell.value, /^2 mentions each/);
    assert.match(keywordCell.value, /I go to bed late\./);
    assert.match(keywordCell.value, /I work night shifts\./);
    assert.doesNotMatch(keywordCell.value, /晚睡|夜班/);
    const keywordNote = JSON.stringify(keywordCell.note);
    assert.match(keywordNote, /晚睡/);
    assert.match(keywordNote, /夜班/);
    assert.match(keywordNote, /message-1/);
    assert.match(keywordNote, /message-4/);

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
    assert.equal(workbook.worksheets.length, 3);
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

    assert.match(
        rankedExport,
        /automatic_case_analysis_jobs[\s\S]*\.is\("archived_at", null\)/
    );
    assert.match(rankedExport, /select\("id, Language, EnglishTranslation"\)/);
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
    assert.equal(apiFiles.length, 11);
    assert.ok(!apiFiles.includes("participants.js"));
    assert.ok(!apiFiles.includes("sessions.js"));
    assert.ok(!apiFiles.includes("automatic-analysis-export.js"));
});

test("keyword columns are rebuilt from each fully loaded page set", async () => {
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
    assert.match(dashboard, /function renderCases[\s\S]*keywordFrequency/);
    assert.match(dashboard, /tableHost\.replaceChildren\(scroll\)/);
    assert.doesNotMatch(dashboard, /dataset\.frequencyKeywords/);
    assert.match(dashboardApi, /import \{ rankAnalysisCase \}/);
    assert.match(dashboardApi, /return rankAnalysisCase\(\{/);
});
