import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
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
        "pilot-cohort-stage1-report.xlsx");
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
