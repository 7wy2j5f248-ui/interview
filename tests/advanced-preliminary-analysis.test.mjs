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
    const result = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    assert.equal(result.complete, true);
    assert.equal(result.meaningUnits.length, 4);
    assert.equal(result.codes.length, 3);
    assert.equal(result.categories.length, 4);
    assert.equal(result.tentativeThemes.length, 1);
    assert.deepEqual(result.categories[3].codeNumbers, [1, 2]);
    assert.deepEqual(result.tentativeThemes[0].categoryNumbers, [1, 2, 3, 4]);
    assert.match(result.caseSummary, /persistent late bedtime/);
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
        "local_deterministic_source_and_relationship_integrity");
    assert.equal(result.codes.length, 3);
    assert.equal(result.tentativeThemes.length, 1);
});

test("Phase 1 is versioned, stronger-model capable, and completes tentative themes", async () => {
    assert.equal(ADVANCED_PRELIMINARY_MODEL, "gpt-5.6-sol");
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.equal(ADVANCED_PRELIMINARY_STOP_LAYER, "preliminary_tentative_themes");
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /v3-fresh-single-pass-complete/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /v3-transcript-only-single-pass/);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /Meaning Units → Preliminary Codes → Preliminary Categories → Preliminary Tentative Themes/);
    assert.match(worker, /Relationships are many-to-many/);
    assert.match(worker, /Full-transcript coverage is mandatory/);
    assert.match(worker, /This is the only AI analysis pass for this case/);
    assert.match(worker, /No previous analysis, second AI audit, repair call, or human approval gate will be used/);
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

test("database change scopes Phase 1, stores tentative themes, and preserves source data", async () => {
    const migration = await source(
        "supabase/migrations/20260901122121_complete_preliminary_case_reports.sql"
    );
    assert.match(migration, /create_stage1_meaning_unit_run/);
    assert.match(migration, /single_project_formally_completed_transcripts/);
    assert.match(migration, /'preliminary_tentative_themes'/);
    assert.match(migration, /advanced_preliminary_themes/);
    assert.match(migration, /advanced_preliminary_theme_categories/);
    assert.match(migration, /drop constraint if exists advanced_preliminary_category_codes_report_id_code_id_key/);
    assert.match(migration, /design\.project_id = selected_project\.id/);
    assert.match(migration, /SLEEPING-HABITS/);
    assert.doesNotMatch(migration, /delete from public\./i);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/i);
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
    assert.match(html, /Phase 2A · Cross-Case Code Refinement — automatic after Phase 1/);
    assert.match(html, /Phase 2B · Cross-Case Category Refinement — locked/);
    assert.match(html, /Phase 2C · Cross-Case Theme Development — locked/);
    assert.match(html, /Meaning Units →[\s\S]*Codes → Categories → Themes/);
    assert.match(html, /Rejected GPT-5\.1[\s\S]*is not used, audited, repaired, or supplied to the new model/);
    assert.match(html, /without[\s\S]*a per-case approval bottleneck/);
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
    assert.match(script, /Inspect complete case report/);
    assert.match(script, /Stage 1 annotated transcript/);
    assert.match(script, /meaningUnitAnnotation/);
    assert.match(script, /One pass · original transcript/);
    assert.match(script, /Independent analysis provenance/);
    assert.match(script, /prior analysis used: no/);
    assert.match(html, /single-pass output could not be stored safely/);
    assert.match(html, /without an additional paid AI audit/);
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
