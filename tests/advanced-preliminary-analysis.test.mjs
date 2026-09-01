import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_MODEL,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    coverageGapIsReviewable,
    validateAdvancedPreliminaryAnalysis,
    validateAdvancedPreliminaryAudit
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

function acceptedAudit(analysis, overrides = {}) {
    return {
        meaning_unit_checks: analysis.meaningUnits.map((unit, index) => ({
            unit_number: index + 1,
            message_id: unit.messageId,
            exact_source_match: true,
            research_relevant: true,
            smallest_sufficient_span: true,
            context_preserved: true,
            explanation: "Accepted exact Meaning Unit."
        })),
        full_transcript_coverage: true,
        omitted_relevant_evidence: [],
        stage1_only: true,
        source_qualifies_for_framework: true,
        source_qualification_reason:
            "The transcript contains sufficient sleeping-habits evidence.",
        source_evidence_message_ids: [messages[0].id],
        overall_summary: "Full transcript coverage verified at Meaning Units only.",
        ...overrides
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

test("independent Stage 1 audit requires exact MU checks, coverage, and no higher layer", () => {
    const analysis = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    const accepted = validateAdvancedPreliminaryAudit(analysis, acceptedAudit(analysis));
    assert.equal(accepted.complete, true);
    assert.equal(accepted.meaningUnitChecks.length, 4);

    const rejected = validateAdvancedPreliminaryAudit(analysis, acceptedAudit(analysis, {
        full_transcript_coverage: false,
        omitted_relevant_evidence: [{
            message_id: messages[1].id,
            exact_source_text: "I want a quieter environment",
            explanation: "Relevant later evidence was omitted."
        }],
        stage1_only: false
    }));
    assert.equal(rejected.complete, false);
    assert.equal(rejected.omittedRelevantEvidence.length, 1);
    assert.equal(rejected.stage1Only, false);
});

test("source-content ineligibility is distinct from an analysis defect", () => {
    const analysis = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    const audit = validateAdvancedPreliminaryAudit(analysis, acceptedAudit(analysis, {
        source_qualifies_for_framework: false,
        source_qualification_reason:
            "The interview did not elicit enough clear topic-relevant content.",
        source_evidence_message_ids: [messages[0].id]
    }));
    assert.equal(audit.complete, false);
    assert.equal(audit.sourceQualifiesForFramework, false);
    assert.match(audit.sourceQualificationReason, /did not elicit enough/);
});

test("exact audit coverage gaps remain reviewable instead of becoming terminal failures", () => {
    const analysis = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    const audit = validateAdvancedPreliminaryAudit(analysis, acceptedAudit(analysis, {
        full_transcript_coverage: false,
        omitted_relevant_evidence: [{
            message_id: messages[1].id,
            exact_source_text: "quieter environment",
            explanation: "Relevant preference omitted from the proposal."
        }]
    }));
    assert.equal(audit.complete, false);
    assert.equal(coverageGapIsReviewable(audit), true);
});

test("a smallest-span audit disagreement remains inspectable instead of blocking the case", () => {
    const analysis = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    const value = acceptedAudit(analysis);
    value.meaning_unit_checks[0].smallest_sufficient_span = false;
    value.meaning_unit_checks[0].explanation =
        "The exact passage contains two separable substantive statements.";
    const audit = validateAdvancedPreliminaryAudit(analysis, value);
    assert.equal(audit.complete, false);
    assert.equal(audit.meaningUnitChecks[0].accepted, false);
    assert.equal(coverageGapIsReviewable(audit), true);
});

test("Stage 1 is versioned, stronger-model capable, and stops at Meaning Units", async () => {
    assert.equal(ADVANCED_PRELIMINARY_MODEL, "gpt-5.6-sol");
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.equal(ADVANCED_PRELIMINARY_STOP_LAYER, "meaning_units");
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /stage1-v1-meaning-units-only/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /stage1-prompt-v1-exact-coverage/);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /Stop at Meaning Units/);
    assert.match(worker, /Do not generate, name, imply, copy, or evaluate codes, categories, themes/);
    assert.match(worker, /Full-transcript coverage is mandatory/);
    assert.match(worker, /source_qualifies_for_framework=false/);
    assert.match(worker, /stage1-source-content-audit/);
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

test("researcher UI locks later stages and exposes model, audit, evidence, and export provenance", async () => {
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
    assert.match(script, /Full-transcript coverage/iu);
    assert.match(script, /Needs attention · Stage 1 audit issues/);
    assert.match(script, /Draft Meaning Units requiring review/);
    assert.match(html, /analytically ambiguous or unverified Stage 1 cases/);
    assert.match(html, /They are not automatically archived/);
    assert.match(html, /These are not researcher archives/);
    assert.match(html, /Legacy cases/);
    assert.match(script, /attentionCases/);
    assert.match(script, /Move to Legacy cases/);
    assert.match(script, /mark-legacy/);
    assert.match(dashboard, /coverageReviewRequired: true/);
    assert.match(dashboard, /set_advanced_preliminary_case_disposition/);
    assert.match(script, /Exact transcript passages requiring coverage review/);
    assert.match(script, /download=stage1-csv/);
    assert.match(dashboard, /configuredStage1Models/);
    assert.match(dashboard, /probeAdvancedPreliminaryModel/);
    assert.doesNotMatch(dashboard, /models\.includes\(requestedModel\)/);
    assert.match(dashboard, /normalizeOpenAIModel\(req\.body\.model\)/);
    assert.match(dashboard, /Requested model/);
    assert.match(dashboard, /Exact source text/);
});
