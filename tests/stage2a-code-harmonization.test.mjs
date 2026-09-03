import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    buildStage2AResponseOptions,
    HARMONIZATION_SCHEMA,
    stage2AModelLimits
} from "../server/stage2aCodeHarmonization.js";

const migrationPath = new URL(
    "../supabase/migrations/20260903001240_enforce_stage2a_p_and_co_checkpoint.sql",
    import.meta.url
);

test("Stage 2A sends one complete cross-case corpus and stops at Harmonized Codes", () => {
    const corpus = [{ p: "P001", co: ["Late sleeping time"] }];
    const options = buildStage2AResponseOptions({
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
    }, corpus);

    assert.equal(options.input.length, 1);
    assert.equal(options.truncation, "disabled");
    assert.equal(options.max_output_tokens, 128_000);
    assert.match(options.instructions, /entire corpus together/i);
    assert.match(options.instructions, /Do not divide it into batches/i);
    assert.match(options.instructions, /Do not create or refine Categories/i);
    assert.match(options.instructions, /Do not create Themes/i);
    assert.match(options.instructions, /input.*exactly two fields: p.*co/is);
    assert.match(options.instructions, /Do not force genuinely different meanings/i);
    assert.match(options.input[0].content[0].text, /Late sleeping time/);
    const sent = JSON.parse(options.input[0].content[0].text);
    assert.deepEqual(Object.keys(sent[0]).sort(), ["co", "p"]);
    assert.deepEqual(sent, corpus);
    assert.doesNotMatch(options.input[0].content[0].text,
        /meaning_unit|transcript|demographic|category|theme|preliminary_code_id/i);
});

test("Stage 2A output schema maps preliminary Codes to emergent HCOs", () => {
    assert.deepEqual(HARMONIZATION_SCHEMA.required, ["harmonized_codes", "cases"]);
    const item = HARMONIZATION_SCHEMA.properties.harmonized_codes.items;
    assert.deepEqual(item.required, [
        "id", "label", "definition", "semantic_basis"
    ]);
    assert.equal(HARMONIZATION_SCHEMA.properties.cases.items
        .properties.hco_ids.type, "array");
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
    assert.match(migration, /pre_call_snapshot/);
    assert.match(migration, /get_stage2a_harmonization_corpus/);
    assert.match(migration, /get_stage2a_harmonized_code_form/);
    assert.match(migration, /get_stage2a_harmonization_provenance/);
    assert.match(migration, /stage1_preliminary_codes/);
    assert.match(migration, /stage1_preliminary_meaning_units/);
    assert.match(migration, /source_message_id/);
    assert.match(migration, /'p', form\.case_number/);
    assert.match(migration, /'co', coalesce/);
    assert.doesNotMatch(migration,
        /'demographics'|'meaning_units'|'categories'|'themes'/i);
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
    assert.match(script, /Total Stage 1 cases/);
    assert.match(script, /Cases represented in the CO input/);
    assert.match(script, /Total preliminary CO records\/assignments/);
    assert.match(script, /Distinct preliminary CO labels/);
    assert.match(script, /All 275 cases represented/);
    assert.match(script, /Input fields sent to model/);
    assert.match(script, /Legacy Stage 2A output used/);
    assert.match(script, /Demographic information sent/);
    assert.match(script, /MU information sent/);
    assert.match(script, /Category information sent/);
    assert.match(script, /Theme information sent/);
    assert.match(script, /Selected provider\/model/);
    assert.match(script, /Selected reasoning configuration/);
    assert.match(script, /Exact provider input-token count/);
    assert.match(script, /Planned paid harmonization calls/);
    assert.doesNotMatch(html, /crossCaseCodeExecuteButton/);
    assert.match(dashboard,
        /import \{[\s\S]*createAnalysisProviderClient,[\s\S]*\} from "\.\/analysisProvider\.js"/);
    assert.match(dashboard,
        /createAnalysisProviderClient\(provider\)/);
    assert.match(dashboard, /awaiting_researcher_approval/);
    assert.match(dashboard, /No paid Stage 2A harmonization call is authorized/);
});
