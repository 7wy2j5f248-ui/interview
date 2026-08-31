import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
    writeProjectReanalysisBatchWorkbook
} from "../server/projectReanalysisBatchExport.js";

const createdAt = new Date("2026-08-31T08:00:00.000Z");

function sampleData() {
    return {
        batch: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            analysis_framework_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            reason_code: "analysis_framework_changed",
            researcher_notes: "Apply direct sleep relevance.",
            status: "completed",
            eligible_case_count: 1,
            queued_case_count: 0,
            processing_case_count: 0,
            proposal_ready_case_count: 1,
            approved_case_count: 0,
            rejected_case_count: 0,
            failed_case_count: 0,
            cancelled_case_count: 0,
            scope_snapshot: { archivedCaseExcludedCount: 3 },
            requested_at: "2026-08-31T07:00:00.000Z",
            completed_at: "2026-08-31T07:59:00.000Z"
        },
        project: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            project_code: "SLEEPING-HABITS",
            project_name: "Sleeping habits",
            research_topic: "Sleeping habits"
        },
        framework: {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            version_number: 2,
            predecessor_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            study_scope: "Sleeping habits.",
            theme_requirements: "Direct sleep subjects.",
            code_derivation_rules: "Exact related keywords.",
            theme_code_fit_rules: "Codes support themes.",
            inclusion_rules: "Include sleep evidence.",
            exclusion_rules: "Exclude unrelated activity.",
            provenance_expectations: "Retain message IDs.",
            application_scope: "include_completed"
        },
        requests: [{
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            session_id: "session-1",
            source_report_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            request_number: 1,
            reason_code: "analysis_framework_changed",
            researcher_notes: "Apply direct sleep relevance.",
            status: "proposal_ready",
            project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            analysis_framework_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            project_reanalysis_batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        }],
        proposals: [{
            id: "11111111-1111-4111-8111-111111111111",
            request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            proposal_version: "case-reanalysis-v2-framework-governed",
            proposed_report: {
                caseInterpretation: "The participant has irregular sleep.",
                themes: [{
                    label: "Sleep routine",
                    rationale: "Directly concerns sleep timing.",
                    codeNumbers: [1]
                }],
                codes: [{
                    label: "Late bedtime",
                    rationale: "Repeated delayed bedtime.",
                    highlights: [{
                        messageId: "message-1",
                        exactText: "go to bed after midnight"
                    }]
                }]
            },
            relevance_audit: {
                overallSummary: "All evidence passed.",
                checks: [{
                    codeNumber: 1,
                    codeLabel: "Late bedtime",
                    themeLabels: ["Sleep routine"],
                    messageId: "message-1",
                    exactText: "go to bed after midnight",
                    transcriptGrounded: true,
                    supportsCode: true,
                    supportsTheme: true,
                    researchScopeRelevant: true,
                    accepted: true,
                    explanation: "Direct sleep-timing evidence."
                }]
            },
            source_quality_flags: [],
            created_at: "2026-08-31T07:59:00.000Z"
        }],
        reviews: [],
        sourceReports: [{
            id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            session_id: "session-1",
            case_number: "P0001-S01",
            participant_code: "P0001",
            case_interpretation: "The participant discusses work and sleep.",
            analysis_version: "automatic-case-analysis-v4",
            superseded_at: null
        }],
        sourceCodes: [{
            id: "code-source",
            report_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            code_number: 1,
            code_label: "Night work",
            rationale: "Work occurs at night."
        }],
        sourceThemes: [{
            id: "theme-source",
            report_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            theme_number: 1,
            theme_label: "Work",
            rationale: "Work activity."
        }],
        sourceHighlights: [{
            id: "highlight-source",
            report_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            code_id: "code-source",
            keyword_number: 1,
            message_id: "message-1",
            exact_text: "go to bed after midnight"
        }],
        sourceThemeCodes: [{
            report_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            theme_id: "theme-source",
            code_id: "code-source"
        }],
        messages: [{
            id: "message-1",
            Language: "en",
            Message: "I usually go to bed after midnight.",
            EnglishTranslation: "I usually go to bed after midnight."
        }]
    };
}

async function workbookBuffer(data) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const completed = finished(stream);
    await writeProjectReanalysisBatchWorkbook(stream, data, createdAt);
    await completed;
    return Buffer.concat(chunks);
}

test("complete batch export separates current and proposed analysis with provenance", async () => {
    const buffer = await workbookBuffer(sampleData());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
        "1 Batch summary",
        "2 Case comparison",
        "3 Current source evidence",
        "4 Revised proposed evidence",
        "5 Relevance & quality audit"
    ]);
    const summary = workbook.getWorksheet("1 Batch summary");
    assert.equal(summary.getCell("B2").value,
        "Complete project-wide revised analysis — proposed output only");
    assert.match(String(summary.getCell("B21").value), /does not approve/);

    const comparison = workbook.getWorksheet("2 Case comparison");
    assert.equal(comparison.getCell("A2").value, "P0001-S01");
    assert.equal(comparison.getCell("G2").value, "Current report preserved");
    assert.match(String(comparison.getCell("N2").value), /irregular sleep/);
    assert.equal(comparison.getCell("Y2").value,
        "Not reviewed — proposal only");

    const proposed = workbook.getWorksheet("4 Revised proposed evidence");
    assert.equal(proposed.getCell("D2").value, "Sleep routine");
    assert.equal(proposed.getCell("G2").value, "Late bedtime");
    assert.equal(proposed.getCell("P2").value,
        "Proposal only — not current");

    const audit = workbook.getWorksheet("5 Relevance & quality audit");
    assert.equal(audit.getCell("M2").value, true);
    assert.match(String(audit.getCell("N2").value), /Direct sleep/);
});

test("complete batch workbook contains no legacy comments or VML", async () => {
    const zip = await JSZip.loadAsync(await workbookBuffer(sampleData()));
    const paths = Object.keys(zip.files);
    assert.deepEqual(paths.filter(path =>
        /^xl\/comments\d+\.xml$/i.test(path)
        || /^xl\/drawings\/vmlDrawing\d+\.vml$/i.test(path)
    ), []);
});

test("project-wide UI makes consolidated inspection independent of approval", async () => {
    const [html, client, endpoint, migration] = await Promise.all([
        readFile(new URL("../researcher.html", import.meta.url), "utf8"),
        readFile(new URL("../researcher-automatic-review.js", import.meta.url), "utf8"),
        readFile(new URL("../api/automatic-analysis-review.js", import.meta.url), "utf8"),
        readFile(new URL("../supabase/migrations/20260831074725_complete_project_reanalysis_for_export.sql", import.meta.url), "utf8")
    ]);
    assert.match(html, /full batch completes without[\s\S]*case-by-case approval/);
    assert.match(client, /Download complete batch review/);
    assert.match(client, /download_project_reanalysis_batch/);
    assert.match(client, /!request\.project_reanalysis_batch_id/);
    assert.match(endpoint, /X-PLI-Report-Effect/);
    assert.match(endpoint, /writeProjectReanalysisBatchWorkbook/);
    assert.match(migration, /Unreviewed proposals do not block batch completion/);
    assert.match(migration, /when failed_count > 0 then 'completed_with_failures'/);
    assert.doesNotMatch(migration, /set status\s*=\s*'approved'/);
});
