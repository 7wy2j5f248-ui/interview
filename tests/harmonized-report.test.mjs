import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import {
    assembleHarmonizedReport,
    harmonizedReportFilename,
    HARMONIZED_SHEET_NAMES,
    writeHarmonizedReportWorkbook
} from "../server/harmonizedReport.js";

function sampleData() {
    return assembleHarmonizedReport({
        cohort: { id: "cohort-1", name: "Frozen cohort" },
        project: { project_code: "SLEEP", project_name: "Sleep study" },
        runs: {
            "2a": { id: "run-2a", analysis_layer: "2a", attempt_number: 2 },
            "2b": { id: "run-2b", analysis_layer: "2b", attempt_number: 1 },
            "2c": { id: "run-2c", analysis_layer: "2c", attempt_number: 1 }
        },
        presentations: {
            "2a": {
                harmonized_codes: [{
                    id: "HCO0001",
                    label: "Exact harmonized code",
                    source_codes: ["PC000001", "PC000002", "PC000003"]
                }]
            },
            "2b": {
                harmonized_categories: [{
                    id: "HCA0001",
                    label: "Exact harmonized category",
                    source_categories: ["PCA000001", "PCA000002"]
                }]
            },
            "2c": {
                harmonized_themes: [{
                    id: "HTH0001",
                    statement: "Exact harmonized theme",
                    source_themes: ["PTH000001"]
                }]
            }
        },
        cases: [{
            caseId: "case-1",
            caseNumber: "P00001",
            participantCode: "P001",
            sessionSequence: 1,
            language: "en",
            demographics: { current_country: "Canada" }
        }, {
            caseId: "case-2",
            caseNumber: "P00002",
            participantCode: "P002",
            sessionSequence: 1,
            language: "fr",
            demographics: { current_country: "France" }
        }],
        meaningUnits: [{
            caseId: "case-1", position: 1, englishText: "Exact Meaning Unit"
        }],
        lineages: {
            "2a": [
                { source_ref: "PC000001", case_id: "case-1" },
                { source_ref: "PC000002", case_id: "case-1" },
                { source_ref: "PC000003", case_id: "case-2" }
            ],
            "2b": [
                { source_ref: "PCA000001", case_id: "case-1" },
                { source_ref: "PCA000002", case_id: "case-2" }
            ],
            "2c": [
                { source_ref: "PTH000001", case_id: "case-1" }
            ]
        }
    });
}

async function workbookBuffer(data) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeHarmonizedReportWorkbook(
        stream,
        data,
        new Date("2026-09-04T17:00:00.000Z")
    );
    await completed;
    return Buffer.concat(chunks);
}

test("Harmonized Report combines provider mappings by case and counts source mentions", () => {
    const data = sampleData();
    assert.equal(data.layers["2a"].vocabulary.length, 1);
    assert.equal(data.layers["2a"].totalSourceMentions, 3);
    assert.deepEqual(data.layers["2a"].caseItems.get("case-1"), [{
        id: "HCO0001",
        text: "Exact harmonized code",
        position: 1,
        sourceMentions: 2
    }]);
    assert.equal(data.layers["2a"].caseItems.get("case-2")[0].sourceMentions, 1);
    assert.equal(data.layers["2b"].caseItems.get("case-1")[0].sourceMentions, 1);
    assert.equal(data.layers["2c"].caseItems.get("case-2").length, 0);
    assert.equal(data.newAiApiCallCount, 0);
});

test("Harmonized workbook has five lean forms and preserves exact model text", async () => {
    const data = sampleData();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await workbookBuffer(data));

    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name),
        HARMONIZED_SHEET_NAMES);
    assert.equal(workbook.getWorksheet(HARMONIZED_SHEET_NAMES[1])
        .getCell("B2").value, "Exact Meaning Unit");

    const codes = workbook.getWorksheet(HARMONIZED_SHEET_NAMES[2]);
    assert.deepEqual(codes.getRow(1).values.slice(1), [
        "P#", "HCO1 ID", "HCO1", "HCO1 preliminary CO mentions",
        "Distinct HCOs in case", "Total preliminary CO mentions"
    ]);
    assert.equal(codes.getCell("B2").value, "HCO0001");
    assert.equal(codes.getCell("C2").value, "Exact harmonized code");
    assert.equal(codes.getCell("D2").value, 2);
    assert.equal(codes.getCell("F2").value, 2);
    assert.equal(codes.getCell("D3").value, 1);
    assert.equal(harmonizedReportFilename(data), "sleep-harmonized-report.xlsx");
});

test("case-bound page exposes authenticated Harmonized Report download without analysis calls", async () => {
    const [dashboard, client, html, report] = await Promise.all([
        readFile(new URL("../server/caseBoundAnalysisDashboard.js", import.meta.url), "utf8"),
        readFile(new URL("../researcher-case-bound-analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8"),
        readFile(new URL("../server/harmonizedReport.js", import.meta.url), "utf8")
    ]);
    assert.match(dashboard, /download === "harmonized-report-xlsx"/u);
    assert.match(client, /Download Harmonized Report/u);
    assert.match(html, /replaces preliminary CO\/CA\/TH forms with HCO\/HCA\/HTH forms/u);
    assert.doesNotMatch(report,
        /createAnalysisProviderClient|responses\.create|chat\.completions/u);
});
