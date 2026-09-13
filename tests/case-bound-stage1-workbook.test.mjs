import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildCaseInspection } from "../server/caseBoundInspection.js";
import {
    CASE_BOUND_STAGE1_WORKBOOK_SHEETS,
    caseBoundStage1WorkbookFilename,
    writeCaseBoundStage1Workbook
} from "../server/caseBoundStage1Workbook.js";

function inspection() {
    return buildCaseInspection({
        caseNumber: "P00171-S01",
        sourceSnapshot: {
            source_json: {
                analyticalTranscript: [{
                    turn_id: "T001",
                    message_id: "m1",
                    speaker: "participant",
                    language: "zh",
                    original_text: "昨晚睡得不好，凌晨醒了。",
                    english_text: "I slept poorly last night and woke before dawn."
                }]
            }
        },
        storedMessages: [],
        presentation: {
            meaning_units: [
                { id: "MU001", sources: [{ message_id: "m1", english_text: "昨晚睡得不好" }] },
                { id: "MU002", sources: [{ message_id: "m1", english_text: "凌晨醒了" }] }
            ],
            preliminary_codes: [{
                id: "CO001", label: "Interrupted sleep",
                meaning_unit_ids: ["MU001", "MU002"]
            }],
            preliminary_categories: [{
                id: "CA001", label: "Sleep disruption",
                code_ids: ["CO001"]
            }],
            preliminary_tentative_themes: [{
                id: "TH001", statement: "Fragmented sleep",
                category_ids: ["CA001"]
            }]
        },
        attempt: {
            attempt_number: 1,
            provider_status: "incomplete"
        },
        submittedReport: {
            provider: "openai",
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
            provider_status: "incomplete",
            source_kind: "frozen_gpt56_response_projection",
            report_sha256: "a".repeat(64),
            source_response_sha256: "b".repeat(64)
        }
    });
}

function data() {
    return {
        selection: { type: "cohort", id: "cohort-1" },
        project: { project_name: "Sleep study" },
        cohort: { name: "Pilot cohort" },
        cases: [{
            caseNumber: "P00171-S01",
            stage1Status: "completed",
            language: "zh",
            demographics: { age: 42 },
            inspection: inspection()
        }, {
            caseNumber: "P00175-S01",
            stage1Status: "completed",
            language: "zh",
            demographics: { age: 39 },
            inspection: inspection()
        }]
    };
}

async function workbookBuffer(reportData = data()) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeCaseBoundStage1Workbook(
        stream,
        reportData,
        new Date("2026-09-13T00:00:00.000Z")
    );
    await completed;
    return Buffer.concat(chunks);
}

function columnFor(sheet, header) {
    return sheet.getRow(1).values.slice(1).indexOf(header) + 1;
}

test("the authoritative Stage 1 report is one cohort workbook containing every case", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer());

    assert.deepEqual(
        workbook.worksheets.map(sheet => sheet.name),
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS
    );
    assert.match(workbook.description, /Excel workbook is the Stage 1 report/);
    const participants = workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[0]);
    assert.equal(participants.getCell("A2").value, "P00171");
    assert.equal(participants.getCell("A3").value, "P00175");
    assert.equal(participants.rowCount, 3);
    assert.equal(participants.getCell("B2").value, 1);
    assert.equal(participants.getCell("C2").value, "zh");
    assert.equal(participants.getRow(2).getCell(
        columnFor(participants, "Age")).value, 42);
    assert.ok(columnFor(participants, "Country of residence") > 0);
    assert.ok(columnFor(participants, "Occupation") > 0);
    assert.equal(columnFor(participants, "MU1"), 0);

    const meaningUnits = workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[1]);
    assert.equal(
        meaningUnits.getRow(2).getCell(
            columnFor(meaningUnits, "MU1")).value.text,
        "I slept poorly last night and woke before dawn."
    );

    const codes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[2]);
    assert.equal(codes.getCell("C1").value, "CO1");
    assert.equal(
        codes.getCell("C2").value.text,
        "Interrupted sleep\n2 MU mentions"
    );
    assert.match(codes.getCell("C2").value.hyperlink, /6 Notes & Sources/);

    const categories = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[3]);
    assert.equal(categories.getCell("C2").value.text,
        "Sleep disruption\n2 MU mentions");
    const themes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[4]);
    assert.equal(themes.getCell("C2").value.text,
        "Fragmented sleep\n2 MU mentions");

    const notes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5]);
    const rows = [];
    notes.eachRow((row, number) => {
        if (number > 1) rows.push(row.values.slice(1));
    });
    const code = rows.find(row => row[2] === "Preliminary Code");
    assert.equal(code[3], "CO001");
    assert.equal(code[5], 2);
    assert.equal(code[6], "MU001, MU002");
    const mu = rows.find(row => row[2] === "Meaning Unit");
    assert.match(mu[4], /I slept poorly last night/);
    assert.match(mu[9], /昨晚睡得不好/u);
    assert.match(rows.flat().join("\n"), /gpt-5\.6-sol/);
    assert.doesNotMatch(rows.flat().join("\n"), /gpt-5\.1/);
    assert.equal(caseBoundStage1WorkbookFilename(data()),
        "pilot-cohort-stage1-report-v7-six-sheets.xlsx");
});

test("the pilot workbook uses corrected GPT-5.1 demographics without importing GPT-5.1 analysis", async () => {
    const reportData = data();
    reportData.participantInformationProvenance = {
        sourceModel: "gpt-5.1",
        sourceFilename: "5.1-complete-case-analysis-2026-08-31.xlsx",
        sourceSheetName: "1 Cases & meaning units",
        sourceRange: "A:O",
        sourceWorkbookSha256: "28505922345d9d535fb3eff193e528a0077547a846b9d848d5d51452ba157871",
        sourceScope: "participant_information_only",
        sourceRows: 272,
        cohortRows: 275,
        missingSourceRows: 3,
        populatedDemographicRows: 270,
        analyticalContentImported: false,
        priorAnalyticalProcessInherited: false
    };
    reportData.cases[0].participantCode = "P0171";
    reportData.cases[0].sessionNumber = 1;
    reportData.cases[0].demographics = {
        current_country: "Belgium",
        current_region: "Ghent area",
        country_of_origin: "Belgium",
        diaspora_status: "Non-diaspora (lives in country of birth)",
        occupation: "Logistics coordination / dispatching in fruit and vegetable wholesale"
    };
    reportData.cases[1].participantCode = "P0175";
    reportData.cases[1].sessionNumber = 1;
    reportData.cases[1].demographics = {
        current_country: "China",
        country_of_origin: "China",
        diaspora_status: "non-diaspora (lives in country of origin)",
        age: 52,
        occupation: "part-time bookkeeper for several small businesses"
    };

    const generated = await workbookBuffer(reportData);
    const packageZip = await JSZip.loadAsync(generated);
    assert.equal(packageZip.file("xl/tables/table1.xml"), null);
    assert.doesNotMatch(
        await packageZip.file("xl/worksheets/sheet1.xml").async("text"),
        /<autoFilter/u
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(generated);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
        "1 Participant & case",
        ...CASE_BOUND_STAGE1_WORKBOOK_SHEETS.slice(1)
    ]);
    assert.equal(workbook.views[0].firstSheet, 0);
    assert.equal(workbook.views[0].activeTab, 0);
    assert.equal(workbook.worksheets[0].state, "visible");
    assert.equal(workbook.worksheets[1].state, "visible");
    assert.match(workbook.description, /demographic columns A:O from the actual saved GPT-5\.1 complete-case report/);
    assert.match(workbook.description, /No GPT-5\.1 analytical worksheet or analytical process is included/);

    const participants = workbook.getWorksheet("1 Participant & case");
    assert.deepEqual(participants.getRow(1).values.slice(1), [
        "P#", "S#", "Language", "Country of residence",
        "Region of residence", "Country of origin", "Diaspora status",
        "Gender", "Age", "Year of birth", "Birth cohort", "Youth status",
        "Occupation", "Education", "Social identity"
    ]);
    assert.equal(participants.rowCount, 3);
    assert.equal(participants.columnCount, 15);
    assert.equal(participants.getCell("A2").value, "P0171");
    assert.equal(participants.getCell("D2").value, "Belgium");
    assert.equal(participants.getCell("E2").value, "Ghent area");
    assert.match(participants.getCell("M2").value, /Logistics coordination/);
    assert.equal(participants.getCell("A3").value, "P0175");
    assert.equal(participants.getCell("D3").value, "China");
    assert.equal(participants.getCell("I3").value, 52);
    assert.match(participants.getCell("M3").value, /part-time bookkeeper/);
    assert.deepEqual(Object.keys(participants.tables), []);
    assert.equal(participants.autoFilter, undefined);

    const notes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5]);
    const text = notes.getRows(2, notes.rowCount - 1)
        .flatMap(row => row.values.slice(1)).join("\n");
    assert.match(text, /Model\/source: gpt-5\.1/);
    assert.match(text, /Workbook: 5\.1-complete-case-analysis-2026-08-31\.xlsx/);
    assert.match(text, /Worksheet: 1 Cases & meaning units/);
    assert.match(text, /Imported range: A:O/);
    assert.match(text, /272 source rows copied; 3 cohort cases absent/);
    assert.match(text, /GPT-5\.1 analytical content imported: no/);
    assert.match(text, /GPT-5\.1 analytical process inherited: no/);
    assert.match(text, /gpt-5\.6-sol/);
    assert.equal(caseBoundStage1WorkbookFilename(reportData),
        "pilot-cohort-stage1-report-v7-corrected-gpt51-demographics-gpt56-analysis.xlsx");
});

test("the case-bound page makes the workbook primary and the annotated transcript supporting evidence", async () => {
    const [dashboard, client, html, contract] = await Promise.all([
        readFile(new URL("../server/caseBoundAnalysisDashboard.js", import.meta.url), "utf8"),
        readFile(new URL("../researcher-case-bound-analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8"),
        readFile(new URL("../server/caseBoundAnalysisContract.js", import.meta.url), "utf8")
    ]);
    assert.match(dashboard, /download === "stage1-report-xlsx"/);
    assert.match(dashboard, /writeCaseBoundStage1Workbook/);
    assert.match(client, /Download one complete Stage 1 workbook/);
    assert.doesNotMatch(client, /caseId=.*stage1-report-xlsx/);
    assert.match(client, /View supporting annotated transcript/);
    assert.match(html, /all cases are presented together in one Excel workbook report/);
    assert.match(html, /demographic columns A:O from the actual saved GPT-5\.1 complete-case report/);
    assert.match(html, /annotated transcripts are supporting evidence, not substitutes/);
    assert.match(contract, /one deterministic Excel workbook containing every case/);
    assert.match(contract, /Participant Information and Meaning Units on separate worksheets/);
    assert.match(contract, /Separate per-case workbooks are not Stage 1 reports/);
});

test("all 275 cohort cases stream into one Stage 1 workbook", async () => {
    const reportData = data();
    reportData.cases = Array.from({ length: 275 }, (_, index) => ({
        caseNumber: `P${String(index + 1).padStart(5, "0")}-S01`,
        stage1Status: "completed",
        language: "zh",
        demographics: { age: 40 },
        inspection: inspection()
    }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(reportData));
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[0]).rowCount, 276);
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[1]).rowCount, 276);
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[2]).rowCount, 276);
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[3]).rowCount, 276);
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[4]).rowCount, 276);
    assert.equal(workbook.getWorksheet(
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5]).rowCount, 1 + (275 * 6));
});
