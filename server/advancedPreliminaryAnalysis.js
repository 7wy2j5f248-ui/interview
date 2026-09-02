import { prepareParticipantMessages } from "./stagedTranscript.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { normalizeAnalysisModel } from "./modelConfiguration.js";
import { createAnalysisProviderClient } from "./analysisProvider.js";

export const ADVANCED_PRELIMINARY_REASONING_EFFORT = "high";
export const ADVANCED_PRELIMINARY_ANALYSIS_VERSION =
    "preliminary-case-analysis-v5-exact-first-response";
export const ADVANCED_PRELIMINARY_PROMPT_VERSION =
    "preliminary-case-analysis-prompt-v5-minimal-independent";
export const ADVANCED_PRELIMINARY_STOP_LAYER = "exact_first_response";
export const SLEEPING_HABITS_PROJECT_CODE = "SLEEPING-HABITS";
export const FRESH_ANALYSIS_OPERATION = "fresh_independent_analysis";
export const AUTHORITATIVE_SOURCE = "original_completed_transcripts";
export const LEGACY_ANALYSIS_INPUT = "excluded";
export const EXECUTION_CONTRACT_VERSION =
    "researcher-operation-contract-v2-exact-output-only";
export const DEFAULT_ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS = 40000;

function configuredPositiveInteger(environment, name, fallback) {
    const configured = environment[name];
    if (configured === undefined || configured === null
        || String(configured).trim() === "") {
        return fallback;
    }
    const normalized = String(configured).trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return Number(normalized);
}

export function configuredAdvancedPreliminaryMaxOutputTokens(
    environment = process.env
) {
    return configuredPositiveInteger(
        environment,
        "ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS",
        DEFAULT_ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS
    );
}

export function configuredAdvancedPreliminaryWorkerConcurrency(
    environment = process.env
) {
    const configured = environment.ADVANCED_PRELIMINARY_WORKER_CONCURRENCY;
    if (configured === undefined || configured === null
        || String(configured).trim() === "") {
        return null;
    }
    return configuredPositiveInteger(
        environment, "ADVANCED_PRELIMINARY_WORKER_CONCURRENCY", null
    );
}

export function availableAdvancedPreliminaryWorkerConcurrency(run) {
    const sourceCaseCount = Number(run?.source_case_count);
    const completedCount = Number(run?.completed_count);
    if (!Number.isFinite(sourceCaseCount) || sourceCaseCount < 1) return 1;
    if (!Number.isFinite(completedCount) || completedCount < 0) {
        return Math.max(1, Math.floor(sourceCaseCount));
    }
    return Math.max(
        1,
        Math.floor(sourceCaseCount) - Math.floor(completedCount)
    );
}

function responseText(response) {
    if (typeof response?.output_text === "string") {
        return response.output_text;
    }
    return (response?.output || []).flatMap(item =>
        (item?.content || [])
            .map(content => content?.text)
            .filter(value => typeof value === "string")
    ).join("");
}

function transcriptForModel(messages) {
    return JSON.stringify(messages.map(message => ({
        message_id: message.id,
        language: message.language,
        original_text: message.originalText,
        english_translation: message.englishTranslation
    })));
}

function analysisInstruction({
    projectName,
    researchTopic,
    operationType = FRESH_ANALYSIS_OPERATION
}) {
    const scope = researchTopic || "Sleeping habits";
    return [
        `Execution operation: ${operationType}. Authoritative source: ${AUTHORITATIVE_SOURCE}. Legacy analytical inputs: ${LEGACY_ANALYSIS_INPUT}.`,
        "Perform one complete first-pass Preliminary Case-Based Analysis for exactly one completed interview independently from its original transcript. Include the Meaning Units, preliminary Codes, preliminary Categories, preliminary Tentative Themes, and case summary that you judge appropriate.",
        `Research project: ${projectName || "Historical sleeping-habits dataset"}. Research topic/scope: ${scope}.`,
        "Do not compare this participant with another case and do not use earlier analytical output, a corpus vocabulary, or a predetermined global codebook.",
        "Return your analysis directly. The platform will preserve and show this exact first response without validation, scoring, repair, retry, parsing, normalization, hierarchy projection, or reconstruction."
    ].join("\n\n");
}

function responseOptions(model, reasoningEffort, schema, name, input, background = false) {
    return {
        model,
        store: background,
        background,
        max_output_tokens: configuredAdvancedPreliminaryMaxOutputTokens(),
        reasoning: {
            effort: reasoningEffort,
            context: "current_turn"
        },
        text: schema ? {
            verbosity: "medium",
            format: { type: "json_schema", name, strict: true, schema }
        } : { verbosity: "medium" },
        input
    };
}

function analysisInput(messages, context) {
    return [
        { role: "system", content: analysisInstruction(context) },
        {
            role: "user",
            content: `Original participant transcript (JSON):\n${transcriptForModel(messages)}`
        }
    ];
}

function preservedOutputFromResponse(response, normalizedModel) {
    const rawModelOutputText = responseText(response);
    const providerStatus = response?.status || "unknown";
    return {
        rawModelOutputText,
        audit: {
            reviewStatus: "exact_first_response_preserved",
            validationType: "none_no_analytical_validator",
            relationalProjectionType: "none_removed",
            priorAnalysisUsed: false,
            aiAnalysisPassCount: 1,
            stage1Only: true,
            providerStatus,
            providerIncompleteDetails: response?.incomplete_details || null,
            providerError: response?.error || null,
            overallSummary: `Exact first response from ${normalizedModel} preserved with provider status ${providerStatus}; no prior analysis, model probe, validator, scoring, repair, retry, parsing, normalization, projection, reconstruction, or per-case approval.`
        },
        inputTokenCount: response?.usage?.input_tokens || null,
        outputTokenCount: response?.usage?.output_tokens || null
    };
}

export async function generateAdvancedPreliminaryAnalysis(
    analysisClient,
    messages,
    context,
    {
        model,
        reasoningEffort = ADVANCED_PRELIMINARY_REASONING_EFFORT
    } = {}
) {
    const normalizedModel = normalizeAnalysisModel(model);
    const input = analysisInput(messages, context);
    const response = await analysisClient.responses.create(responseOptions(
        normalizedModel,
        reasoningEffort,
        null,
        "advanced_preliminary_case_analysis",
        input
    ));
    return preservedOutputFromResponse(response, normalizedModel);
}

async function savePreservedModelOutput(supabase, claim, analysis) {
    const { error } = await supabase.rpc(
        "save_advanced_preliminary_model_output",
        {
            p_job_id: claim.job_id,
            p_raw_model_output_text: analysis.rawModelOutputText,
            p_parsed_model_output: null,
            p_system_processing_notes: []
        }
    );
    if (error) {
        throw new Error("The preserved model output could not be recorded.", {
            cause: error
        });
    }
}

async function saveProviderResponse(supabase, claim, response) {
    const { error } = await supabase.rpc(
        "save_advanced_preliminary_provider_response",
        {
            p_job_id: claim.job_id,
            p_provider_response_id: response.id,
            p_provider_response_status: response.status || "queued",
            p_input_token_count: response?.usage?.input_tokens || null,
            p_output_token_count: response?.usage?.output_tokens || null
        }
    );
    if (error) {
        throw new Error("The durable model-response reference was not saved.", {
            cause: error
        });
    }
}

async function researcherReplacementState(supabase, jobId) {
    const { data, error } = await supabase
        .from("advanced_preliminary_analysis_jobs")
        .select("researcher_replacement_authorized_at, researcher_replacement_consumed_at, provider_response_history")
        .eq("id", jobId)
        .maybeSingle();
    if (error) {
        throw new Error("The researcher-authorized replacement state could not be loaded.", {
            cause: error
        });
    }
    if (!data?.researcher_replacement_authorized_at
        || data.researcher_replacement_consumed_at) {
        return null;
    }
    return data;
}

async function currentProviderAttemptCount(supabase, jobId) {
    const { data, error } = await supabase
        .from("advanced_preliminary_analysis_jobs")
        .select("attempt_count")
        .eq("id", jobId)
        .maybeSingle();
    if (error || !Number.isInteger(data?.attempt_count)) {
        throw new Error("The provider attempt number could not be loaded.", {
            cause: error || undefined
        });
    }
    return data.attempt_count;
}

function recoverableHistoricalAttempt(history) {
    if (!Array.isArray(history)) return null;
    return [...history].reverse().find(attempt =>
        typeof attempt?.responseId === "string"
        && ["completed", "failed", "incomplete"].includes(attempt.status)
    ) || null;
}

async function prepareHistoricalResponseRecovery(
    supabase,
    claim,
    currentResponse,
    historicalResponse
) {
    const { error } = await supabase.rpc(
        "prepare_researcher_authorized_historical_response_restore",
        {
            p_job_id: claim.job_id,
            p_current_provider_response_id: currentResponse.id,
            p_historical_provider_response_id: historicalResponse.id,
            p_historical_provider_response_status:
                historicalResponse.status || "unknown",
            p_historical_input_token_count:
                historicalResponse?.usage?.input_tokens || null,
            p_historical_output_token_count:
                historicalResponse?.usage?.output_tokens || null
        }
    );
    if (error) {
        throw new Error("The historical provider response could not be activated.", {
            cause: error
        });
    }
}

async function requeueResearcherAuthorizedReplacement(
    supabase,
    claim,
    cancelledResponse
) {
    const { error } = await supabase.rpc(
        "replace_researcher_authorized_advanced_preliminary_response",
        {
            p_job_id: claim.job_id,
            p_provider_response_id: cancelledResponse.id,
            p_reason: "Researcher authorized replacement of the outstanding provider response."
        }
    );
    if (error) {
        throw new Error("The researcher-authorized replacement was not queued.", {
            cause: error
        });
    }
}

async function handleResearcherAuthorizedReplacement(
    supabase,
    claim,
    analysisClient,
    currentResponse
) {
    const replacementState = await researcherReplacementState(
        supabase, claim.job_id
    );
    if (!replacementState) return null;

    const historicalAttempt = recoverableHistoricalAttempt(
        replacementState.provider_response_history
    );
    let historicalResponse = null;
    if (historicalAttempt) {
        historicalResponse = await analysisClient.responses.retrieve(
            historicalAttempt.responseId
        );
        if (["queued", "in_progress", "cancelled"]
            .includes(historicalResponse.status)) {
            historicalResponse = null;
        }
    }

    let replacementTarget = currentResponse;
    if (["queued", "in_progress"].includes(currentResponse.status)) {
        try {
            replacementTarget = await analysisClient.responses.cancel(
                currentResponse.id
            );
            await saveProviderResponse(supabase, claim, replacementTarget);
        } catch (error) {
            console.error("Researcher-authorized provider cancellation is still pending", {
                runId: claim.run_id,
                caseNumber: claim.case_number,
                providerResponseId: currentResponse.id,
                error: error instanceof Error ? error.message : String(error)
            });
            return { waiting: true };
        }
    }

    if (replacementTarget.status === "completed") {
        return { response: replacementTarget };
    }
    if (["failed", "incomplete"].includes(replacementTarget.status)) {
        return { response: replacementTarget };
    }
    if (replacementTarget.status !== "cancelled") {
        return { waiting: true };
    }

    if (historicalResponse) {
        await prepareHistoricalResponseRecovery(
            supabase,
            claim,
            replacementTarget,
            historicalResponse
        );
        return {
            response: historicalResponse,
            audit: {
                researcherAuthorizedHistoricalResponseRecovery: true,
                recoveredProviderResponseId: historicalResponse.id,
                replacedQueuedProviderResponseId: replacementTarget.id
            }
        };
    }

    await requeueResearcherAuthorizedReplacement(
        supabase, claim, replacementTarget
    );
    return { requeued: true };
}

async function persistCompletedAnalysis(supabase, claim, source, analysis) {
    const payload = {
        audit: analysis.audit,
        rawModelOutputText: analysis.rawModelOutputText
    };
    const existingReportId = await existingReportIdForJob(supabase, claim.job_id);
    const persistenceFunction = existingReportId
        ? "restore_advanced_preliminary_existing_report_output"
        : "complete_advanced_preliminary_analysis";
    const { data: reportId, error: completionError } = await supabase.rpc(
        persistenceFunction,
        {
            p_job_id: claim.job_id,
            p_participant_code: source.participantCode,
            p_language: source.session.language,
            p_input_token_count: analysis.inputTokenCount,
            p_output_token_count: analysis.outputTokenCount,
            p_payload: payload
        }
    );
    if (completionError || !reportId) {
        throw new Error("The advanced preliminary report output was not saved.", {
            cause: completionError || undefined
        });
    }
    return reportId;
}

async function loadClaimedTranscript(supabase, claim) {
    const [{ data: session, error: sessionError }, messagesResult, projectResult] =
        await Promise.all([
            supabase
                .from("interview_sessions")
                .select("session_id, participant_id, language, completed, completed_at")
                .eq("session_id", claim.session_id)
                .maybeSingle(),
            supabase
                .from("interview_messages")
                .select("id, Participant, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                .eq("Session", claim.session_id)
                .order("Timestamp", { ascending: true }),
            claim.project_id
                ? supabase
                    .from("research_projects")
                    .select("id, project_name, research_topic")
                    .eq("id", claim.project_id)
                    .maybeSingle()
                : Promise.resolve({ data: null, error: null })
        ]);
    if (sessionError || !session?.completed || !session.completed_at) {
        throw new Error("The source interview is not formally completed.");
    }
    if (messagesResult.error) {
        throw new Error("The original transcript could not be loaded.");
    }
    if (projectResult.error) {
        throw new Error("The research-project topic could not be loaded.");
    }
    const sourceRows = messagesResult.data || [];
    const prepared = prepareParticipantMessages(sourceRows).messages;
    if (!prepared.length) {
        throw new Error("The completed transcript has no participant evidence.");
    }
    const participantCodes = await loadParticipantCodeMap(
        supabase,
        [claim.participant_id]
    );
    return {
        session,
        messages: prepared,
        participantCode: participantCodes.get(claim.participant_id) || null,
        context: {
            projectName: projectResult.data?.project_name
                || "Historical sleeping-habits dataset",
            researchTopic: projectResult.data?.research_topic
                || "Sleeping habits",
            operationType: claim.operation_type
        }
    };
}

async function failJob(supabase, jobId, error) {
    const { error: persistenceError } = await supabase.rpc(
        "fail_advanced_preliminary_analysis",
        {
            p_job_id: jobId,
            p_error: error instanceof Error ? error.message : String(error),
            p_retryable: false
        }
    );
    if (persistenceError) {
        console.error("Advanced preliminary failure state was not saved:", persistenceError);
    }
}

async function existingReportIdForJob(supabase, jobId) {
    const { data, error } = await supabase
        .from("advanced_preliminary_case_reports")
        .select("id")
        .eq("job_id", jobId)
        .maybeSingle();
    if (error) {
        throw new Error("The saved-report state could not be confirmed.", {
            cause: error
        });
    }
    return data?.id || null;
}

export async function processNextAdvancedPreliminaryAnalysis(
    supabase,
    {
        claimFunction = "claim_next_advanced_preliminary_analysis",
        claimParameters = null,
        providerClientFactory = provider =>
            createAnalysisProviderClient(provider).client
    } = {}
) {
    const { data, error } = claimParameters
        ? await supabase.rpc(claimFunction, claimParameters)
        : await supabase.rpc(claimFunction);
    if (error) {
        throw new Error("The next advanced preliminary case could not be claimed.", {
            cause: error
        });
    }
    const claim = Array.isArray(data) ? data[0] || null : data || null;
    if (!claim) return { claimed: false };

    try {
        const analysisClient = providerClientFactory(claim.provider);
        const source = await loadClaimedTranscript(supabase, claim);
        let response;
        if (claim.provider_response_id) {
            response = await analysisClient.responses.retrieve(
                claim.provider_response_id
            );
            await saveProviderResponse(supabase, claim, response);
        } else {
            const normalizedModel = normalizeAnalysisModel(claim.model);
            const attemptCount = await currentProviderAttemptCount(
                supabase, claim.job_id
            );
            response = await analysisClient.responses.create(
                responseOptions(
                    normalizedModel,
                    claim.reasoning_effort,
                    null,
                    "advanced_preliminary_case_analysis",
                    analysisInput(source.messages, source.context),
                    true
                ),
                {
                    idempotencyKey:
                        `advanced-preliminary-${claim.job_id}-attempt-${attemptCount}`
                }
            );
            await saveProviderResponse(supabase, claim, response);
        }

        let replacementAudit = null;
        if (claim.provider_response_id
            && ["queued", "in_progress", "cancelled"]
                .includes(response.status)) {
            const replacement = await handleResearcherAuthorizedReplacement(
                supabase, claim, analysisClient, response
            );
            if (replacement?.waiting) {
                return {
                    claimed: true,
                    completed: false,
                    inProgress: true,
                    replacementPending: true,
                    runId: claim.run_id,
                    caseNumber: claim.case_number,
                    providerResponseId: response.id,
                    providerResponseStatus: response.status
                };
            }
            if (replacement?.requeued) {
                return {
                    claimed: true,
                    completed: false,
                    researcherAuthorizedReplacementQueued: true,
                    runId: claim.run_id,
                    caseNumber: claim.case_number,
                    replacedProviderResponseId: response.id
                };
            }
            if (replacement?.response) {
                response = replacement.response;
                replacementAudit = replacement.audit || null;
            }
        }

        if (["queued", "in_progress"].includes(response.status)) {
            return {
                claimed: true,
                completed: false,
                inProgress: true,
                runId: claim.run_id,
                caseNumber: claim.case_number,
                providerResponseId: response.id,
                providerResponseStatus: response.status
            };
        }

        const analysis = preservedOutputFromResponse(
            response,
            normalizeAnalysisModel(claim.model)
        );
        if (replacementAudit) {
            analysis.audit = { ...analysis.audit, ...replacementAudit };
        }
        await savePreservedModelOutput(supabase, claim, analysis);
        const reportId = await persistCompletedAnalysis(
            supabase, claim, source, analysis
        );
        console.log("Advanced preliminary case completed", {
            runId: claim.run_id,
            caseNumber: claim.case_number,
            reportId
        });
        return {
            claimed: true,
            completed: true,
            runId: claim.run_id,
            caseNumber: claim.case_number,
            reportId
        };
    } catch (error) {
        const existingReportId = await existingReportIdForJob(
            supabase, claim.job_id
        ).catch(lookupError => {
            console.error("Advanced preliminary saved-report check failed", {
                runId: claim.run_id,
                caseNumber: claim.case_number,
                error: lookupError instanceof Error
                    ? lookupError.message : String(lookupError)
            });
            return null;
        });
        if (existingReportId) {
            console.log("Advanced preliminary case was already completed", {
                runId: claim.run_id,
                caseNumber: claim.case_number,
                reportId: existingReportId
            });
            return {
                claimed: true,
                completed: true,
                alreadyCompleted: true,
                runId: claim.run_id,
                caseNumber: claim.case_number,
                reportId: existingReportId
            };
        }
        await failJob(supabase, claim.job_id, error);
        console.error("Advanced preliminary case failed", {
            runId: claim.run_id,
            caseNumber: claim.case_number,
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            claimed: true,
            completed: false,
            runId: claim.run_id,
            caseNumber: claim.case_number
        };
    }
}
