import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    validatePreliminaryCodes,
    validateRefinement
} from "../server/crossCaseCodeRefinement.js";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");
const meaningUnits = [{
    id: "00000000-0000-4000-8000-000000000001",
    exact_source_text: "I usually go to bed after midnight."
}, {
    id: "00000000-0000-4000-8000-000000000002",
    exact_source_text: "I feel tired the next morning."
}];

test("preliminary Codes preserve exact MU provenance and permit many-to-many links", () => {
    const result = validatePreliminaryCodes({
        preliminary_codes: [{
            label: "Late bedtime",
            definition: "Bedtime after midnight.",
            rationale: "The participant explicitly describes a post-midnight bedtime.",
            meaning_unit_ids: [meaningUnits[0].id]
        }, {
            label: "Next-day tiredness",
            definition: "Tiredness following the sleep period.",
            rationale: "The participant describes morning tiredness.",
            meaning_unit_ids: [meaningUnits[0].id, meaningUnits[1].id]
        }]
    }, meaningUnits);
    assert.equal(result.complete, true);
    assert.deepEqual(result.codes[1].meaningUnitIds, [
        meaningUnits[0].id, meaningUnits[1].id
    ]);
});

test("preliminary Code validation rejects omitted MUs and invented evidence IDs", () => {
    const omitted = validatePreliminaryCodes({
        preliminary_codes: [{
            label: "Late bedtime",
            definition: "Bedtime after midnight.",
            rationale: "Exact case evidence.",
            meaning_unit_ids: [meaningUnits[0].id]
        }]
    }, meaningUnits);
    assert.equal(omitted.complete, false);
    assert.match(omitted.problems.join(" "), /Meaning Units without a preliminary Code/);

    const invented = validatePreliminaryCodes({
        preliminary_codes: [{
            label: "Late bedtime",
            definition: "Bedtime after midnight.",
            rationale: "Exact case evidence.",
            meaning_unit_ids: ["00000000-0000-4000-8000-000000000099"]
        }]
    }, meaningUnits);
    assert.equal(invented.complete, false);
    assert.match(invented.problems.join(" "), /invalid Meaning Unit provenance/);
});

test("cross-case refinement requires semantic evidence for an existing shared Code", () => {
    const candidates = [{
        id: "00000000-0000-4000-8000-000000000010",
        refined_code_label: "Late bedtime"
    }];
    const equivalent = validateRefinement({
        decision: "equivalent",
        existing_refined_code_id: candidates[0].id,
        refined_label: "Not used",
        refined_definition: "Not used",
        rationale: "Both Codes describe habitual bedtime after midnight."
    }, candidates);
    assert.equal(equivalent.complete, true);

    const unknown = validateRefinement({
        decision: "equivalent",
        existing_refined_code_id: "00000000-0000-4000-8000-000000000099",
        refined_label: "Not used",
        refined_definition: "Not used",
        rationale: "Similar wording alone."
    }, candidates);
    assert.equal(unknown.complete, false);
});

test("Stage 2 schema is automatic, case-grounded, traceable, and stops before Categories", async () => {
    const migration = await source(
        "supabase/migrations/20260901070000_add_automatic_stage2_code_refinement.sql"
    );
    const worker = await source("server/crossCaseCodeRefinement.js");
    const api = await source("api/automatic-analysis.js");
    const html = await source("staged-analysis.html");
    const dashboard = await source("server/advancedPreliminaryDashboard.js");
    const vercel = JSON.parse(await source("vercel.json"));

    assert.match(migration, /stage2_preliminary_codes/);
    assert.match(migration, /stage2_preliminary_code_evidence/);
    assert.match(migration, /stage2_refined_codes/);
    assert.match(migration, /stage2_code_assignments/);
    assert.match(migration, /job\.disposition = 'active'/);
    assert.match(migration, /selected_stage1\.status not in \('completed', 'completed_with_failures'\)/);
    assert.match(migration, /Meaning Unit evidence does not belong to the selected case/);
    assert.match(migration, /get_stage2_refined_code_export/);
    assert.doesNotMatch(migration, /delete from public\./i);
    assert.doesNotMatch(migration, /update public\.advanced_preliminary_meaning_units/i);

    assert.match(worker, /Similar wording is not enough/);
    assert.match(worker, /Do not merge analytically different meanings/);
    assert.match(worker, /Do not alter Meaning Units/);
    assert.doesNotMatch(worker, /stage2_preliminary_case_codes/);
    assert.doesNotMatch(worker, /Stage 2 preliminary-code repair/);
    assert.match(worker, /advanced_preliminary_codes/);
    assert.match(worker, /p_input_tokens: 0/);
    assert.match(api, /processNextAdvancedPreliminaryAnalysis[\s\S]*processNextCrossCaseCodeRefinement/);
    assert.match(html, /without[\s\S]*a per-case approval bottleneck/);
    assert.match(html, /Phase 2B · Cross-Case Category Refinement — locked/);
    assert.match(html, /Phase 2C · Cross-Case Theme Development — locked/);
    assert.match(dashboard, /Case ID/);
    assert.match(dashboard, /Preliminary Code/);
    assert.match(dashboard, /Refined Code/);
    assert.match(dashboard, /Exact transcript evidence/);
    assert.match(dashboard, /downloadStage2Csv/);
    assert.deepEqual(vercel.crons, [{
        path: "/api/automatic-analysis?cron=staged",
        schedule: "0 0 * * *"
    }]);
});
