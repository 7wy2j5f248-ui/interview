import test from "node:test";
import assert from "node:assert/strict";
import { processCaseBoundAnalysisTick } from "../server/caseBoundAnalysis.js";

function completedOutput() {
    return JSON.stringify({
        meaning_units: [], preliminary_codes: [], preliminary_categories: [],
        preliminary_tentative_themes: []
    });
}

test("worker freezes the exact request before its single Stage 1 submission", async () => {
    const calls = [];
    const claim = {
        action: "submit", attemptId: "attempt-1", caseId: "case-1",
        caseNumber: "P00001", provider: "openai",
        sourceSha256: "a".repeat(64),
        sourceJson: {
            caseNumber: "P00001",
            analyticalTranscript: [{ turn_id: "T001", message_id: "m1", speaker: "participant", original_text: "Text", english_text: "Text" }]
        },
        configurationJson: {
            provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high",
            maxOutputTokens: 30000, projectContext: {}, globalRules: ["Use this case only."]
        }
    };
    const supabase = {
        async rpc(name) {
            calls.push(name);
            if (name === "claim_next_stage1_v2_attempt") return { data: claim, error: null };
            return { data: true, error: null };
        }
    };
    let submissions = 0;
    const client = { responses: {
        async create() {
            submissions += 1;
            assert.ok(calls.includes("freeze_stage1_v2_request"));
            return { id: "resp-1", status: "completed", output_text: completedOutput() };
        }
    } };
    const result = await processCaseBoundAnalysisTick(supabase, {
        providerClientFactory: () => client
    });
    assert.equal(submissions, 1);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, [
        "claim_next_stage1_v2_attempt", "freeze_stage1_v2_request",
        "record_stage1_v2_provider_response", "save_stage1_v2_presentation"
    ]);
});

test("a technical submission failure is frozen as failed and never retried", async () => {
    const calls = [];
    const supabase = {
        async rpc(name) {
            calls.push(name);
            if (name === "claim_next_stage1_v2_attempt") return {
                data: {
                    action: "submit", attemptId: "attempt-2", caseNumber: "P00002",
                    provider: "openai", sourceSha256: "b".repeat(64),
                    sourceJson: { caseNumber: "P00002", analyticalTranscript: [{ turn_id: "T001", message_id: "m2", speaker: "participant", original_text: "Text", english_text: "Text" }] },
                    configurationJson: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", maxOutputTokens: 30000, projectContext: {} }
                }, error: null
            };
            return { data: true, error: null };
        }
    };
    let submissions = 0;
    const client = { responses: { async create() { submissions += 1; throw new Error("network failed"); } } };
    const result = await processCaseBoundAnalysisTick(supabase, { providerClientFactory: () => client });
    assert.equal(submissions, 1);
    assert.equal(result.status, "failed");
    assert.equal(calls.filter(name => name === "fail_stage1_v2_attempt").length, 1);
    assert.equal(calls.includes("record_stage1_v2_provider_response"), false);
});

test("a persistence fault never relabels an obtained provider response as failed", async () => {
    const calls = [];
    const claim = {
        action: "retrieve", attemptId: "attempt-3", provider: "openai",
        providerResponseId: "resp-3"
    };
    const supabase = { async rpc(name) {
        calls.push(name);
        if (name === "claim_next_stage1_v2_attempt") return { data: claim, error: null };
        if (name === "record_stage1_v2_provider_response") return {
            data: null, error: new Error("storage unavailable")
        };
        return { data: true, error: null };
    } };
    const client = { responses: { async retrieve() {
        return { id: "resp-3", status: "completed", output_text: completedOutput() };
    } } };
    await assert.rejects(() => processCaseBoundAnalysisTick(supabase, {
        providerClientFactory: () => client
    }), /record_stage1_v2_provider_response failed/);
    assert.equal(calls.includes("fail_stage1_v2_attempt"), false);
});
