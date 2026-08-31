import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import {
    automaticReviewThreadTitle,
    normalizeAutomaticReviewSelection,
    parseAutomaticReviewWorkbook
} from "../server/automaticAnalysisReview.js";

const htmlUrl = new URL("../researcher.html", import.meta.url);
const clientUrl = new URL(
    "../researcher-automatic-review.js",
    import.meta.url
);
const legacyClientUrl = new URL(
    "../researcher-automatic-analysis-legacy.js",
    import.meta.url
);
const migrationUrl = new URL(
    "../supabase/migrations/20260831033507_add_automatic_analysis_review_workspace.sql",
    import.meta.url
);
const reanalysisMigrationUrl = new URL(
    "../supabase/migrations/20260831042540_researcher_case_reanalysis.sql",
    import.meta.url
);
const autonomousFeedbackMigrationUrl = new URL(
    "../supabase/migrations/20260831173903_add_meaning_units_categories_autonomous_feedback.sql",
    import.meta.url
);

test("researcher workbook import preserves row order and hidden structure", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("3 Themes");
    worksheet.addRow(["P#", "S#", "T1", "T1 researcher group"]);
    worksheet.addRow(["P0107", 1, "Work", "Work patterns"]);
    worksheet.addRow(["P0108", 2, "Media", "Information sources"]);
    worksheet.getColumn(2).hidden = true;
    worksheet.getRow(3).hidden = true;

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseAutomaticReviewWorkbook(buffer);

    assert.equal(parsed.sheetManifest[0].name, "3 Themes");
    assert.deepEqual(parsed.sheetManifest[0].hiddenColumns, [{
        index: 2,
        column: "B",
        header: "S#"
    }]);
    assert.equal(parsed.sheetManifest[0].hiddenRowCount, 1);
    assert.deepEqual(parsed.caseIndex.P0107[0], {
        sheetName: "3 Themes",
        rowNumber: 2,
        rowHidden: false,
        session: "1",
        values: {
            "P#": "P0107",
            "S#": "1",
            T1: "Work",
            "T1 researcher group": "Work patterns"
        }
    });
    assert.equal(parsed.caseIndex.P0108[0].rowHidden, true);
});

test("AI discussion selections retain participant-local THn CAn and COn provenance", () => {
    const selection = normalizeAutomaticReviewSelection([
        {
            kind: "theme",
            sessionId: "session-107",
            caseNumber: "P0107-S01",
            participantCode: "P0107",
            position: "th1",
            recordId: "theme-1",
            label: "Work"
        },
        {
            kind: "theme",
            sessionId: "session-107",
            caseNumber: "P0107-S01",
            participantCode: "P0107",
            position: "TH1",
            recordId: "duplicate",
            label: "Must be removed"
        },
        {
            kind: "code",
            sessionId: "session-108",
            caseNumber: "P0108-S01",
            participantCode: "P0108",
            position: "CO2",
            label: "Media"
        },
        {
            kind: "category",
            sessionId: "session-108",
            caseNumber: "P0108-S01",
            participantCode: "P0108",
            position: "CA1",
            label: "Bedtime media use"
        }
    ]);

    assert.equal(selection.length, 3);
    assert.equal(selection[0].position, "TH1");
    assert.equal(selection[0].recordId, "theme-1");
    assert.equal(selection[1].position, "CO2");
    assert.equal(selection[2].position, "CA1");
    assert.equal(
        automaticReviewThreadTitle(selection),
        "P0107-S01 TH1 · Work"
    );
});

test("visible automatic-analysis workspace restores discussion and upload controls", async () => {
    const [html, client, legacyClient, migration] = await Promise.all([
        readFile(htmlUrl, "utf8"),
        readFile(clientUrl, "utf8"),
        readFile(legacyClientUrl, "utf8"),
        readFile(migrationUrl, "utf8")
    ]);
    const panelIndex = html.indexOf('id="automaticAnalysisReview"');
    const legacyIndex = html.indexOf('id="legacyAnalysisSection"');

    assert.ok(panelIndex > 0);
    assert.ok(legacyIndex > panelIndex);
    assert.match(html, /id="automaticReviewUploadButton"/);
    assert.match(html, /id="automaticReviewDiscussionForm"/);
    assert.match(html, /id="automaticReviewSelectionSummary"/);
    assert.match(html, /id="automaticReviewDiscussionStatus"/);
    assert.doesNotMatch(
        html.slice(panelIndex, html.indexOf(">", panelIndex)),
        /\shidden(?:\s|>)/
    );
    assert.match(legacyClient, /"AI discussion"/);
    assert.match(legacyClient, /automatic-analysis-review-source/);
    assert.match(client, /action: "upload_workbook"/);
    assert.match(client, /action: "discuss"/);
    assert.match(client, /function immutableSelectionSnapshot/);
    assert.match(
        client,
        /const submittedSelection = immutableSelectionSnapshot\(\);[\s\S]*selection: submittedSelection/
    );
    assert.match(
        client,
        /Processing exact analytical scope: \$\{submittedContext\}/
    );
    assert.match(
        client,
        /Exact analytical scope: \$\{sourceContextText\(sources\)\}/
    );
    assert.match(client, /line\.dataset\.sourceContext = sourceContextText\(sources\)/);
    assert.match(client, /Re-analysis request \$\{request\.request_number\}/);
    assert.match(migration, /enable row level security/g);
    assert.match(migration, /selected_sources jsonb not null/);
    assert.match(migration, /file_sha256 text not null/);
});

test("researcher feedback creates a completed version without an approval gate", async () => {
    const [html, client, api, processor, migration] = await Promise.all([
        readFile(htmlUrl, "utf8"),
        readFile(clientUrl, "utf8"),
        readFile(
            new URL("../api/automatic-analysis-review.js", import.meta.url),
            "utf8"
        ),
        readFile(
            new URL("../server/frameworkReanalysis.js", import.meta.url),
            "utf8"
        ),
        readFile(autonomousFeedbackMigrationUrl, "utf8")
    ]);

    assert.match(html, /Request re-analysis for this case/);
    assert.match(html, /id="automaticReanalysisNotes"/);
    assert.match(client, /action: "request_case_reanalysis"/);
    assert.doesNotMatch(client, /action: "review_case_reanalysis"/);
    assert.match(client, /Historical interview-protocol issue/);
    assert.match(api, /processCaseReanalysisRequest/);
    assert.match(processor, /generateAutomaticCaseReanalysis/);
    assert.match(processor, /detectCompoundQuestionTurns/);
    assert.match(processor, /complete_automatic_case_reanalysis/);
    assert.match(migration, /status = 'completed'/);
    assert.match(migration, /analysis_completed_at/);
    assert.match(migration, /feedbackStartsNewVersion/);
    assert.doesNotMatch(api, /review_case_reanalysis/);
    assert.match(migration, /enable row level security/g);
    assert.match(migration, /substring\([\s\S]*message\."Message"/);
});
