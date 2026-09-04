import { createAnalysisProviderClient } from "./analysisProvider.js";
import {
    buildCaseBoundStage1Request,
    buildCaseBoundStage2ARequest,
    classifyProviderOutcome,
    explicitStage1Presentation,
    explicitStage2APresentation,
    providerResponseText
} from "./caseBoundAnalysisContract.js";

function rpcResult(data) {
    return Array.isArray(data) ? data[0] || null : data || null;
}

async function callRpc(supabase, name, parameters) {
    const { data, error } = parameters === undefined
        ? await supabase.rpc(name)
        : await supabase.rpc(name, parameters);
    if (error) {
        throw new Error(`Case-bound analysis operation ${name} failed.`, {
            cause: error
        });
    }
    return rpcResult(data);
}

function exactProviderRecord(response) {
    const value = typeof response?.toJSON === "function"
        ? response.toJSON() : response;
    return JSON.parse(JSON.stringify(value ?? null));
}

function technicalMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

async function saveStage1Outcome(supabase, claim, response) {
    const outcome = classifyProviderOutcome(response);
    const rawText = providerResponseText(response);
    await callRpc(supabase, "record_stage1_v2_provider_response", {
        p_attempt_id: claim.attemptId,
        p_outcome: outcome,
        p_provider_response_id: response?.id || null,
        p_provider_status: response?.status || null,
        p_provider_response_json: outcome === "provider_pending"
            ? null : exactProviderRecord(response),
        p_raw_model_output_text: outcome === "provider_pending" ? null : rawText,
        p_incomplete_details: response?.incomplete_details || null,
        p_technical_error: response?.error?.message || null
    });

    if (outcome !== "completed") {
        return {
            claimed: true,
            layer: "stage1",
            status: outcome,
            active: outcome === "provider_pending"
        };
    }

    let presentation = null;
    let materializationError = null;
    try {
        presentation = explicitStage1Presentation(rawText);
    } catch (error) {
        materializationError = technicalMessage(error);
    }
    await callRpc(supabase, "save_stage1_v2_presentation", {
        p_attempt_id: claim.attemptId,
        p_presentation_json: presentation,
        p_materialization_error: materializationError
    });

    return { claimed: true, layer: "stage1", status: "completed", active: false };
}

async function processStage1Claim(supabase, claim, providerClientFactory) {
    let response;
    try {
        const client = providerClientFactory(claim.provider);
        if (claim.action === "retrieve") {
            if (!claim.providerResponseId) {
                throw new Error("The pending Stage 1 response has no provider response ID.");
            }
            response = await client.responses.retrieve(claim.providerResponseId);
        } else {
            const source = {
                ...claim.sourceJson,
                sourceSha256: claim.sourceSha256
            };
            const configuration = claim.configurationJson;
            const frozen = buildCaseBoundStage1Request(source, configuration);
            await callRpc(supabase, "freeze_stage1_v2_request", {
                p_attempt_id: claim.attemptId,
                p_provider_request_id: frozen.requestId,
                p_request_json: frozen.request,
                p_request_sha256: frozen.requestSha256
            });
            response = await client.responses.create(frozen.request, {
                idempotencyKey: `pli-case-bound-stage1-${claim.attemptId}`
            });
        }
    } catch (error) {
        await callRpc(supabase, "fail_stage1_v2_attempt", {
            p_attempt_id: claim.attemptId,
            p_technical_error: technicalMessage(error)
        });
        return { claimed: true, layer: "stage1", status: "failed", active: false };
    }
    // Provider output persistence is outside the provider-error handler. A
    // storage fault must never relabel or discard a response we already hold.
    return saveStage1Outcome(supabase, claim, response);
}

async function saveStage2Outcome(supabase, claim, response) {
    const outcome = classifyProviderOutcome(response);
    const rawText = providerResponseText(response);
    await callRpc(supabase, "record_stage2_v2_provider_response", {
        p_run_id: claim.runId,
        p_outcome: outcome,
        p_provider_response_id: response?.id || null,
        p_provider_status: response?.status || null,
        p_provider_response_json: outcome === "provider_pending"
            ? null : exactProviderRecord(response),
        p_raw_model_output_text: outcome === "provider_pending" ? null : rawText,
        p_incomplete_details: response?.incomplete_details || null,
        p_technical_error: response?.error?.message || null
    });
    if (outcome !== "completed") {
        return {
            claimed: true,
            layer: "stage2a",
            status: outcome,
            active: outcome === "provider_pending"
        };
    }
    let presentation = null;
    let materializationError = null;
    try {
        presentation = explicitStage2APresentation(rawText);
    } catch (error) {
        materializationError = technicalMessage(error);
    }
    await callRpc(supabase, "save_stage2_v2_presentation", {
        p_run_id: claim.runId,
        p_presentation_json: presentation,
        p_materialization_error: materializationError
    });
    return { claimed: true, layer: "stage2a", status: "completed", active: false };
}

async function processStage2Claim(supabase, claim, providerClientFactory) {
    let response;
    try {
        const client = providerClientFactory(claim.provider);
        if (claim.action === "retrieve") {
            if (!claim.providerResponseId) {
                throw new Error("The pending Stage 2A response has no provider response ID.");
            }
            response = await client.responses.retrieve(claim.providerResponseId);
        } else {
            const corpus = {
                ...claim.corpusSnapshotJson,
                corpusSha256: claim.corpusSnapshotSha256
            };
            const frozen = buildCaseBoundStage2ARequest(corpus, {
                model: claim.model,
                reasoningEffort: claim.reasoningEffort,
                maxOutputTokens: claim.maxOutputTokens
            });
            await callRpc(supabase, "freeze_stage2_v2_request", {
                p_run_id: claim.runId,
                p_provider_request_id: frozen.requestId,
                p_request_json: frozen.request,
                p_request_sha256: frozen.requestSha256
            });
            response = await client.responses.create(frozen.request, {
                idempotencyKey: `pli-whole-cohort-stage2a-${claim.runId}`
            });
        }
    } catch (error) {
        await callRpc(supabase, "fail_stage2_v2_run", {
            p_run_id: claim.runId,
            p_technical_error: technicalMessage(error)
        });
        return { claimed: true, layer: "stage2a", status: "failed", active: false };
    }
    return saveStage2Outcome(supabase, claim, response);
}

export async function processCaseBoundAnalysisTick(
    supabase,
    {
        providerClientFactory = provider =>
            createAnalysisProviderClient(provider).client
    } = {}
) {
    const stage1Claim = await callRpc(supabase, "claim_next_stage1_v2_attempt");
    if (stage1Claim) {
        return processStage1Claim(supabase, stage1Claim, providerClientFactory);
    }
    const stage2Claim = await callRpc(supabase, "claim_next_stage2_v2_run");
    if (stage2Claim) {
        return processStage2Claim(supabase, stage2Claim, providerClientFactory);
    }
    return { claimed: false, active: false };
}
