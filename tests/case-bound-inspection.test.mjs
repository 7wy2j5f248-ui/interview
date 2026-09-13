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

test("GPT-5.6 source-language MUs are located in the original message before its English translation", () => {
    const chineseSource = "我一般十点半左右上床，昨晚也差不多。";
    const inspection = buildCaseInspection({
        caseNumber: "P00171",
        storedMessages: [{
            id: "m1",
            Speaker: "participant",
            Language: "zh",
            Message: chineseSource,
            EnglishTranslation: "I usually go to bed around 10:30; last night was similar."
        }],
        presentation: {
            meaning_units: [{
                id: "MU1",
                sources: [{
                    message_id: "m1",
                    english_text: "我一般十点半左右上床"
                }]
            }],
            preliminary_codes: [{
                id: "CO1",
                label: "Usual bedtime",
                meaning_unit_ids: ["MU1"]
            }],
            preliminary_categories: [{
                id: "CA1",
                label: "Sleep timing",
                code_ids: ["CO1"]
            }],
            preliminary_tentative_themes: [{
                id: "TH1",
                statement: "Stable sleep schedule",
                category_ids: ["CA1"]
            }]
        }
    });
    const segment = inspection.report.meaningUnits[0].segments[0];
    assert.equal(segment.messageId, "m1");
    assert.equal(segment.textField, "original");
    assert.equal(segment.startOffset, 0);
    assert.equal(segment.endOffset, "我一般十点半左右上床".length);
    assert.equal(
        inspection.report.meaningUnits[0].englishText,
        "I usually go to bed around 10:30; last night was similar."
    );
    assert.deepEqual(
        inspection.report.meaningUnits[0].englishTextSources,
        ["stored_source_message_translation"]
    );
    assert.equal(inspection.report.meaningUnits[0].englishTextAvailable, true);
    assert.equal(inspection.counts.englishMeaningUnits, 1);
    assert.equal(inspection.counts.englishUnavailableMeaningUnits, 0);
    assert.equal(
        inspection.transcript[0].originalText.slice(
            segment.startOffset, segment.endOffset
        ),
        "我一般十点半左右上床"
    );
});

test("translated MUs remain inline with the matching translation beside the original message", () => {
    const inspection = buildCaseInspection({
        caseNumber: "P00001",
        storedMessages: [{
            id: "m1",
            Speaker: "participant",
            Language: "zh",
            Message: "昨晚睡得不好。",
            EnglishTranslation: "I did not sleep well last night."
        }],
        presentation: {
            meaning_units: [{
                id: "MU1",
                sources: [{
                    message_id: "m1",
                    english_text: "I did not sleep well last night."
                }]
            }],
            preliminary_codes: [],
            preliminary_categories: [],
            preliminary_tentative_themes: []
        }
    });
    const segment = inspection.report.meaningUnits[0].segments[0];
    assert.equal(segment.textField, "english");
    assert.equal(segment.startOffset, 0);
    assert.equal(segment.endOffset, "I did not sleep well last night.".length);
    assert.equal(
        inspection.report.meaningUnits[0].englishText,
        "I did not sleep well last night."
    );
    assert.deepEqual(
        inspection.report.meaningUnits[0].englishTextSources,
        ["exact_gpt56_english_mu"]
    );
});

test("a non-English MU without stored translation is disclosed instead of leaking into the English report", () => {
    const inspection = buildCaseInspection({
        caseNumber: "P00002",
        storedMessages: [{
            id: "m1", Speaker: "participant", Language: "zh",
            Message: "昨晚睡得不好。", EnglishTranslation: ""
        }],
        presentation: {
            meaning_units: [{
                id: "MU1",
                sources: [{ message_id: "m1", english_text: "昨晚睡得不好。" }]
            }],
            preliminary_codes: [],
            preliminary_categories: [],
            preliminary_tentative_themes: []
        }
    });
    assert.equal(
        inspection.report.meaningUnits[0].englishText,
        "English source evidence unavailable."
    );
    assert.equal(inspection.report.meaningUnits[0].englishTextAvailable, false);
    assert.equal(inspection.counts.englishMeaningUnits, 0);
    assert.equal(inspection.counts.englishUnavailableMeaningUnits, 1);
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
