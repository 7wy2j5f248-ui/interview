import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    buildStage2AResponseOptions,
    HARMONIZATION_SCHEMA,
    stage2AModelLimits
} from "../server/stage2aCodeHarmonization.js";

const migrationPath = new URL(
    "../supabase/migrations/20260902195148_add_stage2a_code_harmonization.sql",
    import.meta.url
);

test("Stage 2A sends one complete cross-case corpus and stops at Harmonized Codes", () => {
    const corpus = [{
        case_id: "P001",
        preliminary_code_id: "00000000-0000-4000-8000-000000000001",
        preliminary_code_position: "CO1",
        preliminary_code: "Late sleeping time",
        meaning_units: [{
            meaning_unit_id: "00000000-0000-4000-8000-000000000002",
            exact_source_text: "I usually sleep after midnight."
        }]
    }];
    const options = buildStage2AResponseOptions({
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        rules_snapshot: { project: "Sleeping habits" }
    }, corpus);

    assert.equal(options.input.length, 1);
    assert.equal(options.truncation, "disabled");
    assert.equal(options.max_output_tokens, 128_000);
    assert.match(options.instructions, /entire corpus together/i);
    assert.match(options.instructions, /Do not divide it into batches/i);
    assert.match(options.instructions, /Do not create or refine Categories/i);
    assert.match(options.instructions, /Do not create Themes/i);
    assert.match(options.instructions, /do not rewrite, merge, standardize, remove, or regenerate Meaning Units/i);
    assert.match(options.input[0].content[0].text, /Late sleeping time/);
});

test("Stage 2A output schema maps preliminary Codes to emergent HCOs", () => {
    assert.deepEqual(HARMONIZATION_SCHEMA.required, ["harmonized_codes"]);
    const item = HARMONIZATION_SCHEMA.properties.harmonized_codes.items;
    assert.deepEqual(item.required, [
        "label", "definition", "semantic_basis", "preliminary_code_ids"
    ]);
    assert.equal(item.properties.preliminary_code_ids.type, "array");
    assert.equal(HARMONIZATION_SCHEMA.properties.harmonized_codes.maxItems, undefined);
});

test("selected GPT-5.6 model keeps documented whole-context limits", () => {
    assert.deepEqual(stage2AModelLimits("gpt-5.6-sol"), {
        contextWindow: 1_050_000,
        maximumOutput: 128_000
    });
});

test("Stage 2A schema preserves HCO to preliminary Code to MU provenance", async () => {
    const migration = await readFile(migrationPath, "utf8");
    assert.match(migration, /stage2a_code_harmonization_runs/);
    assert.match(migration, /stage2a_harmonized_codes/);
    assert.match(migration, /stage2a_preliminary_code_mappings/);
    assert.match(migration, /pre_call_snapshot jsonb not null/);
    assert.match(migration, /get_stage2a_harmonization_corpus/);
    assert.match(migration, /get_stage2a_harmonized_code_form/);
    assert.match(migration, /get_stage2a_harmonization_provenance/);
    assert.match(migration, /exact_source_text/);
    assert.match(migration, /message_id/);
    assert.doesNotMatch(migration, /stage2a_categories/i);
    assert.doesNotMatch(migration, /stage2a_themes/i);
});

test("researcher form uses positional HCO headers without global column identity", async () => {
    const [html, script, dashboard] = await Promise.all([
        readFile(new URL("../staged-analysis.html", import.meta.url), "utf8"),
        readFile(new URL("../researcher-advanced-preliminary.js", import.meta.url), "utf8"),
        readFile(new URL("../server/advancedPreliminaryDashboard.js", import.meta.url), "utf8")
    ]);
    assert.match(html, /Cross-Case Code Harmonization/);
    assert.match(html, /Meaning Units and preliminary Codes remain\s+unchanged/);
    assert.match(script, /const headers = \["P#"\]/);
    assert.match(script, /headers\.push\(`HCO\$\{position\}`\)/);
    assert.match(script, /codes\[position\]\?\.label/);
    assert.match(script, /Preliminary code records \/ assignments/);
    assert.match(script, /Distinct preliminary code labels/);
    assert.match(script, /All cases included/);
    assert.match(script, /Legacy Stage 2A output used/);
    assert.match(script, /Input batching/);
    assert.match(script, /Paid harmonization calls/);
    assert.match(dashboard,
        /import \{[\s\S]*createAnalysisProviderClient,[\s\S]*\} from "\.\/analysisProvider\.js"/);
    assert.match(dashboard,
        /createAnalysisProviderClient\(stage1\.provider\)/);
});
