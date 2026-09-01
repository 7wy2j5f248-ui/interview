import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_MODEL,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    generateAdvancedPreliminaryAnalysis,
    validateAdvancedPreliminaryAnalysis
} from "../server/advancedPreliminaryAnalysis.js";
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
        }]
    };
}

test("Stage 1 preserves exact Meaning Units and generates no higher layers", () => {
    const result = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    assert.equal(result.complete, true);
    assert.equal(result.meaningUnits.length, 4);
    assert.deepEqual(result.codes, []);
    assert.deepEqual(result.categories, []);
    assert.match(result.caseSummary, /No codes, categories, or themes were generated/);
    assert.equal(result.meaningUnits[2].exactSourceText, "I want a quieter environment");
});

test("Stage 1 rejects rewritten, courtesy, duplicate, and overlapping evidence", () => {
    const rewritten = validDraft();
    rewritten.meaning_units[0].exact_source_text = "Usually sleeps late";
    assert.equal(validateAdvancedPreliminaryAnalysis(rewritten, messages).complete, false);

    const overlap = validDraft();
    overlap.meaning_units.push({
        message_id: messages[0].id,
        exact_source_text: "around 12:30, and I feel tired",
        occurrence_index: 1,
        context_note: "Overlapping span."
    });
    const result = validateAdvancedPreliminaryAnalysis(overlap, messages);
    assert.equal(result.complete, false);
    assert.match(result.invalidReasons.join(" "), /overlaps another Meaning Unit/);
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
        { projectName: "Sleeping habits", researchTopic: "Sleeping habits" }
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].input[1].content, /Original participant transcript/);
    assert.doesNotMatch(calls[0].input[1].content, /Proposed preliminary analysis/);
    assert.equal(result.audit.priorAnalysisUsed, false);
    assert.equal(result.audit.aiAnalysisPassCount, 1);
    assert.equal(result.audit.validationType,
        "local_deterministic_exact_transcript_traceability");
});

test("Stage 1 is versioned, stronger-model capable, and stops at Meaning Units", async () => {
    assert.equal(ADVANCED_PRELIMINARY_MODEL, "gpt-5.6-sol");
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.equal(ADVANCED_PRELIMINARY_STOP_LAYER, "meaning_units");
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /v2-fresh-single-pass/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /v2-transcript-only-single-pass/);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /Stop at Meaning Units/);
    assert.match(worker, /Do not generate, name, imply, copy, or evaluate codes, categories, themes/);
    assert.match(worker, /Full-transcript coverage is mandatory/);
    assert.match(worker, /This is the only AI analysis pass for this case/);
    assert.match(worker, /No previous analysis and no second AI audit will be used/);
    assert.doesNotMatch(worker, /auditAnalysis\(/);
    assert.doesNotMatch(worker, /advanced_preliminary_analysis_audit/);
    assert.doesNotMatch(worker, /stage1-source-content-audit/);
    assert.doesNotMatch(worker, /sharedVocabulary/);
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

test("database migration scopes Stage 1 to one project and preserves all prior analysis", async () => {
    const migration = await source(
        "supabase/migrations/20260901013000_stage1_meaning_units_only.sql"
    );
    assert.match(migration, /create_stage1_meaning_unit_run/);
    assert.match(migration, /single_project_formally_completed_transcripts/);
    assert.match(migration, /'meaning_units'/);
    assert.match(migration, /design\.project_id = selected_project\.id/);
    assert.match(migration, /SLEEPING-HABITS/);
    assert.doesNotMatch(migration, /delete from public\./i);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/i);
});

test("researcher UI locks later stages and exposes single-pass source provenance", async () => {
    const html = await source("staged-analysis.html");
    const access = await source("researcher-staged-access.js");
    const vercel = await source("vercel.json");
    const script = await source("researcher-advanced-preliminary.js");
    const dashboard = await source("server/advancedPreliminaryDashboard.js");
    assert.match(html, /Stage 1 · Meaning Units/);
    assert.match(html, /Unlock and show Stage 1/);
    assert.match(html, /retired Forms 1–4 are not loaded or displayed/);
    assert.match(html, /data-staged-only="true"/);
    assert.match(script, /workspace\?\.prepend\(section\)/);
    assert.match(script, /stagedAnalysisPrimary/);
    assert.match(script, /choose Lock workspace and unlock again/);
    assert.match(script, /advancedPreliminaryLockButton/);
    assert.match(script, /sessionStorage\.removeItem\(TOKEN_STORAGE_KEY\)/);
    assert.match(html, /Stage 2 · Cross-Case Code Refinement — automatic after Stage 1/);
    assert.match(html, /Stage 3 · Category Development — locked/);
    assert.match(html, /Stage 4 · Theme Development — locked/);
    assert.doesNotMatch(html, /Stage 5 · Theme Development/);
    assert.match(html, /Meaning Units →[\s\S]*Codes → Categories → Themes/);
    assert.match(html, /Historical transcripts, reports, jobs, and failures remain preserved in[\s\S]*protected audit storage/);
    assert.match(html, /retired Forms 1–4 are not loaded or displayed/);
    assert.match(html, /No approval is required to keep Stage 1 or Stage 2 moving/);
    assert.match(html, /advancedPreliminaryModel/);
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
    assert.match(script, /modelSelect\.value\.trim\(\)/);
    assert.match(script, /Keep every manually typed/);
    assert.match(script, /modelSelect\.disabled = active/);
    assert.match(script, /Inspect Meaning Units/);
    assert.match(script, /Stage 1 annotated transcript/);
    assert.match(script, /meaningUnitAnnotation/);
    assert.match(script, /One pass · original transcript/);
    assert.match(script, /Independent analysis provenance/);
    assert.match(script, /prior analysis used: no/);
    assert.match(html, /analytically ambiguous or unverified Stage 1 cases/);
    assert.match(html, /They are not automatically archived/);
    assert.match(html, /These are not researcher archives/);
    assert.match(html, /Legacy cases/);
    assert.match(script, /attentionCases/);
    assert.match(script, /Move to Legacy cases/);
    assert.match(script, /mark-legacy/);
    assert.match(dashboard, /set_advanced_preliminary_case_disposition/);
    assert.match(script, /download=stage1-csv/);
    assert.match(dashboard, /configuredStage1Models/);
    assert.match(dashboard, /probeAdvancedPreliminaryModel/);
    assert.doesNotMatch(dashboard, /models\.includes\(requestedModel\)/);
    assert.match(dashboard, /normalizeOpenAIModel\(req\.body\.model\)/);
    assert.match(dashboard, /Requested model/);
    assert.match(dashboard, /Exact source text/);
});
