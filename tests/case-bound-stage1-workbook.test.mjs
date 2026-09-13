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
        selection: { type: "case", id: "case-1" },
        project: { project_name: "Sleep study" },
        cohort: null,
        cases: [{
            caseNumber: "P00171-S01",
            stage1Status: "completed",
            language: "zh",
            demographics: { age: 42 },
            inspection: inspection()
        }]
    };
}

async function workbookBuffer() {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeCaseBoundStage1Workbook(
        stream,
        data(),
        new Date("2026-09-13T00:00:00.000Z")
    );
    await completed;
    return Buffer.concat(chunks);
}

function columnFor(sheet, header) {
    return sheet.getRow(1).values.slice(1).indexOf(header) + 1;
}

test("the authoritative Stage 1 report is a five-sheet Excel workbook from the frozen selected-model report", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer());

    assert.deepEqual(
        workbook.worksheets.map(sheet => sheet.name),
        CASE_BOUND_STAGE1_WORKBOOK_SHEETS
    );
    assert.match(workbook.description, /Excel workbook is the Stage 1 report/);
    const cases = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[0]);
    assert.equal(cases.getCell("A2").value, "P00171");
    assert.equal(cases.getCell("B2").value, 1);
    assert.equal(cases.getCell("C2").value, "zh");
    assert.equal(cases.getRow(2).getCell(columnFor(cases, "Age")).value, 42);
    assert.equal(
        cases.getRow(2).getCell(columnFor(cases, "MU1")).value.text,
        "I slept poorly last night and woke before dawn."
    );

    const codes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[1]);
    assert.equal(codes.getCell("C1").value, "CO1");
    assert.equal(
        codes.getCell("C2").value.text,
        "Interrupted sleep\n2 MU mentions"
    );
    assert.match(codes.getCell("C2").value.hyperlink, /5 Notes & sources/);

    const categories = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[2]);
    assert.equal(categories.getCell("C2").value.text,
        "Sleep disruption\n2 MU mentions");
    const themes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[3]);
    assert.equal(themes.getCell("C2").value.text,
        "Fragmented sleep\n2 MU mentions");

    const notes = workbook.getWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[4]);
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
        "p00171-stage1-report.xlsx");
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
    assert.match(client, /Download Stage 1 Excel workbook report/);
    assert.match(client, /Download complete Stage 1 Excel workbook report/);
    assert.match(client, /View supporting annotated transcript/);
    assert.match(html, /one complete Excel workbook report/);
    assert.match(html, /annotated transcript is supporting evidence, not a substitute/);
    assert.match(contract, /authoritative researcher-facing Stage 1 report is the deterministic Excel workbook/);
});
