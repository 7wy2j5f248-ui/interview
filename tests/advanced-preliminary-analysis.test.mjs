import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS,
    ADVANCED_PRELIMINARY_PARALLEL_CASES,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STALE_RESPONSE_MINUTES,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    generateAdvancedPreliminaryAnalysis,
    projectAdvancedPreliminaryAnalysis
} from "../server/advancedPreliminaryAnalysis.js";
import {
    createAnalysisProviderClient,
    publicAnalysisProviderCatalog
} from "../server/analysisProvider.js";
import {
    configuredStage1DefaultModel,
    configuredStage1Models
} from "../server/analysisModelCatalog.js";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

const messages = [{
    id: "00000000-0000-4000-8000-000000000001",
    language: "en",
    originalText: "I normally do not go to bed until around 12:30, and I feel tired the next day.",
    analysisText: "I normally do not go to bed until around 12:30, and I feel tired the next day."
}, {
    id: "00000000-0000-4000-8000-000000000002",
    language: "en",
    originalText: "I want a quieter environment, although I stay awake really late most nights.",
    analysisText: "I want a quieter environment, although I stay awake really late most nights."
}];

function validDraft() {
    return {
        meaning_units: [{
            message_id: messages[0].id,
            exact_source_text: "do not go to bed until around 12:30",
            occurrence_index: 1,
            context_note: "Exact sleep-timing evidence."
        }, {
            message_id: messages[0].id,
            exact_source_text: "I feel tired the next day",
            occurrence_index: 1,
            context_note: "Exact next-day consequence."
        }, {
            message_id: messages[1].id,
            exact_source_text: "I want a quieter environment",
            occurrence_index: 1,
            context_note: "Exact desired sleep-environment change."
        }, {
            message_id: messages[1].id,
            exact_source_text: "I stay awake really late most nights",
            occurrence_index: 1,
            context_note: "Exact repeated sleep-timing evidence."
        }],
        codes: [{
            label: "Late bedtime",
            definition: "Going to bed later than desired or customary.",
            rationale: "Both passages describe repeated late sleep timing.",
            meaning_unit_numbers: [1, 4]
        }, {
            label: "Daytime tiredness",
            definition: "Tiredness experienced on the following day.",
            rationale: "The participant explicitly reports next-day tiredness.",
            meaning_unit_numbers: [2]
        }, {
            label: "Quiet environment",
            definition: "A preference for less environmental noise.",
            rationale: "The participant wants a quieter environment.",
            meaning_unit_numbers: [3]
        }],
        categories: [{
            label: "Sleep timing",
            definition: "Timing of sleep onset.",
            rationale: "Describes the participant's late bedtime pattern.",
            code_numbers: [1]
        }, {
            label: "Sleep consequences",
            definition: "Effects associated with the sleep pattern.",
            rationale: "Describes next-day tiredness.",
            code_numbers: [2]
        }, {
            label: "Sleep environment",
            definition: "Desired physical conditions for sleep.",
            rationale: "Describes the participant's preference for quiet.",
            code_numbers: [3]
        }, {
            label: "Sleep difficulties",
            definition: "Difficulties spanning timing and next-day effects.",
            rationale: "Links late bedtime with its reported consequence.",
            code_numbers: [1, 2]
        }],
        tentative_themes: [{
            label: "Misaligned sleep pattern",
            rationale: "Late sleep timing coexists with daytime tiredness and a desire for improved conditions.",
            category_numbers: [1, 2, 3, 4]
        }],
        case_summary: "The participant describes persistent late bedtime, next-day tiredness, and a desire for a quieter sleep environment."
    };
}

test("Phase 1 preserves exact Meaning Units and generates the complete case hierarchy", () => {
    const result = projectAdvancedPreliminaryAnalysis(validDraft(), messages);
    assert.deepEqual(result.systemProcessingNotes, []);
    assert.equal(result.meaningUnits.length, 4);
    assert.equal(result.codes.length, 3);
    assert.equal(result.categories.length, 4);
    assert.equal(result.tentativeThemes.length, 1);
    assert.deepEqual(result.categories[3].codeNumbers, [1, 2]);
    assert.deepEqual(result.tentativeThemes[0].categoryNumbers, [1, 2, 3, 4]);
    assert.match(result.caseSummary, /persistent late bedtime/);
    assert.equal(result.meaningUnits[2].exactSourceText, "I want a quieter environment");
});

test("Stage 1 has no validator and never rejects the model report", () => {
    const rewritten = validDraft();
    rewritten.meaning_units[0].exact_source_text = "Usually sleeps late";
    const projected = projectAdvancedPreliminaryAnalysis(rewritten, messages);
    assert.equal(projected.meaningUnits.length, 3);
    assert.equal(projected.codes.length, 3);
    assert.match(
        JSON.stringify(projected.systemProcessingNotes),
        /MU_RELATIONAL_PROJECTION_UNAVAILABLE/
    );

    const overlap = validDraft();
    overlap.meaning_units.push({
        message_id: messages[0].id,
        exact_source_text: "around 12:30, and I feel tired",
        occurrence_index: 1,
        context_note: "Overlapping span."
    });
    const result = projectAdvancedPreliminaryAnalysis(overlap, messages);
    assert.equal(result.meaningUnits.length, 5);
    assert.deepEqual(result.systemProcessingNotes, []);
});

test("Stage 1 performs one fresh model call from the original transcript only", async () => {
    const calls = [];
    const openaiClient = {
        responses: {
            create: async options => {
                calls.push(options);
                return {
                    model: "gpt-5.6-sol",
                    output_text: JSON.stringify(validDraft()),
                    usage: { input_tokens: 100, output_tokens: 50 }
                };
            }
        }
    };
    const result = await generateAdvancedPreliminaryAnalysis(
        openaiClient,
        messages,
        { projectName: "Sleeping habits", researchTopic: "Sleeping habits" },
        { model: "gpt-5.6-sol" }
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].input[1].content, /Original participant transcript/);
    assert.doesNotMatch(calls[0].input[1].content, /Proposed preliminary analysis/);
    assert.equal(result.audit.priorAnalysisUsed, false);
    assert.equal(result.audit.aiAnalysisPassCount, 1);
    assert.equal(result.audit.validationType,
        "none_no_analytical_validator");
    assert.equal(result.rawModelOutputText, JSON.stringify(validDraft()));
    assert.equal(result.codes.length, 3);
    assert.equal(result.tentativeThemes.length, 1);
});

test("unparseable completed model output is preserved instead of rejected", async () => {
    const result = await generateAdvancedPreliminaryAnalysis(
        {
            responses: {
                create: async () => ({
                    model: "gpt-5.6-sol",
                    output_text: "not-json-but-still-preserved",
                    usage: { input_tokens: 10, output_tokens: 5 }
                })
            }
        },
        messages,
        { projectName: "Sleeping habits", researchTopic: "Sleeping habits" },
        { model: "gpt-5.6-sol" }
    );
    assert.equal(result.rawModelOutputText, "not-json-but-still-preserved");
    assert.equal(result.rawModelOutput, null);
    assert.match(JSON.stringify(result.systemProcessingNotes), /MODEL_OUTPUT_NOT_JSON/);
    assert.equal(result.audit.validationType, "none_no_analytical_validator");
});

test("Phase 1 is versioned, stronger-model capable, and completes tentative themes", async () => {
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.equal(ADVANCED_PRELIMINARY_STOP_LAYER, "preliminary_tentative_themes");
    assert.equal(ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS, 20000);
    assert.equal(ADVANCED_PRELIMINARY_PARALLEL_CASES, 8);
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /v4-researcher-controlled-independent/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /v4-explicit-run-contract/);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /Meaning Units → Preliminary Codes → Preliminary Categories → Preliminary Tentative Themes/);
    assert.match(worker, /Relationships are many-to-many/);
    assert.match(worker, /Full-transcript coverage is mandatory/);
    assert.match(worker, /This is the only AI analysis pass for this case/);
    assert.match(worker, /without using an analytical validator/);
    assert.doesNotMatch(worker, /invalidReasons/);
    assert.doesNotMatch(worker, /validateAdvancedPreliminaryAnalysis/);
    assert.match(worker, /No previous analysis, second AI audit, repair call, or human approval gate will be used/);
    assert.doesNotMatch(worker, /auditAnalysis\(/);
    assert.doesNotMatch(worker, /advanced_preliminary_analysis_audit/);
    assert.doesNotMatch(worker, /stage1-source-content-audit/);
    assert.doesNotMatch(worker, /sharedVocabulary/);
});

test("resumed Stage 1 work has a durable incremental spending guard", async () => {
    const migration = await source(
        "supabase/migrations/20260901194500_resume_stage1_with_spending_guard.sql"
    );
    assert.match(migration, /resume_advanced_preliminary_analysis_run/);
    assert.match(migration, /spending_limit_usd/);
    assert.match(migration, /spending_baseline_usd/);
    assert.match(migration, /estimated_incremental_spend_usd/);
    assert.match(migration, /next_call_reserve_usd/);
    assert.match(migration, /incremental_total \+ active_run\.next_call_reserve_usd/);
    assert.match(migration, /spending_limit_reached/);
    assert.match(migration, /status in \('cancelled', 'failed'\)/);
    assert.match(migration, /previous_cancellations/);
    assert.match(migration, /selected_run\.model <> 'gpt-5\.6-sol'/);
    assert.doesNotMatch(migration, /delete from public\./i);
});

test("a stopped GPT-5.6 run can continue only after its preserved reports prove independence", async () => {
    const migration = await source(
        "supabase/migrations/20260901202500_verify_and_resume_stopped_gpt56_run.sql"
    );
    assert.match(migration, /contract_transitions/);
    assert.match(migration, /independently_verified_count/);
    assert.match(migration, /priorAnalysisUsed/);
    assert.match(migration, /aiAnalysisPassCount/);
    assert.match(migration, /local_deterministic_source_and_relationship_integrity/);
    assert.match(migration, /previousAnalysisVersion/);
    assert.match(migration, /previousPromptVersion/);
    assert.match(migration, /p_execution_plan_hash/);
    assert.match(migration, /preliminary-case-analysis-v4-researcher-controlled-independent/);
    assert.doesNotMatch(migration, /delete from public\./i);
});

test("an explicitly resumed run exposes exactly one credential-free server wake", async () => {
    const migration = await source(
        "supabase/migrations/20260901205500_add_single_use_stage1_wake.sql"
    );
    const endpoint = await source("api/automatic-analysis.js");
    assert.match(migration, /initial_wake_pending/);
    assert.match(migration, /initial_wake_consumed_at/);
    assert.match(migration, /consume_authorized_analysis_initial_wake/);
    assert.match(migration, /spend_guard_status = 'active'/);
    assert.match(migration, /spending_limit_usd is not null/);
    assert.match(migration, /initial_wake_pending = false/);
    assert.match(endpoint, /authorized-initial-wake/);
    assert.match(endpoint, /single_use_researcher_authorized_run_wake/);
    assert.match(endpoint, /processStagedAndContinue/);
});

test("long GPT-5.6 cases use one durable background response and poll by ID", async () => {
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    const migration = await source(
        "supabase/migrations/20260901223500_make_stage1_responses_durable.sql"
    );
    assert.match(worker, /background/);
    assert.match(worker, /store: background/);
    assert.match(worker, /responses\.retrieve/);
    assert.match(worker, /save_advanced_preliminary_provider_response/);
    assert.match(worker, /advanced-preliminary-\$\{claim\.job_id\}/);
    assert.match(worker, /\["queued", "in_progress"\]/);
    assert.match(migration, /provider_response_id/);
    assert.match(migration, /unverified_spend_reserve_usd/);
    assert.match(migration, /conservative spending reserve recorded/);
    assert.match(migration, /Poll the one already-submitted response/);
    assert.match(migration, /orphan_job_total \+ reserve_total/);
    assert.match(migration, /spending_limit_usd = 80/);
    assert.doesNotMatch(migration, /delete from public\./i);
});

test("the server resumes durable analysis without recursive function calls", async () => {
    const endpoint = await source("api/automatic-analysis.js");
    const migration = await source(
        "supabase/migrations/20260901224500_schedule_durable_stage1_ticks.sql"
    );
    assert.match(endpoint, /authorized-run-tick/);
    assert.match(endpoint, /consume_authorized_analysis_server_tick/);
    assert.match(endpoint, /one_durable_stage1_tick/);
    assert.doesNotMatch(endpoint, /await continueStagedAnalysis/);
    assert.match(migration, /last_server_tick_at/);
    assert.match(migration, /interval '20 seconds'/);
    assert.match(migration, /\* \* \* \* \*/);
    assert.match(migration, /authorized-run-tick/);
    assert.match(migration, /spend_guard_status = 'active'/);
});

test("authorized Stage 1 ticks fill and poll a bounded parallel GPT-5.6 queue", async () => {
    const endpoint = await source("api/automatic-analysis.js");
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    const migration = await source(
        "supabase/migrations/20260902032000_parallelize_stage1_processing.sql"
    );
    assert.match(endpoint, /ADVANCED_PRELIMINARY_PARALLEL_CASES \* 2/);
    assert.match(endpoint, /claim_available_advanced_preliminary_analysis/);
    assert.match(worker, /claimFunction/);
    assert.match(migration, /maximum_parallel_cases constant integer := 8/);
    assert.match(migration, /provider_response_checked_at <= now\(\) - interval '20 seconds'/);
    assert.match(migration, /current_processing \+ 1/);
    assert.doesNotMatch(migration, /legacy_unusable/);
    assert.doesNotMatch(migration, /delete from public\./i);
});

test("run-level spend includes completed, orphaned, and uncertain usage", async () => {
    const migration = await source(
        "supabase/migrations/20260901225000_include_uncertain_usage_in_run_spend.sql"
    );
    assert.match(migration, /recorded_total/);
    assert.match(migration, /orphan_job_total/);
    assert.match(migration, /reserve_total/);
    assert.match(migration, /orphan_job_total \+ reserve_total/);
    assert.match(migration, /unverified_spend_reserve_usd/);
});

test("a stale background response is cancelled, preserved, and retried at most once", async () => {
    assert.equal(ADVANCED_PRELIMINARY_STALE_RESPONSE_MINUTES, 45);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    const migration = await source(
        "supabase/migrations/20260902004107_handle_stale_stage1_responses.sql"
    );
    assert.match(worker, /responses\.cancel\(response\.id\)/);
    assert.match(worker, /resolve_stalled_advanced_preliminary_response/);
    assert.match(worker, /attempt-\$\{claim\.attempt_count\}/);
    assert.match(migration, /provider_response_history/);
    assert.match(migration, /stale_response_retry_count/);
    assert.match(migration, /interval '45 minutes'/);
    assert.match(migration, /retry_scheduled/);
    assert.match(migration, /terminal_failure/);
    assert.match(migration, /unverified_spend_reserve_usd = unverified_spend_reserve_usd/);
    assert.doesNotMatch(migration, /delete from public\./i);
});

test("analysis providers are server-configured and never expose credentials", () => {
    const environment = {
        OPENAI_API_KEY: "server-secret",
        ANALYSIS_PROVIDER_CONFIG_JSON: JSON.stringify([{
            id: "second-provider",
            label: "Second Provider",
            apiKeyEnvironmentVariable: "SECOND_PROVIDER_KEY",
            baseURL: "https://provider.example/v1"
        }]),
        SECOND_PROVIDER_KEY: "second-server-secret"
    };
    const catalog = publicAnalysisProviderCatalog(environment);
    assert.deepEqual(catalog.map(provider => provider.id), ["openai", "second-provider"]);
    assert.equal(catalog.every(provider => provider.configured), true);
    assert.doesNotMatch(JSON.stringify(catalog), /server-secret/);

    const constructed = [];
    class FakeClient {
        constructor(options) { constructed.push(options); }
    }
    createAnalysisProviderClient("second-provider", environment, FakeClient);
    assert.deepEqual(constructed, [{
        apiKey: "second-server-secret",
        baseURL: "https://provider.example/v1"
    }]);
});

test("model suggestions are server-configurable without constraining manual model entry", () => {
    const configured = configuredStage1Models({
        ADVANCED_PRELIMINARY_ANALYSIS_MODELS: "gpt-5.6-sol,gpt-5.5,gpt-5.6-sol"
    });
    assert.deepEqual(configured, ["gpt-5.6-sol", "gpt-5.5"]);
    assert.equal(configuredStage1DefaultModel(configured, {
        ADVANCED_PRELIMINARY_ANALYSIS_MODEL: "gpt-5.5"
    }), "gpt-5.5");
});

test("database execution contract creates a fresh run without legacy analysis dependencies", async () => {
    const migration = await source(
        "supabase/migrations/20260901160500_restore_researcher_execution_contract.sql"
    );
    assert.match(migration, /create_fresh_independent_analysis_run/);
    assert.match(migration, /preview_fresh_independent_analysis_run/);
    assert.match(migration, /cancel_advanced_preliminary_analysis_run/);
    assert.match(migration, /execution_plan_hash/);
    assert.match(migration, /rules_snapshot/);
    assert.match(migration, /single_project_formally_completed_transcripts/);
    assert.match(migration, /'preliminary_tentative_themes'/);
    assert.match(migration, /join public\.case_code_map/);
    assert.match(migration, /source_report_id is null/);
    assert.match(migration, /design\.project_id = selected_project\.id/);
    assert.doesNotMatch(migration, /delete from public\./i);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/i);
    assert.doesNotMatch(migration, /join public\.automatic_case_analysis_jobs/i);
    assert.doesNotMatch(migration, /join public\.qualitative_case_reports/i);
});

test("researcher UI exposes the complete one-pass case hierarchy and locks later cross-case layers", async () => {
    const html = await source("staged-analysis.html");
    const access = await source("researcher-staged-access.js");
    const vercel = await source("vercel.json");
    const script = await source("researcher-advanced-preliminary.js");
    const dashboard = await source("server/advancedPreliminaryDashboard.js");
    assert.match(html, /Complete Preliminary Case-Based Analysis/);
    assert.match(html, /Unlock and show Stage 1/);
    assert.match(html, /data-staged-only="true"/);
    assert.match(script, /workspace\?\.prepend\(section\)/);
    assert.match(script, /stagedAnalysisPrimary/);
    assert.match(script, /choose Lock workspace and unlock again/);
    assert.match(script, /advancedPreliminaryLockButton/);
    assert.match(script, /sessionStorage\.removeItem\(TOKEN_STORAGE_KEY\)/);
    assert.match(html, /Phase 2A · Cross-Case Code Refinement — separate researcher-selected operation/);
    assert.match(html, /Phase 2B · Cross-Case Category Refinement — locked/);
    assert.match(html, /Phase 2C · Cross-Case Theme Development — locked/);
    assert.match(html, /Meaning Units →[\s\S]*Codes → Categories → Themes/);
    assert.match(html, /Earlier analytical[\s\S]*never silently used, audited, repaired/);
    assert.match(html, /without a per-case approval[\s\S]*bottleneck/);
    assert.match(html, /advancedPreliminaryModel/);
    assert.match(html, /advancedPreliminaryProvider/);
    assert.match(html, /Preview exact execution plan/);
    assert.match(html, /Start exactly this plan/);
    assert.match(html, /Stop active run/);
    assert.match(html, /list="advancedPreliminaryModelSuggestions"/);
    assert.match(html, /Enter any exact model identifier/);
    assert.match(html, /never silently replaced/);
    assert.doesNotMatch(html, /Form 1 · Cases/);
    assert.doesNotMatch(html, /Legacy analysis failures/);
    assert.doesNotMatch(html, /researcher-automatic-analysis/);
    assert.match(access, /Enter the researcher dashboard token/);
    assert.match(access, /workspace\.hidden = false/);
    assert.match(vercel, /"source": "\/researcher\.html"[\s\S]*"destination": "\/staged-analysis\.html"[\s\S]*"permanent": false/);
    assert.match(script, /payload\.availableModels/);
    assert.match(script, /payload\.availableProviders/);
    assert.match(script, /modelSelect\.value\.trim\(\)/);
    assert.doesNotMatch(script, /payload\.defaultModel/);
    assert.match(script, /modelSelect\.disabled = active/);
    assert.match(script, /action: "preflight"/);
    assert.match(script, /executionPlanHash/);
    assert.match(script, /action: "cancel"/);
    assert.match(script, /Inspect complete case report/);
    assert.match(script, /Stage 1 annotated transcript/);
    assert.match(script, /meaningUnitAnnotation/);
    assert.match(script, /One pass · original transcript/);
    assert.match(script, /Independent analysis provenance/);
    assert.match(script, /prior analysis used: no/);
    assert.match(html, /single-pass output could not be stored safely/);
    assert.match(html, /without an additional paid AI audit/);
    assert.match(html, /failure belongs to the system, not the participant/);
    assert.match(html, /Stage 1 Processing Transparency/);
    assert.doesNotMatch(html, /Legacy cases/);
    assert.match(script, /attentionCases/);
    assert.doesNotMatch(script, /Move to Legacy cases/);
    assert.doesNotMatch(script, /mark-legacy/);
    assert.doesNotMatch(dashboard, /set_advanced_preliminary_case_disposition/);
    assert.match(script, /participant and transcript remain included and processible/);
    assert.match(script, /download=stage1-csv/);
    assert.match(dashboard, /configuredStage1Models/);
    assert.match(dashboard, /probeAdvancedPreliminaryModel/);
    assert.doesNotMatch(dashboard, /models\.includes\(requestedModel\)/);
    assert.match(dashboard, /normalizeAnalysisModel\(req\.body\?\.model\)/);
    assert.match(dashboard, /createAnalysisProviderClient\(plan\.provider\)/);
    assert.match(dashboard, /execution plan changed or was not explicitly confirmed/i);
    assert.doesNotMatch(dashboard, /scheduleStagedAnalysis\(req\);\s*return \{ jobId/);
    assert.match(dashboard, /Requested model/);
    assert.match(dashboard, /Exact source text/);
});

test("ordinary design reads and Stage 1 claims cannot silently buy translation or cross-case work", async () => {
    const loadDesign = await source("api/loadDesign.js");
    const stage1 = await source("server/advancedPreliminaryAnalysis.js");
    const endpoint = await source("api/automatic-analysis.js");
    assert.doesNotMatch(loadDesign, /scheduleStagedAnalysis/);
    assert.doesNotMatch(loadDesign, /scheduleTranscriptTranslationBackfill/);
    assert.doesNotMatch(stage1, /ensureEnglishTranslations/);
    assert.doesNotMatch(endpoint, /processNextCrossCaseCodeRefinement/);
    assert.match(endpoint, /explicitly_authorized_run_continuation/);
});
