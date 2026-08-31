import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_MODEL,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    validateAdvancedPreliminaryAnalysis,
    validateAdvancedPreliminaryAudit
} from "../server/advancedPreliminaryAnalysis.js";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

const messages = [{
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "S1",
    participantId: "P1",
    language: "en",
    originalText: "I normally do not go to bed until around 12:30, and I feel tired the next day.",
    englishTranslation: null,
    analysisText: "I normally do not go to bed until around 12:30, and I feel tired the next day."
}, {
    id: "00000000-0000-4000-8000-000000000002",
    sessionId: "S1",
    participantId: "P1",
    language: "en",
    originalText: "I stay awake really late most nights.",
    englishTranslation: null,
    analysisText: "I stay awake really late most nights."
}];

function validDraft() {
    return {
        meaning_units: [{
            message_id: messages[0].id,
            exact_source_text: "do not go to bed until around 12:30",
            occurrence_index: 1,
            context_note: "Bedtime timing"
        }, {
            message_id: messages[0].id,
            exact_source_text: "I feel tired the next day",
            occurrence_index: 1,
            context_note: "Daytime consequence"
        }, {
            message_id: messages[1].id,
            exact_source_text: "stay awake really late most nights",
            occurrence_index: 1,
            context_note: "Repeated late timing"
        }],
        codes: [{
            label: "Late bedtime",
            definition: "Habitually delayed sleep onset timing.",
            rationale: "Two distinct meaning units express delayed bedtime.",
            meaning_unit_numbers: [1, 3]
        }, {
            label: "Daytime fatigue",
            definition: "Tiredness experienced during the following day.",
            rationale: "The participant explicitly reports next-day tiredness.",
            meaning_unit_numbers: [2]
        }],
        categories: [{
            label: "Sleep timing consequences",
            definition: "Relationships between sleep timing and daytime condition.",
            rationale: "Groups delayed bedtime with its stated daytime consequence.",
            code_numbers: [1, 2]
        }],
        case_summary: "This case describes delayed bedtime and next-day fatigue."
    };
}

test("advanced preliminary validation preserves reusable codes and exact MU lineage", () => {
    const result = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    assert.equal(result.complete, true);
    assert.equal(result.meaningUnits.length, 3);
    assert.deepEqual(result.codes[0].meaningUnitNumbers, [1, 3]);
    assert.deepEqual(result.categories[0].codeNumbers, [1, 2]);
    assert.deepEqual(result.unassignedCodeNumbers, []);
    assert.equal(result.meaningUnits[0].exactSourceText,
        "do not go to bed until around 12:30");
    assert.equal(result.meaningUnits[0].messageId, messages[0].id);
});

test("advanced preliminary validation rejects rewritten or non-source meaning units", () => {
    const draft = validDraft();
    draft.meaning_units[0].exact_source_text = "Usually sleeps late";
    const result = validateAdvancedPreliminaryAnalysis(draft, messages);
    assert.equal(result.complete, false);
    assert.match(result.invalidReasons.join(" "), /exact substantive span/);
});

test("independent audit makes case-paraphrase and reusability explicit gates", () => {
    const analysis = validateAdvancedPreliminaryAnalysis(validDraft(), messages);
    const audit = validateAdvancedPreliminaryAudit(analysis, {
        code_checks: analysis.codes.map((code, index) => ({
            code_number: index + 1,
            label: code.label,
            transcript_grounded: true,
            analytical_concept: true,
            not_case_paraphrase: index !== 0,
            potentially_reusable: true,
            appropriately_specific: true,
            meaning_unit_fit: true,
            explanation: index === 0 ? "Still too close to one utterance." : "Accepted."
        })),
        category_checks: [{
            category_number: 1,
            label: analysis.categories[0].label,
            derived_from_codes: true,
            coherent_grouping: true,
            higher_order_abstraction: true,
            no_theme_claim: true,
            explanation: "Accepted."
        }],
        overall_summary: "One code requires repair."
    });
    assert.equal(audit.complete, false);
    assert.equal(audit.codeChecks[0].notCaseParaphrase, false);
});

test("advanced run is versioned, uses a stronger reasoning model, and stops at categories", async () => {
    assert.equal(ADVANCED_PRELIMINARY_MODEL, "gpt-5.6-sol");
    assert.equal(ADVANCED_PRELIMINARY_REASONING_EFFORT, "high");
    assert.match(ADVANCED_PRELIMINARY_ANALYSIS_VERSION, /advanced-preliminary/);
    assert.match(ADVANCED_PRELIMINARY_PROMPT_VERSION, /analytical-concepts/);
    const worker = await source("server/advancedPreliminaryAnalysis.js");
    assert.match(worker, /Stop at preliminary categories/);
    assert.match(worker, /Do not generate themes/);
    assert.match(worker, /not a shortened retelling/);
    assert.match(worker, /exact_source_text verbatim from original_text/);
    assert.doesNotMatch(worker, /sharedVocabulary/);
});

test("advanced schema preserves previous reports and stable MU to code to category IDs", async () => {
    const migration = await source(
        "supabase/migrations/20260831235500_add_advanced_preliminary_analysis.sql"
    );
    assert.match(migration, /advanced_preliminary_analysis_runs/);
    assert.match(migration, /advanced_preliminary_meaning_units/);
    assert.match(migration, /advanced_preliminary_code_meaning_units/);
    assert.match(migration, /advanced_preliminary_category_codes/);
    assert.match(migration, /source_report_id uuid references public\.qualitative_case_reports/);
    assert.match(migration, /pg_advisory_xact_lock\(hashtext\('advanced_preliminary_analysis_worker'\)\)/);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/i);
    assert.doesNotMatch(migration, /delete from public\.qualitative_case_/i);
    assert.doesNotMatch(migration, /insert into public\.qualitative_case_/i);
});

test("researcher UI exposes model provenance, progress, comparison, and traceability", async () => {
    const html = await source("researcher.html");
    const script = await source("researcher-advanced-preliminary.js");
    assert.match(html, /New Advanced-Model Preliminary Analysis/);
    assert.match(html, /Meaning Units → Preliminary Analytical Codes → Preliminary Categories/);
    assert.match(html, /researcher-advanced-preliminary\.js/);
    assert.match(script, /Previous preliminary analysis \(preserved comparison\)/);
    assert.match(script, /Inspect MU → Code → Category/);
    assert.match(script, /Stable code ID/);
    assert.match(script, /Open complete preserved transcript/);
});
