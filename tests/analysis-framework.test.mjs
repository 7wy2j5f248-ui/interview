import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    GLOBAL_ANALYSIS_LABEL_STANDARD,
    analysisFrameworkInstruction,
    normalizeAnalysisFramework
} from "../server/analysisFramework.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260831050027_add_versioned_analysis_frameworks.sql",
    import.meta.url
);
const batchMigrationUrl = new URL(
    "../supabase/migrations/20260831052656_add_project_wide_reanalysis_batches.sql",
    import.meta.url
);
const cancellationMigrationUrl = new URL(
    "../supabase/migrations/20260831064607_stop_project_wide_reanalysis.sql",
    import.meta.url
);
const autonomousFeedbackMigrationUrl = new URL(
    "../supabase/migrations/20260831173903_add_meaning_units_categories_autonomous_feedback.sql",
    import.meta.url
);
const globalRulesMigrationUrl = new URL(
    "../supabase/migrations/20260831201500_add_configurable_global_analysis_rules.sql",
    import.meta.url
);
const proposalOnlyMigrationUrl = new URL(
    "../supabase/migrations/20260831192536_create_proposal_only_category_revision.sql",
    import.meta.url
);

const sample = {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    version_number: 2,
    predecessor_id: "33333333-3333-4333-8333-333333333333",
    project_code: "SLEEPING-HABITS",
    project_name: "Sleeping habits",
    research_topic: "Sleeping habits",
    study_scope: "Sleeping habits and explicitly connected contexts.",
    theme_requirements: "One- or two-word sleep subjects.",
    code_derivation_rules: "Related exact keywords support every code.",
    theme_code_fit_rules: "Every code materially supports its theme.",
    inclusion_rules: "Include sleep-relevant evidence.",
    exclusion_rules: "Exclude unrelated activity.",
    provenance_expectations: "Retain message IDs and lineage.",
    application_scope: "include_completed",
    version_notes: "Tightened relevance.",
    created_at: "2026-08-31T05:00:00.000Z"
};

test("analysis framework instructions are project-bound and complete", () => {
    const framework = normalizeAnalysisFramework(sample);
    assert.equal(framework.projectName, "Sleeping habits");
    assert.equal(framework.versionNumber, 2);
    const instruction = analysisFrameworkInstruction(framework);
    assert.match(instruction, /Research project: Sleeping habits/);
    assert.match(instruction, /Research topic: Sleeping habits/);
    assert.match(instruction, /Analysis framework version: 2/);
    assert.match(instruction, /exact keywords/);
    assert.match(instruction, /Do not import assumptions from a different project/);
    assert.match(GLOBAL_ANALYSIS_LABEL_STANDARD, /every project/);
    assert.match(instruction, /cannot be weakened or bypassed/);
    assert.match(instruction, /Project-specific Analysis Framework/);
    assert.match(instruction, /at least two related codes/);
    assert.match(instruction, /patterned meaning/);
    assert.match(instruction, /retain it as unsynthesized/);
});

test("global semantic label standards are audited and repaired before completion", async () => {
    const [core, automaticProcessor, migration, design, dashboard, review] =
        await Promise.all([
            readFile(new URL("../server/analysisCore.js", import.meta.url), "utf8"),
            readFile(new URL("../server/automaticCaseAnalysis.js", import.meta.url), "utf8"),
            readFile(autonomousFeedbackMigrationUrl, "utf8"),
            readFile(new URL("../global-analysis-rules.html", import.meta.url), "utf8"),
            readFile(new URL("../researcher.html", import.meta.url), "utf8"),
            readFile(new URL("../researcher-automatic-review.js", import.meta.url), "utf8")
        ]);

    assert.match(core, /automatic_case_label_quality_audit/);
    assert.match(core, /natural_language/);
    assert.match(core, /coherent_concept/);
    assert.match(core, /comparison_useful/);
    assert.match(core, /has_multiple_children/);
    assert.match(core, /semantic_coverage/);
    assert.match(core, /higher_level_abstraction/);
    assert.match(core, /patterned_meaning/);
    assert.match(core, /unsynthesized_checks/);
    assert.match(core, /Rejected label audit/);
    assert.match(core, /Label-corrected automatic individual case analysis/);
    assert.match(automaticProcessor, /labelQualityAudit/);
    assert.match(migration, /labelQualityCheckCount/);
    assert.match(design, /Global Analysis Rules/);
    assert.match(design, /future analysis only/i);
    assert.match(dashboard, /Analytical abbreviations:/);
    assert.match(review, /Platform-wide semantic label audit/);
    assert.match(review, /cross-case comparison usefulness/);
    assert.match(review, /MU → CO → CA → TH hierarchy provenance/);
    assert.match(review, /no category or theme was forced/);
});

test("researchers can durably stop an older global instruction", async () => {
    const [designHtml, designClient, reviewClient, endpoint, processor, migration] =
        await Promise.all([
            readFile(new URL("../design.html", import.meta.url), "utf8"),
            readFile(new URL("../design.js", import.meta.url), "utf8"),
            readFile(new URL("../researcher-automatic-review.js", import.meta.url), "utf8"),
            readFile(new URL("../api/saveDesign.js", import.meta.url), "utf8"),
            readFile(new URL("../server/frameworkReanalysis.js", import.meta.url), "utf8"),
            readFile(cancellationMigrationUrl, "utf8")
        ]);
    assert.match(designHtml, /Active Project-Wide Re-analysis/);
    assert.match(designHtml, /Stop an older run/);
    assert.match(designClient, /Stop this project-wide run/);
    assert.match(designClient, /action: "cancel_project_wide_reanalysis"/);
    assert.match(reviewClient, /Stop this project-wide run/);
    assert.match(endpoint, /save_analysis_framework_version_with_batch/);
    assert.match(endpoint, /cancelProjectWideReanalysisBatch/);
    assert.match(processor, /cancellation_observed/);
    assert.match(processor, /modelOutputDiscarded: true/);
    assert.match(migration, /cancel_project_wide_reanalysis_batch/);
    assert.match(migration, /status = 'cancelled'/);
    assert.match(migration, /prevent_cancelled_reanalysis_restart/);
    assert.match(migration, /prevent_cancelled_reanalysis_proposal/);
    assert.match(migration, /save_analysis_framework_version_with_batch/);
    assert.match(migration, /currentReportPreserved/);
});

test("dedicated pages separate global, project, and interview rules", async () => {
    const [html, globalHtml, globalScript, projectHtml, projectScript, endpoint] = await Promise.all([
        readFile(new URL("../design.html", import.meta.url), "utf8"),
        readFile(new URL("../global-analysis-rules.html", import.meta.url), "utf8"),
        readFile(new URL("../global-analysis-rules.js", import.meta.url), "utf8"),
        readFile(new URL("../project-analysis-rules.html", import.meta.url), "utf8"),
        readFile(new URL("../project-analysis-rules.js", import.meta.url), "utf8"),
        readFile(new URL("../api/saveDesign.js", import.meta.url), "utf8")
    ]);
    assert.match(html, /independently versioned controls separate/i);
    assert.match(html, /global-analysis-rules\.html/);
    assert.match(html, /project-analysis-rules\.html/);
    assert.match(globalHtml, /Global Analysis Rules/);
    assert.match(globalHtml, /no historical jobs are queued/i);
    assert.match(globalScript, /save_global_analysis_rules/);
    assert.match(globalScript, /pliGlobalAnalysisRulesDraftV1/);
    assert.match(projectHtml, /Project Analysis Rules/);
    assert.match(projectHtml, /nothing is queued/i);
    assert.match(projectScript, /applicationScope: "future_only"/);
    assert.match(projectScript, /save_analysis_framework/);
    assert.match(endpoint, /save_global_analysis_rules_version/);
    assert.match(endpoint, /Saving project rules applies to future analysis only/);
    assert.match(endpoint, /project_id: projectId/);
});

test("global rule lineage is versioned and completed jobs are not requeued", async () => {
    const migration = await readFile(globalRulesMigrationUrl, "utf8");
    assert.match(migration, /create table public\.global_analysis_rules/);
    assert.match(migration, /create table public\.active_global_analysis_rules/);
    assert.match(migration, /global_analysis_rule_id uuid/);
    assert.match(migration, /status = 'completed'/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.doesNotMatch(migration, /status = 'pending'/);
});

test("database preserves project, framework, proposal, and approval lineage", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    assert.match(migration, /create table public\.research_projects/);
    assert.match(migration, /create table public\.analysis_frameworks/);
    assert.match(migration, /predecessor_id uuid/);
    assert.match(migration, /unique \(project_id, version_number\)/);
    assert.match(migration, /analysis_framework_id uuid/);
    assert.match(migration, /design\.project_id = selected_project\.id/);
    assert.match(migration, /job\.archived_at is null/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.match(migration, /'analysis_framework_scope'/);
    assert.match(migration, /currentReportPreserved/);
    assert.match(migration, /researcherApprovalRequired/);
    assert.match(migration, /claim_next_framework_reanalysis/);
    assert.match(migration, /enable row level security/);
    assert.doesNotMatch(
        migration,
        /update public\.qualitative_case_reports[\s\S]*analysis_framework_id = stored_framework_id/
    );
});

test("global framework queue creates one auditable proposal per case", async () => {
    const [worker, processor, migration, reviewUi, dashboard] = await Promise.all([
        readFile(new URL("../api/automatic-analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../server/frameworkReanalysis.js", import.meta.url), "utf8"),
        readFile(autonomousFeedbackMigrationUrl, "utf8"),
        readFile(new URL("../researcher-automatic-review.js", import.meta.url), "utf8"),
        readFile(new URL("../server/caseAnalysisDashboard.js", import.meta.url), "utf8")
    ]);
    assert.match(worker, /processOldestFrameworkReanalysis/);
    assert.match(processor, /generateAutomaticCaseReanalysis/);
    assert.match(processor, /relevance_audit: analysis\.relevanceAudit/);
    assert.match(processor, /source_quality_flags: sourceQualityFlags/);
    assert.match(processor, /status: "proposal_ready"/);
    assert.doesNotMatch(processor, /rpc\("complete_automatic_case_reanalysis"/);
    assert.match(migration, /'researcherApprovalRequired', false/);
    assert.match(reviewUi, /Global project rule/);
    assert.match(reviewUi, /own proposed revision and audit/);
    assert.match(dashboard, /researchProject/);
    assert.match(dashboard, /analysisFramework/);
    assert.match(dashboard, /reportLineage/);
});

test("project-wide re-analysis is previewed, batched, and inspectable without approval", async () => {
    const [html, client, endpoint, migration] = await Promise.all([
        readFile(new URL("../researcher.html", import.meta.url), "utf8"),
        readFile(new URL("../researcher-automatic-review.js", import.meta.url), "utf8"),
        readFile(new URL("../api/automatic-analysis-review.js", import.meta.url), "utf8"),
        readFile(proposalOnlyMigrationUrl, "utf8")
    ]);
    assert.match(html, /Request project-wide re-analysis/);
    assert.match(html, /Preview project-wide scope/);
    assert.match(html, /Confirm and request project-wide re-analysis/);
    assert.match(client, /action: "preview_project_wide_reanalysis"/);
    assert.match(client, /action: "request_project_wide_reanalysis"/);
    assert.match(client, /eligible completed cases/);
    assert.match(client, /Show all \$\{statuses\.length\} individual case statuses/);
    assert.match(endpoint, /preview_project_wide_reanalysis/);
    assert.match(endpoint, /create_project_wide_reanalysis_batch/);
    assert.match(endpoint, /scheduleAutomaticCaseAnalysis/);
    assert.match(migration, /case-reanalysis-v5-meaning-units-categories-proposed/);
    assert.match(migration, /resultsAreProposals/);
    assert.match(migration, /automaticPromotion', false/);
    assert.match(migration, /researcherApprovalRequiredPerCaseToInspect', false/);
    assert.match(migration, /research_project_case_memberships/);
    assert.match(migration, /S1783783759083/);
});
