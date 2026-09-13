import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    buildCaseInspection,
    normalizePilotReport
} from "../server/caseBoundInspection.js";

test("readable Stage 1 report preserves connected GPT-5.6 hierarchy and counts", () => {
    const raw = JSON.stringify({ source: "frozen GPT-5.6 response" });
    const responseHash = createHash("sha256").update(raw).digest("hex");
    const presentation = {
        meaning_units: [
            { id: "MU001", sources: [{ message_id: "m1", english_text: "Sleep is difficult." }] },
            { id: "MU002", sources: [{ message_id: "m1", english_text: "I wake up early." }] }
        ],
        preliminary_codes: [{
            id: "CO001", label: "Disrupted sleep",
            meaning_unit_ids: ["MU001", "MU002"]
        }],
        preliminary_categories: [{
            id: "CA001", label: "Sleep difficulty", code_ids: ["CO001"]
        }],
        preliminary_tentative_themes: [{
            id: "TH001", statement: "Sleep is persistently disrupted",
            category_ids: ["CA001"]
        }]
    };
    const inspection = buildCaseInspection({
        caseNumber: "P00171",
        storedMessages: [{
            id: "m1", Speaker: "participant", Language: "en",
            Message: "Sleep is difficult. I wake up early.",
            EnglishTranslation: "Sleep is difficult. I wake up early."
        }],
        presentation,
        attempt: { attempt_number: 1, provider_status: "incomplete", raw_model_output_text: raw },
        submittedReport: {
            provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "high",
            provider_status: "incomplete", source_kind: "frozen_gpt56_response_projection",
            source_response_sha256: responseHash, report_sha256: "b".repeat(64)
        }
    });
    assert.equal(inspection.caseNumber, "P00171");
    assert.equal(inspection.report.codes[0].mentionCount, 2);
    assert.deepEqual(inspection.report.categories[0].meaningUnitIds, ["MU001", "MU002"]);
    assert.deepEqual(inspection.report.themes[0].codeIds, ["CO001"]);
    assert.equal(inspection.provenance.model, "gpt-5.6-sol");
    assert.equal(inspection.provenance.reasoningEffort, "high");
    assert.equal(inspection.provenance.sourceResponseHashMatches, true);
    assert.equal(inspection.readOnly, true);
    assert.equal(inspection.affectsProgression, false);
});

test("legacy GPT-5.6 raw field names produce no blank tentative Theme", () => {
    const raw = JSON.stringify({
        meaning_units: [{ meaning_unit_number: 1, message_id: "m1", exact_source_text: "Text" }],
        preliminary_codes: [{ code_number: 1, code: "Code", meaning_unit_numbers: [1] }],
        preliminary_categories: [{ category_number: 1, category: "Category", code_numbers: [1] }],
        preliminary_tentative_themes: [{
            tentative_theme_number: 1,
            tentative_theme: "Theme from GPT-5.6",
            category_numbers: [1]
        }]
    });
    const inspection = buildCaseInspection({
        caseNumber: "P00175",
        storedMessages: [{ id: "m1", Speaker: "participant", Message: "Text" }],
        attempt: { raw_model_output_text: raw }
    });
    assert.equal(inspection.report.themes[0].statement, "Theme from GPT-5.6");
    assert.equal(inspection.report.meaningUnits.length, 1);
    assert.equal(inspection.report.codes.length, 1);
    assert.equal(inspection.report.categories.length, 1);
    assert.equal(inspection.report.themes.length, 1);
});

test("normalized pilot rows keep stored relationships without analytical invention", () => {
    const report = normalizePilotReport({
        meaningUnits: [{ id: "mu-record", unit_number: 1, message_id: "m1", exact_source_text: "Text", start_offset: 0, end_offset: 4 }],
        codes: [{ id: "co-record", code_number: 1, code_label: "Code", occurrence_count: 1 }],
        codeMeaningUnits: [{ code_id: "co-record", meaning_unit_id: "mu-record" }],
        categories: [{ id: "ca-record", category_number: 1, category_label: "Category" }],
        categoryCodes: [{ category_id: "ca-record", code_id: "co-record" }],
        themes: [{ id: "th-record", theme_number: 1, theme_label: "Theme" }],
        themeCategories: [{ theme_id: "th-record", category_id: "ca-record" }]
    });
    assert.deepEqual(report.codes[0].meaningUnitIds, ["MU1"]);
    assert.deepEqual(report.categories[0].codeIds, ["CO1"]);
    assert.deepEqual(report.themes[0].categoryIds, ["CA1"]);
});
