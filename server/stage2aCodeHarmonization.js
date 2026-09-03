export const STAGE2A_ANALYSIS_VERSION =
    "stage2a-cross-case-code-harmonization-v1";
export const STAGE2A_PROMPT_VERSION =
    "stage2a-whole-corpus-harmonization-prompt-v1";
export const STAGE2A_STOP_LAYER = "harmonized_codes";

const MODEL_LIMITS = Object.freeze({
    "gpt-5.6-sol": { contextWindow: 1_050_000, maximumOutput: 128_000 },
    "gpt-5.6-terra": { contextWindow: 1_050_000, maximumOutput: 128_000 },
    "gpt-5.6-luna": { contextWindow: 1_050_000, maximumOutput: 128_000 }
});

export const HARMONIZATION_SCHEMA = {
    type: "object",
    properties: {
        harmonized_codes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    definition: { type: "string" },
                    semantic_basis: { type: "string" }
                },
                required: ["id", "label", "definition", "semantic_basis"],
                additionalProperties: false
            }
        },
        cases: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    p: { type: "string" },
                    hco_ids: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                required: ["p", "hco_ids"],
                additionalProperties: false
            }
        }
    },
    required: ["harmonized_codes", "cases"],
    additionalProperties: false
};

function responseText(response) {
    return response?.output_text
        || response?.output?.flatMap(item => item?.content || [])
            .find(item => typeof item?.text === "string")?.text
        || "";
}

export function stage2AModelLimits(model) {
    return MODEL_LIMITS[String(model || "").trim()] || null;
}

function harmonizationInstructions() {
    return [
        "Perform only Stage 2A: Cross-Case Code Harmonization.",
        "The complete analytical input is one JSON array. Every item has exactly two fields: p (the local participant/case identifier) and co (that case's ordered array of preliminary Code labels). No transcript, Meaning Unit, demographic, Category, Theme, annotated transcript, interview message, raw Stage 1 report, prior Stage 2A result, or other contextual material is supplied.",
        "Treat the complete supplied preliminary-Code corpus as one cross-case comparative analytical unit. Read and compare the entire corpus together. Do not divide it into batches, sequential subsets, samples, pages, or case-by-case vocabulary accumulation.",
        "Compare preliminary Codes semantically. Harmonize terminology only when the expressed analytical concepts are the same or sufficiently equivalent. Similar wording alone is not enough. Do not force genuinely different meanings into one Harmonized Code merely to reduce quantity. Do not merely shorten labels.",
        "Create a shared cross-case Harmonized Code vocabulary. Several preliminary Codes may map to one Harmonized Code. Let the number of Harmonized Codes emerge from the comparison; there is no target count.",
        "Give every Harmonized Code a stable response-local id such as HCO0001. Return every supplied p exactly once. For each p, return an hco_ids array with exactly the same length and order as its supplied co array; each position maps that preliminary Code to one stable Harmonized Code id. A case with an empty co array must have an empty hco_ids array.",
        "Preserve every original preliminary Code. Do not rewrite, overwrite, regenerate, delete, or replace it.",
        "Do not regenerate preliminary analysis. Do not create or refine Categories. Do not create Themes. Do not validate, audit, repair, approve, reject, exclude, replace, score, or review any case or earlier model output.",
        "HCO1, HCO2, and later columns are display positions within each case only. Cross-case identity is the stable Harmonized Code id and label, never the position in a case.",
        "Stop after Harmonized Codes and their mappings. Output only the requested structured Harmonized Code vocabulary and positional case mappings."
    ].join("\n\n");
}

export function buildStage2AResponseOptions(run, corpus) {
    const executionModel = run.resolved_model || run.model;
    return {
        model: executionModel,
        store: true,
        background: true,
        truncation: "disabled",
        max_output_tokens: stage2AModelLimits(executionModel)?.maximumOutput || 128_000,
        reasoning: {
            effort: run.reasoning_effort,
            context: "current_turn"
        },
        text: {
            verbosity: "medium",
            format: {
                type: "json_schema",
                name: "stage2a_whole_corpus_code_harmonization",
                strict: true,
                schema: HARMONIZATION_SCHEMA
            }
        },
        instructions: harmonizationInstructions(),
        input: [{
            role: "user",
            content: [{
                type: "input_text",
                text: JSON.stringify(corpus)
            }]
        }]
    };
}

function tokenCountOptions(options) {
    const {
        background: _background,
        store: _store,
        truncation: _truncation,
        max_output_tokens: _maximumOutput,
        ...counted
    } = options;
    return counted;
}

async function loadRun(supabase, runId) {
    const { data, error } = await supabase
        .from("stage2a_code_harmonization_runs")
        .select("id, stage1_run_id, project_id, status, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, stop_layer, rules_snapshot, source_case_count, preliminary_code_count, code_meaning_unit_link_count, context_window_tokens, reserved_output_tokens, input_token_count, output_token_count, provider_response_id, requested_at, started_at, completed_at, updated_at, last_error")
        .eq("id", runId)
        .maybeSingle();
    if (error || !data) throw new Error("The Stage 2A run could not be loaded.");
    return data;
}

async function loadCorpus(supabase, runId) {
    const { data, error } = await supabase.rpc(
        "get_stage2a_harmonization_corpus",
        { p_stage1_run_id: runId }
    );
    if (error || !Array.isArray(data) || !data.length) {
        throw new Error("The complete preliminary-Code corpus could not be loaded.");
    }
    return data;
}

async function setRun(supabase, runId, values) {
    const { error } = await supabase
        .from("stage2a_code_harmonization_runs")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", runId);
    if (error) throw new Error("Stage 2A progress could not be saved.", { cause: error });
}

async function startWholeCorpusResponse(supabase, openaiClient, run) {
    const executionModel = run.resolved_model || run.model;
    const limits = stage2AModelLimits(executionModel);
    if (!limits) {
        const message = `Exact provider context limit is not configured for ${executionModel}; Stage 2A stopped before harmonization and no alternative was attempted.`;
        await setRun(supabase, run.id, {
            status: "context_limit_unknown",
            last_error: message
        });
        return { active: false, status: "context_limit_unknown", message };
    }

    const { data: claimed, error: claimError } = await supabase
        .from("stage2a_code_harmonization_runs")
        .update({ status: "counting_context", started_at: new Date().toISOString() })
        .eq("id", run.id)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
    if (claimError) throw new Error("Stage 2A could not begin its context count.");
    if (!claimed) return { active: true, status: run.status };

    const corpus = await loadCorpus(supabase, run.stage1_run_id);
    const options = buildStage2AResponseOptions(run, corpus);
    const counted = await openaiClient.post("/responses/input_tokens", {
        body: tokenCountOptions(options)
    });
    const inputTokens = Number(counted?.input_tokens);
    if (!Number.isInteger(inputTokens) || inputTokens < 1) {
        throw new Error("The provider did not return an exact Stage 2A input-token count.");
    }

    const fits = inputTokens + limits.maximumOutput <= limits.contextWindow;
    await setRun(supabase, run.id, {
        context_window_tokens: limits.contextWindow,
        reserved_output_tokens: limits.maximumOutput,
        input_token_count: inputTokens,
        status: fits ? "context_counted" : "context_limit_exceeded",
        last_error: fits ? null
            : `Whole-corpus input ${inputTokens} tokens plus ${limits.maximumOutput} reserved output tokens exceeds the ${limits.contextWindow}-token context window for ${executionModel}. Stage 2A stopped before harmonization; no batching or alternative was attempted.`
    });
    if (!fits) return { active: false, status: "context_limit_exceeded" };

    const response = await openaiClient.responses.create(options);
    await setRun(supabase, run.id, {
        status: ["queued", "in_progress"].includes(response?.status)
            ? "processing" : "submitted",
        provider_response_id: response?.id || null
    });
    if (!response?.id) {
        throw new Error("The provider did not return a Stage 2A response ID.");
    }
    return { active: true, status: response.status, responseId: response.id };
}

async function submitCountedWholeCorpusResponse(
    supabase,
    openaiClient,
    run
) {
    const { data: claimed, error: claimError } = await supabase
        .from("stage2a_code_harmonization_runs")
        .update({ status: "submitting", updated_at: new Date().toISOString() })
        .eq("id", run.id)
        .eq("status", "context_counted")
        .select("id")
        .maybeSingle();
    if (claimError) throw new Error("Stage 2A could not submit its counted corpus.");
    if (!claimed) return { active: true, status: run.status };
    const corpus = await loadCorpus(supabase, run.stage1_run_id);
    const response = await openaiClient.responses.create(
        buildStage2AResponseOptions(run, corpus)
    );
    if (!response?.id) {
        throw new Error("The provider did not return a Stage 2A response ID.");
    }
    await setRun(supabase, run.id, {
        status: ["queued", "in_progress"].includes(response?.status)
            ? "processing" : "submitted",
        provider_response_id: response.id
    });
    return { active: true, status: response.status, responseId: response.id };
}

export async function countStage2AInputTokens(openaiClient, run, corpus) {
    const options = buildStage2AResponseOptions(run, corpus);
    const counted = await openaiClient.post("/responses/input_tokens", {
        body: tokenCountOptions(options)
    });
    const inputTokens = Number(counted?.input_tokens);
    if (!Number.isInteger(inputTokens) || inputTokens < 1) {
        throw new Error("The provider did not return an exact Stage 2A input-token count.");
    }
    return inputTokens;
}

async function finishWholeCorpusResponse(supabase, run, response) {
    const raw = responseText(response);
    let output;
    try {
        output = JSON.parse(raw);
    } catch (error) {
        await setRun(supabase, run.id, {
            status: "failed_technical",
            raw_model_output_text: raw || null,
            last_error: "The single Stage 2A provider response was not parseable structured data. It was preserved without repair or another model call."
        });
        return { active: false, status: "failed_technical" };
    }
    const { data: saved, error } = await supabase.rpc(
        "complete_stage2a_code_harmonization",
        {
            p_run_id: run.id,
            p_output: output,
            p_raw_output: raw,
            p_input_tokens: response?.usage?.input_tokens
                || run.input_token_count || 0,
            p_output_tokens: response?.usage?.output_tokens || 0
        }
    );
    if (error || !saved) {
        throw new Error("The completed Stage 2A output could not be projected into its provenance tables.");
    }
    return { active: false, status: "completed", runId: run.id };
}

async function pollWholeCorpusResponse(supabase, openaiClient, run) {
    if (!run.provider_response_id) {
        throw new Error("The active Stage 2A run has no provider response ID.");
    }
    const response = await openaiClient.responses.retrieve(run.provider_response_id);
    if (["queued", "in_progress"].includes(response?.status)) {
        await setRun(supabase, run.id, { status: "processing" });
        return { active: true, status: response.status, responseId: response.id };
    }
    if (response?.status === "completed") {
        return finishWholeCorpusResponse(supabase, run, response);
    }
    const raw = responseText(response);
    await setRun(supabase, run.id, {
        status: "failed_technical",
        raw_model_output_text: raw || null,
        output_token_count: response?.usage?.output_tokens || 0,
        last_error: `The single Stage 2A provider response ended with status ${response?.status || "unknown"}. It was preserved without repair, validation, or another model call.`
    });
    return { active: false, status: "failed_technical" };
}

export async function processStage2ACodeHarmonization(
    supabase,
    openaiClient,
    runId
) {
    const run = await loadRun(supabase, runId);
    if (run.status === "queued") {
        try {
            return await startWholeCorpusResponse(supabase, openaiClient, run);
        } catch (error) {
            await setRun(supabase, run.id, {
                status: "failed_technical",
                last_error: error instanceof Error ? error.message : String(error)
            });
            return { active: false, status: "failed_technical", runId: run.id };
        }
    }
    if (run.status === "context_counted") {
        try {
            return await submitCountedWholeCorpusResponse(
                supabase,
                openaiClient,
                run
            );
        } catch (error) {
            await setRun(supabase, run.id, {
                status: "failed_technical",
                last_error: error instanceof Error ? error.message : String(error)
            });
            return { active: false, status: "failed_technical", runId: run.id };
        }
    }
    if (["submitted", "processing"].includes(run.status)) {
        try {
            return await pollWholeCorpusResponse(supabase, openaiClient, run);
        } catch (error) {
            await setRun(supabase, run.id, {
                status: "failed_technical",
                last_error: error instanceof Error ? error.message : String(error)
            });
            return { active: false, status: "failed_technical", runId: run.id };
        }
    }
    return {
        active: false,
        status: run.status,
        runId: run.id,
        message: run.last_error || null
    };
}
