function control({
    id,
    title,
    introduced,
    effect,
    source,
    modelAssociation,
    currentStatus,
    classification = "system-derived repository control",
    authorization = "No explicit researcher authorization record was found in the repository. A Git author identity or commit title is not evidence of informed approval."
}) {
    return {
        id,
        title,
        introduced,
        effect,
        source,
        modelAssociation,
        currentStatus,
        classification,
        authorization,
        repositoryAttribution: "The commit is recorded under the configured Git author identity shown in repository history. This inventory does not attribute the design decision to that person without a separate authorization record."
    };
}

export const RECENT_PLATFORM_CONTROL_INVENTORY_VERSION =
    "recent-platform-controls-2026-09-02-v2";

// Disclosure register only: none of these entries execute policy.
export const RECENT_PLATFORM_CONTROLS = [
    control({
        id: "RECENT-001",
        title: "Semantic-label and transcript-first audit controls",
        introduced: "2026-08-31 10:05 EDT · commit 6582980",
        effect: "Added semantic-label checks, transcript-first review behavior, and analysis audit output to the pre-Stage-1 automatic-analysis path.",
        source: "server/analysisCore.js; server/analysisFramework.js; server/automaticCaseAnalysis.js; researcher automatic-analysis and review pages",
        modelAssociation: "Legacy/pre-Stage-1 automatic-analysis and reanalysis models.",
        currentStatus: "Historical and legacy-path control; not part of the current no-validator Stage-1 generator."
    }),
    control({
        id: "RECENT-002",
        title: "Multi-Code Theme minimum",
        introduced: "2026-08-31 10:47 EDT · commit 679fbea",
        effect: "Required narrative Themes to be supported by multiple Codes and added database audit provenance for that rule.",
        source: "server/analysisCore.js; supabase/migrations/20260831143424_theme_hierarchy_audit_provenance.sql",
        modelAssociation: "Legacy/pre-Stage-1 automatic-analysis and reanalysis models.",
        currentStatus: "Historical and legacy-path analytical restriction; not a current Stage-1 validator."
    }),
    control({
        id: "RECENT-003",
        title: "Meaning Unit → Code → Category hierarchy and autonomous feedback",
        introduced: "2026-08-31 14:58 EDT · commit 70df156",
        effect: "Inserted a prescribed qualitative hierarchy, automatic audits, and feedback/repair behavior across analysis, review, and export paths.",
        source: "server/analysisCore.js; server/analysisFramework.js; supabase/migrations/20260831185820_meaning_units_categories_autonomous_feedback.sql",
        modelAssociation: "Legacy/pre-Stage-1 automatic-analysis and reanalysis models.",
        currentStatus: "The hierarchy remains a display/data design where referenced; autonomous analytical acceptance is not authorized for current Stage 1."
    }),
    control({
        id: "RECENT-004",
        title: "Serial project-reanalysis claim gate",
        introduced: "2026-08-31 15:57 EDT · commit 4d2442f",
        effect: "Limited project reanalysis claims to serial execution.",
        source: "supabase/migrations/20260831192030_enforce_serial_framework_reanalysis.sql",
        modelAssociation: "Model-independent workflow control for project reanalysis.",
        currentStatus: "Potentially active database workflow control; it regulates work scheduling, not participant legitimacy."
    }),
    control({
        id: "RECENT-005",
        title: "Complete-hierarchy, one-parent, and repair/retry rules",
        introduced: "2026-08-31 16:20–18:27 EDT · commits 66df9f7, b4f17a1, edc16f2, e8c74c2, 617813a, and 10cc8dc",
        effect: "Added complete-hierarchy requirements, temporarily enforced one-parent relationships, performed repair attempts, checked concise Code output, and carried audit failures into retries.",
        source: "server/analysisCore.js; server/frameworkReanalysis.js",
        modelAssociation: "Legacy/pre-Stage-1 automatic-analysis and reanalysis models.",
        currentStatus: "Cumulative historical controls; some were later relaxed or made advisory. They require separate review before any continued legacy-path use."
    }),
    control({
        id: "RECENT-006",
        title: "Stronger-model preliminary-analysis pipeline",
        introduced: "2026-08-31 19:56 EDT · commit 97ec3a5",
        effect: "Created the Stage-1 pipeline, strict response schema, local Meaning Unit checks, count/link requirements, database constraints, job states, and report-completion function.",
        source: "server/advancedPreliminaryAnalysis.js; server/advancedPreliminaryDashboard.js; supabase/migrations/20260831235500_add_advanced_preliminary_analysis.sql",
        modelAssociation: "Introduced for the stronger-model preliminary generator; later used with the exact model configured for a run, including GPT-5.6 runs.",
        currentStatus: "Analytical validator withdrawn by GOV-PART-002. Exact output preservation and non-rejecting relational projection replace it."
    }),
    control({
        id: "RECENT-007",
        title: "Full-transcript-coverage instruction and coverage review",
        introduced: "2026-08-31 21:49 EDT · commit cd07e30; changed 2026-09-01 by commit 7b24b18",
        effect: "Told the model to cover the full transcript and initially treated coverage gaps as an enforcement concern; later retained gaps for review.",
        source: "server/advancedPreliminaryAnalysis.js; researcher-advanced-preliminary.js",
        modelAssociation: "Stage-1 generator prompt.",
        currentStatus: "Prompt guidance only. It cannot reject a participant, transcript, report, or model object."
    }),
    control({
        id: "RECENT-008",
        title: "Discard-invalid-output and clean-requeue mechanism",
        introduced: "2026-08-31 22:43 EDT · commits 80f836b and 0756a6d",
        effect: "Deleted or reset outputs classified as invalid and requeued work for a clean run.",
        source: "server/advancedPreliminaryAnalysis.js; server/analysisCore.js; supabase/migrations/20260901022929_discard_invalid_analysis_outputs.sql",
        modelAssociation: "Stage 1 and legacy automatic-analysis outputs affected by the reset migration.",
        currentStatus: "Prohibited for current Stage 1. Completed provider output is preserved before projection; historical audit records remain."
    }),
    control({
        id: "RECENT-009",
        title: "Non-overlapping Meaning Unit segmentation",
        introduced: "2026-08-31 23:32 EDT · commit 6239f8a",
        effect: "Rejected overlapping Meaning Unit spans and staged analysis around Meaning Units.",
        source: "server/advancedPreliminaryAnalysis.js; supabase/migrations/20260901013000_stage1_meaning_units_only.sql",
        modelAssociation: "Stage-1 generator output.",
        currentStatus: "Withdrawn. Overlap cannot reject an object or report; it may only affect optional relational display projection."
    }),
    control({
        id: "RECENT-010",
        title: "Legacy unusable case disposition",
        introduced: "2026-09-01 00:40–00:50 EDT · commits 560beb9 and 9d2af74",
        effect: "Allowed completed participant cases to be labelled legacy_unusable and then added automatic disposition for content classified as unusable.",
        source: "server/advancedPreliminaryDashboard.js; server/advancedPreliminaryAnalysis.js; supabase/migrations/20260901061000_add_advanced_case_dispositions.sql; supabase/migrations/20260901064000_automate_legacy_source_disposition.sql",
        modelAssociation: "Model-independent administrative/database mechanism around Stage 1.",
        currentStatus: "Withdrawn and prohibited by GOV-PART-001. Current UI/API action is removed; the superseding migration restores inclusion while preserving history."
    }),
    control({
        id: "RECENT-011",
        title: "One-pass complete case-report schema and analytical minima",
        introduced: "2026-09-01 08:22 EDT · commit 10f99d6",
        effect: "Required a single response containing Meaning Units, Codes, Categories, Themes, links, and summary, with whole-report failure when stated minima or links did not pass.",
        source: "server/advancedPreliminaryAnalysis.js; supabase/migrations/20260901122121_complete_preliminary_case_reports.sql",
        modelAssociation: "Stage-1 generator model configured for a run.",
        currentStatus: "Analytical schema and rejection minima withdrawn by GOV-PART-002. Arrays and links are now optional non-rejecting projections of preserved raw output."
    }),
    control({
        id: "RECENT-012",
        title: "Single active run, preflight hash, and exact-model probe",
        introduced: "2026-09-01 11:50 EDT · commit 4ce0761",
        effect: "Allowed only one active Stage-1 run, required the displayed execution-plan hash at start, and tested the exact configured model before running.",
        source: "server/advancedPreliminaryDashboard.js; server/advancedPreliminaryAnalysis.js; supabase/migrations/20260901160500_restore_researcher_execution_contract.sql",
        modelAssociation: "The capability probe targets the exact selected Stage-1 model; other gates are model-independent.",
        currentStatus: "Active operational safeguards, disclosed for researcher review. They do not decide participant or transcript legitimacy."
    }),
    control({
        id: "RECENT-013",
        title: "Spending limit and model-call reservation",
        introduced: "2026-09-01 18:05 EDT · commit 5ead957; extended by commits 560b392 and a42befd",
        effect: "Stops new model calls at a configured spending ceiling and counts uncertain provider usage conservatively.",
        source: "supabase/migrations/20260901194500_resume_stage1_with_spending_guard.sql; supabase/migrations/20260901223500_make_stage1_responses_durable.sql; supabase/migrations/20260901225000_include_uncertain_usage_in_run_spend.sql",
        modelAssociation: "Applies to paid Stage-1 model calls regardless of selected model.",
        currentStatus: "Active operational/cost control. A stopped call must remain a visible system state and cannot exclude a participant."
    }),
    control({
        id: "RECENT-014",
        title: "Durable polling, stale-response cancellation, and bounded retry",
        introduced: "2026-09-01 18:25–20:42 EDT · commits 560b392, cef65c6, and fba2f31",
        effect: "Persists provider response IDs, schedules polling, cancels stale responses after a fixed interval, and limits recovery attempts.",
        source: "server/advancedPreliminaryAnalysis.js; api/automatic-analysis.js; supabase/migrations/20260901223500_make_stage1_responses_durable.sql; supabase/migrations/20260901224500_schedule_durable_stage1_ticks.sql; supabase/migrations/20260902004107_handle_stale_stage1_responses.sql",
        modelAssociation: "Stage-1 provider/model recorded for each run.",
        currentStatus: "Active system-recovery control. Exhaustion is a visible technical failure requiring expert resolution, never participant exclusion."
    }),
    control({
        id: "RECENT-015",
        title: "Participant non-exclusion and no-validator directives",
        introduced: "2026-09-01 · explicit researcher directives GOV-PART-001 and GOV-PART-002",
        effect: "Prohibits participant/transcript exclusion and prohibits analytical validation of Stage-1 model output; assigns all computational failures to the system.",
        source: "research-governance.html; supabase/migrations/20260902013000_prohibit_participant_transcript_exclusion.sql; supabase/migrations/20260902020000_withdraw_stage1_validator.sql",
        modelAssociation: "Model-independent and applies to every current or future Stage-1 model.",
        currentStatus: "Current top-level researcher governance.",
        classification: "explicit researcher directive",
        authorization: "Explicitly directed by the researcher in this task on 2026-09-01."
    }),
    control({
        id: "RECENT-016",
        title: "Stage-1 execution concurrency",
        introduced: "2026-09-01 · commit d332975; conceptual boundary corrected 2026-09-02",
        effect: "Originally replaced an unauthorized serial worker with a hard-coded concurrency of eight. The corrected design removes that fallback ceiling: case-by-case analytical independence remains mandatory, while technical capacity follows the active workload unless an explicit server override is configured.",
        source: "server/advancedPreliminaryAnalysis.js; api/automatic-analysis.js; server/stage1ValidationRulesDashboard.js; supabase/migrations/20260902040232_configure_stage1_worker_concurrency.sql",
        modelAssociation: "Model-independent execution configuration; it does not change the selected Stage-1 model, prompt, evidence, or report.",
        currentStatus: "Active technical configuration with no system-derived fixed default. The current capacity and its source are shown on the researcher validation page. No concurrency value has analytical or participant-eligibility meaning.",
        authorization: "The researcher required the analysis to finish, rejected serial execution, and on 2026-09-02 explicitly required removal of the system-derived fixed value of eight."
    }),
    control({
        id: "RECENT-017",
        title: "Remove relational projection as a Stage-1 report gate",
        introduced: "2026-09-02 · explicit researcher directive",
        effect: "Makes the preserved case report authoritative and changes MU/CO/CA/TH relational storage into a best-effort display projection. A cast, link, numbering, or child-table constraint failure becomes a system-owned note and cannot reject the report.",
        source: "supabase/migrations/20260902140632_make_stage1_projection_non_blocking.sql; server/advancedPreliminaryAnalysis.js",
        modelAssociation: "Model-independent; applies to every current or future Stage-1 generator.",
        currentStatus: "Current top-level researcher governance. No analytical or structural output gate may block a completed Stage-1 provider response.",
        classification: "explicit researcher directive",
        authorization: "Explicitly directed by the researcher in this task on 2026-09-02."
    })
];
