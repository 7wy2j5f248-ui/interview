import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    EXECUTION_CONTRACT_VERSION,
    availableAdvancedPreliminaryWorkerConcurrency,
    configuredAdvancedPreliminaryMaxOutputTokens,
    configuredAdvancedPreliminaryWorkerConcurrency,
    generateAdvancedPreliminaryAnalysis
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
    originalText: "I normally sleep after midnight.",
    englishTranslation: null
}];

test("Stage 1 preserves the exact first response without parsing it", async () => {
    const exact = "  not-json, incomplete, or imperfect output\n";
    const calls = [];
    const result = await generateAdvancedPreliminaryAnalysis(
        { responses: { create: async options => {
            calls.push(options);
            return {
                model: "gpt-5.6-sol",
                output_text: exact,
                usage: { input_tokens: 10, output_tokens: 5 }
            };
        } } },
        messages,
        { projectName: "Sleeping habits", researchTopic: "Sleeping habits" },
        { model: "gpt-5.6-sol" }
    );

    assert.equal(calls.length, 1);
    assert.equal(result.rawModelOutputText, exact);
    assert.equal(result.inputTokenCount, 10);
    assert.equal(result.outputTokenCount, 5);
    assert.equal(result.audit.aiAnalysisPassCount, 1);
    assert.equal(result.audit.validationType, "none_no_analytical_validator");
    assert.equal(result.audit.relationalProjectionType, "none_removed");
    assert.doesNotMatch(JSON.stringify(calls[0]), /json_schema|strict/);
    assert.match(calls[0].input[1].content, /Original participant transcript/);
});

test("Stage 1 instructions contain no platform-created analytical rule snapshot", async () => {
    const calls = [];
    await generateAdvancedPreliminaryAnalysis(
        { responses: { create: async options => {
            calls.push(options);
            return { output_text: "first response" };
        } } },
        messages,
        {
            projectName: "Sleeping habits",
            researchTopic: "Sleeping habits",
            rulesSnapshot: { hidden: "must not be supplied" }
        },
        { model: "gpt-5.6-sol" }
    );
    const prompt = JSON.stringify(calls[0].input);
    assert.doesNotMatch(prompt, /must not be supplied|rules snapshot/i);
    assert.match(prompt, /one completed interview independently/i);
    assert.match(prompt, /exact first response/i);
});

test("Stage 1 contract is exact-output-only", async () => {
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.equal(ADVANCED_PRELIMINARY_STOP_LAYER, "exact_first_response");
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /v5-exact-first-response/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /v5-minimal-independent/);
    assert.match(EXECUTION_CONTRACT_VERSION, /v2-exact-output-only/);
    assert.equal(configuredAdvancedPreliminaryMaxOutputTokens({}), 40000);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.doesNotMatch(worker, /projectAdvancedPreliminaryAnalysis/);
    assert.doesNotMatch(worker, /JSON\.parse/);
    assert.doesNotMatch(worker, /responses\.cancel/);
    assert.doesNotMatch(worker, /resolve_stalled_advanced_preliminary_response/);
    assert.doesNotMatch(worker, /probeAdvancedPreliminaryModel/);
    assert.match(worker, /rawModelOutputText/);
});

test("durable background calls are submitted once and then polled by response ID", async () => {
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /background/);
    assert.match(worker, /responses\.retrieve/);
    assert.match(worker, /save_advanced_preliminary_provider_response/);
    assert.match(worker, /advanced-preliminary-\$\{claim\.job_id\}-attempt-\$\{claim\.attempt_count\}/);
    assert.match(worker, /\["queued", "in_progress"\]/);
});

test("execution concurrency remains technical and workload-derived", async () => {
    assert.equal(configuredAdvancedPreliminaryWorkerConcurrency({}), null);
    assert.equal(configuredAdvancedPreliminaryWorkerConcurrency({
        ADVANCED_PRELIMINARY_WORKER_CONCURRENCY: "13"
    }), 13);
    assert.equal(availableAdvancedPreliminaryWorkerConcurrency({
        source_case_count: 275, completed_count: 255
    }), 20);
    assert.throws(() => configuredAdvancedPreliminaryWorkerConcurrency({
        ADVANCED_PRELIMINARY_WORKER_CONCURRENCY: "0"
    }), /positive integer/);
    const endpoint = await source("api/automatic-analysis.js");
    assert.match(endpoint, /active_run_remaining_workload/);
    assert.match(endpoint, /p_maximum_parallel_cases: maximumParallelCases/);
});

test("database contract stores exact output only and never retries", async () => {
    const migration = await source(
        "supabase/migrations/20260902150000_remove_stage1_gatekeepers.sql"
    );
    assert.match(migration, /exact first provider response/i);
    assert.match(migration, /parsed_model_output = null/);
    assert.match(migration, /candidate\.status = 'pending'/);
    assert.doesNotMatch(migration, /candidate\.attempt_count < 3/);
    assert.match(migration, /next_retry_at = null/);
    assert.match(migration, /No replacement request was submitted/);
    assert.match(migration, /resolve_stalled_advanced_preliminary_response[\s\S]*service_role/);
    assert.match(migration, /ensure_stage2_code_refinement_run[\s\S]*service_role/);
    assert.match(migration, /claim_next_stage2_code_refinement[\s\S]*service_role/);
    assert.match(migration, /relationalProjectionType', 'none_removed'/);
    assert.match(migration, /historicalProjectionOnly/);
    assert.match(migration, /GOV-STAGE1-EXACT-001/);
});

test("a delayed duplicate worker cannot overwrite a saved report", async () => {
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    const migration = await source(
        "supabase/migrations/20260902150000_remove_stage1_gatekeepers.sql"
    );
    assert.match(worker, /existingReportIdForJob/);
    assert.match(worker, /alreadyCompleted: true/);
    assert.match(migration, /existing_report_id/);
    assert.match(migration, /return existing_report_id/);
});

test("provider credentials remain server-side", () => {
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
    class FakeClient { constructor(options) { constructed.push(options); } }
    createAnalysisProviderClient("second-provider", environment, FakeClient);
    assert.deepEqual(constructed, [{
        apiKey: "second-server-secret", baseURL: "https://provider.example/v1"
    }]);
});

test("model suggestions do not constrain exact manual model entry", () => {
    const configured = configuredStage1Models({
        ADVANCED_PRELIMINARY_ANALYSIS_MODELS: "gpt-5.6-sol,gpt-5.5,gpt-5.6-sol"
    });
    assert.deepEqual(configured, ["gpt-5.6-sol", "gpt-5.5"]);
    assert.equal(configuredStage1DefaultModel(configured, {
        ADVANCED_PRELIMINARY_ANALYSIS_MODEL: "gpt-5.5"
    }), "gpt-5.5");
});

test("researcher UI exposes exact responses and keeps Stage 2 unavailable", async () => {
    const [html, script, dashboard] = await Promise.all([
        source("staged-analysis.html"),
        source("researcher-advanced-preliminary.js"),
        source("server/advancedPreliminaryDashboard.js")
    ]);
    assert.match(html, /one completed transcript → one independent/);
    assert.match(html, /displays that first response exactly as returned/);
    assert.match(html, /without a capability-test call/);
    assert.match(script, /Inspect exact response/);
    assert.match(script, /Exact first model response/);
    assert.match(script, /provider call is still running|provider request is still running/);
    assert.match(script, /participant and transcript remain included and processible/);
    assert.doesNotMatch(script, /meaningUnitAnnotation|preliminaryHierarchy/);
    assert.doesNotMatch(script, /download=stage2-csv/);
    assert.match(dashboard, /modelProbeCalls: 0/);
    assert.match(dashboard, /p_rules_snapshot: \{\}/);
    assert.doesNotMatch(dashboard, /probeAdvancedPreliminaryModel/);
    assert.doesNotMatch(dashboard, /downloadStage2Csv/);
    assert.match(dashboard, /Exact first model response/);
});

test("ordinary Stage 1 activity cannot start cross-case work", async () => {
    const [loadDesign, stage1, endpoint] = await Promise.all([
        source("api/loadDesign.js"),
        source("server/advancedPreliminaryAnalysis.js"),
        source("api/automatic-analysis.js")
    ]);
    assert.doesNotMatch(loadDesign, /scheduleStagedAnalysis/);
    assert.doesNotMatch(stage1, /ensureEnglishTranslations/);
    assert.doesNotMatch(endpoint, /processNextCrossCaseCodeRefinement/);
    assert.match(endpoint, /explicitly_authorized_run_continuation/);
});
