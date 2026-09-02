import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import {
    SHEET_NAMES,
    stage1PreliminaryFormsFilename,
    writeStage1PreliminaryFormsWorkbook
} from "../server/stage1PreliminaryForms.js";

function sampleData() {
    return {
        materialization: {
            source_case_count: 2,
            participant_form_case_count: 2,
            meaning_unit_form_case_count: 1,
            code_form_case_count: 1,
            category_form_case_count: 1,
            implied_theme_form_case_count: 1,
            exception_case_count: 1,
            new_ai_api_call_count: 0
        },
        project: {
            project_code: "FUTURE-PROJECT",
            project_name: "Future project"
        },
        cases: [{
            source_job_id: "job-1",
            participant_code: "P001",
            case_number: "P001-S01",
            session_sequence: 1,
            language: "zh",
            demographics: {
                current_country: "Canada",
                project_specific_identity: "Identity A"
            }
        }, {
            source_job_id: "job-2",
            participant_code: "P002",
            case_number: "P002-S01",
            session_sequence: 1,
            language: "en",
            demographics: {
                current_country: "United Kingdom",
                custom_future_field: "Future value"
            }
        }],
        meaningUnits: [{
            source_job_id: "job-1",
            case_number: "P001-S01",
            position: 1,
            english_text: "I go to bed at one in the morning.",
            english_text_source: "stored_message_translation"
        }],
        codes: [{
            source_job_id: "job-1",
            case_number: "P001-S01",
            position: 1,
            code_label: "Late bedtime"
        }],
        categories: [{
            source_job_id: "job-1",
            case_number: "P001-S01",
            position: 1,
            category_label: "Sleep timing"
        }],
        themes: [{
            source_job_id: "job-1",
            case_number: "P001-S01",
            position: 1,
            theme_label: "Disrupted routines"
        }],
        exceptions: [{ source_job_id: "job-2" }]
    };
}

async function workbookBuffer(data) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeStage1PreliminaryFormsWorkbook(
        stream,
        data,
        new Date("2026-09-02T20:00:00.000Z")
    );
    await completed;
    return Buffer.concat(chunks);
}

test("Stage 1 workbook uses dynamic demographics and English MU display values", async () => {
    const data = sampleData();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(data));

    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), SHEET_NAMES);
    const participants = workbook.getWorksheet(SHEET_NAMES[0]);
    const headers = participants.getRow(1).values.slice(1);
    assert.deepEqual(headers, [
        "P#", "S#", "Language", "Current Country",
        "Custom Future Field", "Project Specific Identity"
    ]);
    assert.equal(participants.rowCount, 3);
    assert.equal(participants.getCell("F2").value, "Identity A");
    assert.equal(participants.getCell("E3").value, "Future value");

    const meaningUnits = workbook.getWorksheet(SHEET_NAMES[1]);
    assert.equal(meaningUnits.rowCount, 3);
    assert.equal(meaningUnits.getCell("B2").value,
        "I go to bed at one in the morning.");
    assert.equal(meaningUnits.getCell("B3").value, null);
    assert.doesNotMatch(JSON.stringify(meaningUnits.getCell("B2").value), /凌晨/u);

    assert.equal(workbook.getWorksheet(SHEET_NAMES[2]).getCell("B2").value,
        "Late bedtime");
    assert.equal(workbook.getWorksheet(SHEET_NAMES[3]).getCell("B2").value,
        "Sleep timing");
    assert.equal(workbook.getWorksheet(SHEET_NAMES[4]).getCell("B2").value,
        "Disrupted routines");
    assert.equal(stage1PreliminaryFormsFilename(data),
        "future-project-stage1-preliminary-analysis-forms.xlsx");
});

test("Stage 1 forms are exposed as a reusable authenticated dashboard download", async () => {
    const [migration, dashboard, client, html] = await Promise.all([
        readFile(new URL(
            "../supabase/migrations/20260902203500_make_stage1_forms_project_agnostic.sql",
            import.meta.url
        ), "utf8"),
        readFile(new URL("../server/advancedPreliminaryDashboard.js", import.meta.url), "utf8"),
        readFile(new URL("../researcher-advanced-preliminary.js", import.meta.url), "utf8"),
        readFile(new URL("../staged-analysis.html", import.meta.url), "utf8")
    ]);

    assert.match(migration, /public\.materialize_stage1_preliminary_forms/u);
    assert.match(migration, /to_jsonb\(descriptor\)/u);
    assert.match(migration, /descriptor\.additional_descriptors/u);
    assert.match(migration, /count\(distinct job\.project_id\)/u);
    assert.doesNotMatch(migration, /275|9cba2707|32490785|SLEEPING-HABITS/u);
    assert.doesNotMatch(migration,
        /createAnalysisProviderClient|responses\.create|chat\.completions/u);
    assert.match(dashboard, /download === "stage1-forms-xlsx"/u);
    assert.match(client, /download=stage1-forms-xlsx/u);
    assert.match(html, /advancedPreliminaryFormsDownloadButton/u);
});
