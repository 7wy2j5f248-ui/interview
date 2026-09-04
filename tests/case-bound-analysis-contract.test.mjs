import test from "node:test";
import assert from "node:assert/strict";
import {
    buildCaseBoundStage1Request,
    buildCaseBoundStage2ARequest,
    classifyProviderOutcome,
    explicitStage1Presentation,
    stage1ContractSnapshot
} from "../server/caseBoundAnalysisContract.js";

const configuration = {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxOutputTokens: 30000,
    projectContext: { project_name: "Example", research_topic: "Sleep" },
    analysisSpecificGuidelines: ""
};

test("Stage 1 freezes one complete case and one connected MU to TH contract", () => {
    const source = {
        caseNumber: "P00001",
        sourceSha256: "a".repeat(64),
        analyticalTranscript: [
            { turn_id: "T001", message_id: "m1", speaker: "interviewer", original_text: "How do you sleep?", english_text: "How do you sleep?" },
            { turn_id: "T002", message_id: "m2", speaker: "participant", original_text: "Badly.", english_text: "Badly." }
        ]
    };
    const first = buildCaseBoundStage1Request(source, configuration, {
        requestId: "fixed-request"
    });
    const second = buildCaseBoundStage1Request(source, configuration, {
        requestId: "fixed-request"
    });
    assert.deepEqual(first, second);
    assert.equal(first.request.model, "gpt-5.6-sol");
    assert.equal(first.request.reasoning.effort, "high");
    assert.equal(first.request.max_output_tokens, 30000);
    assert.equal(first.request.text.format.strict, true);
    assert.match(first.request.input[1].content, /"speaker":"interviewer"/);
    assert.match(first.request.input[1].content, /"speaker":"participant"/);
    assert.deepEqual(first.request.text.format.schema.required, [
        "meaning_units", "preliminary_codes", "preliminary_categories",
        "preliminary_tentative_themes"
    ]);
});

test("provider outcome is classified only from objective provider status", () => {
    assert.equal(classifyProviderOutcome({ status: "completed", output_text: "bad analysis" }), "completed");
    assert.equal(classifyProviderOutcome({ status: "incomplete", output_text: "excellent analysis" }), "technically_incomplete");
    assert.equal(classifyProviderOutcome({ status: "failed" }), "failed");
    assert.equal(classifyProviderOutcome({ status: "cancelled" }), "failed");
    assert.equal(classifyProviderOutcome({ status: "in_progress" }), "provider_pending");
});

test("presentation copies explicit provider fields without inventing hierarchy", () => {
    const payload = {
        meaning_units: [{ id: "MU001", sources: [{ turn_id: "T002", message_id: "m2", english_text: "Badly." }] }],
        preliminary_codes: [{ id: "CO001", label: "Poor sleep", meaning_unit_ids: ["MU001"] }],
        preliminary_categories: [{ id: "CA001", label: "Sleep quality", code_ids: ["CO001"] }],
        preliminary_tentative_themes: [{ id: "TH001", statement: "Difficult sleep", category_ids: ["CA001"] }]
    };
    assert.deepEqual(explicitStage1Presentation(JSON.stringify(payload)), payload);
});

test("configuration snapshot freezes researcher selections and all global rules", () => {
    const result = stage1ContractSnapshot(configuration);
    assert.equal(result.snapshot.provider, "openai");
    assert.equal(result.snapshot.model, "gpt-5.6-sol");
    assert.ok(result.snapshot.globalRules.length >= 10);
    assert.match(result.snapshot.configurationSha256 || result.snapshotSha256, /^[0-9a-f]{64}$/);
});

test("Stage 2A frozen source is only whole-cohort P# plus preliminary CO", () => {
    const frozen = buildCaseBoundStage2ARequest({
        cohortId: "cohort-1",
        corpusSha256: "b".repeat(64),
        cases: [{
            case_id: "P00001",
            preliminary_codes: [{ code_id: "CO001", label: "Poor sleep" }]
        }]
    }, configuration, { requestId: "stage2-fixed" });
    const supplied = JSON.parse(frozen.request.input[0].content
        .split("FROZEN WHOLE-COHORT P# + PRELIMINARY CO SOURCE\n")[1]);
    assert.deepEqual(Object.keys(supplied).sort(), ["cases", "cohort_id", "corpus_sha256"]);
    assert.deepEqual(Object.keys(supplied.cases[0]).sort(), ["case_id", "preliminary_codes"]);
    assert.deepEqual(Object.keys(supplied.cases[0].preliminary_codes[0]).sort(), ["code_id", "label"]);
});
