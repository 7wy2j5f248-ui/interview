import { prepareParticipantMessages } from "./stagedTranscript.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { normalizeAnalysisModel } from "./modelConfiguration.js";
import { createAnalysisProviderClient } from "./analysisProvider.js";

export const ADVANCED_PRELIMINARY_REASONING_EFFORT = "high";
export const ADVANCED_PRELIMINARY_ANALYSIS_VERSION =
    "preliminary-case-analysis-v4-researcher-controlled-independent";
export const ADVANCED_PRELIMINARY_PROMPT_VERSION =
    "preliminary-case-analysis-prompt-v4-explicit-run-contract";
export const ADVANCED_PRELIMINARY_STOP_LAYER = "preliminary_tentative_themes";
export const SLEEPING_HABITS_PROJECT_CODE = "SLEEPING-HABITS";
export const FRESH_ANALYSIS_OPERATION = "fresh_independent_analysis";
export const AUTHORITATIVE_SOURCE = "original_completed_transcripts";
export const LEGACY_ANALYSIS_INPUT = "excluded";
export const EXECUTION_CONTRACT_VERSION = "researcher-operation-contract-v1";
export const ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS = 20000;
export const ADVANCED_PRELIMINARY_STALE_RESPONSE_MINUTES = 45;
export const DEFAULT_ADVANCED_PRELIMINARY_WORKER_CONCURRENCY = 8;

export function configuredAdvancedPreliminaryWorkerConcurrency(
    environment = process.env
) {
    const configured = environment.ADVANCED_PRELIMINARY_WORKER_CONCURRENCY;
    if (configured === undefined || configured === null
        || String(configured).trim() === "") {
        return DEFAULT_ADVANCED_PRELIMINARY_WORKER_CONCURRENCY;
    }
    const normalized = String(configured).trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
        throw new Error(
            "ADVANCED_PRELIMINARY_WORKER_CONCURRENCY must be a positive integer."
        );
    }
    return Number(normalized);
}

const modelProbeSchema = {
    type: "object",
    properties: { ready: { type: "boolean" } },
    required: ["ready"],
    additionalProperties: false
};

function normalizedText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function responseText(response) {
    const candidates = [
        response?.output_text,
        ...(response?.output || []).flatMap(item =>
            (item?.content || []).map(content => content?.text)
        )
    ];
    return candidates.find(value => typeof value === "string" && value.trim())
        ?.trim() || "";
}

function parseResponse(response, description) {
    const text = responseText(response);
    if (!text) throw new Error(`${description} was empty.`);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${description} was malformed.`, { cause: error });
    }
}

function occurrences(source, phrase) {
    const sourceText = typeof source === "string" ? source : "";
    const exactText = normalizedText(phrase);
    if (!sourceText || !exactText) return [];
    const haystack = sourceText.toLocaleLowerCase();
    const needle = exactText.toLocaleLowerCase();
    const matches = [];
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const startOffset = haystack.indexOf(needle, from);
        if (startOffset < 0) break;
        matches.push({
            exactSourceText: sourceText.slice(
                startOffset,
                startOffset + exactText.length
            ),
            startOffset,
            endOffset: startOffset + exactText.length
        });
        from = startOffset + Math.max(needle.length, 1);
    }
    return matches;
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function textValue(value) {
    return typeof value === "string" ? value.trim() : "";
}

function referencedPositions(value) {
    return [...new Set(arrayValue(value).filter(number =>
        Number.isInteger(number) && number > 0
    ))];
}

export function projectAdvancedPreliminaryAnalysis(value, messages) {
    const messagesById = new Map((messages || []).map(message => [
        message.id,
        message
    ]));
    const meaningUnits = [];
    const systemProcessingNotes = [];

    arrayValue(value?.meaning_units)
        .forEach((raw, index) => {
            const messageId = normalizedText(raw?.message_id);
            const message = messagesById.get(messageId);
            const requestedOccurrence = Number.isInteger(raw?.occurrence_index)
                && raw.occurrence_index > 0 ? raw.occurrence_index : 1;
            const found = occurrences(
                message?.originalText,
                raw?.exact_source_text
            );
            const occurrence = found[requestedOccurrence - 1];
            if (!message || !occurrence) {
                systemProcessingNotes.push({
                    code: "MU_RELATIONAL_PROJECTION_UNAVAILABLE",
                    item: `MU${index + 1}`,
                    detail: "The model item could not be located as an exact span in the referenced transcript message. It remains preserved in the raw model output."
                });
                return;
            }
            meaningUnits.push({
                unitNumber: index + 1,
                messageId,
                exactSourceText: occurrence.exactSourceText,
                sourceLanguage: message.language || null,
                startOffset: occurrence.startOffset,
                endOffset: occurrence.endOffset,
                occurrenceIndex: requestedOccurrence,
                contextNote: normalizedText(raw?.context_note)
                    || "Exact case-grounded meaning unit."
            });
        });

    const codes = arrayValue(value?.codes).map((raw, index) => ({
        codeNumber: index + 1,
        label: textValue(raw?.label),
        definition: textValue(raw?.definition),
        rationale: textValue(raw?.rationale),
        meaningUnitNumbers: referencedPositions(raw?.meaning_unit_numbers)
    }));

    const categories = arrayValue(value?.categories).map((raw, index) => ({
        categoryNumber: index + 1,
        label: textValue(raw?.label),
        definition: textValue(raw?.definition),
        rationale: textValue(raw?.rationale),
        codeNumbers: referencedPositions(raw?.code_numbers)
    }));

    const tentativeThemes = arrayValue(value?.tentative_themes)
        .map((raw, index) => ({
            themeNumber: index + 1,
            label: textValue(raw?.label),
            rationale: textValue(raw?.rationale),
            categoryNumbers: referencedPositions(raw?.category_numbers)
        }));

    const projectedMeaningUnitNumbers = new Set(
        meaningUnits.map(item => item.unitNumber)
    );
    const codeNumbers = new Set(codes.map(item => item.codeNumber));
    const categoryNumbers = new Set(
        categories.map(item => item.categoryNumber)
    );
    codes.forEach(item => {
        const unavailable = item.meaningUnitNumbers.filter(
            number => !projectedMeaningUnitNumbers.has(number)
        );
        if (unavailable.length) {
            systemProcessingNotes.push({
                code: "CODE_LINK_PROJECTION_UNAVAILABLE",
                item: `CO${item.codeNumber}`,
                referencedMeaningUnits: unavailable,
                detail: "Some model-supplied Meaning Unit links could not be represented relationally. The original links remain in the raw model output."
            });
        }
    });
    categories.forEach(item => {
        const unavailable = item.codeNumbers.filter(
            number => !codeNumbers.has(number)
        );
        if (unavailable.length) {
            systemProcessingNotes.push({
                code: "CATEGORY_LINK_PROJECTION_UNAVAILABLE",
                item: `CA${item.categoryNumber}`,
                referencedCodes: unavailable,
                detail: "Some model-supplied Code links could not be represented relationally. The original links remain in the raw model output."
            });
        }
    });
    tentativeThemes.forEach(item => {
        const unavailable = item.categoryNumbers.filter(
            number => !categoryNumbers.has(number)
        );
        if (unavailable.length) {
            systemProcessingNotes.push({
                code: "THEME_LINK_PROJECTION_UNAVAILABLE",
                item: `TH${item.themeNumber}`,
                referencedCategories: unavailable,
                detail: "Some model-supplied Category links could not be represented relationally. The original links remain in the raw model output."
            });
        }
    });

    const linkedCodeNumbers = new Set(categories.flatMap(item => item.codeNumbers));
    const linkedCategoryNumbers = new Set(
        tentativeThemes.flatMap(item => item.categoryNumbers)
    );
    const unassignedCodeNumbers = codes
        .map((_, index) => index + 1)
        .filter(number => !linkedCodeNumbers.has(number));
    const unassignedCategoryNumbers = categories
        .map((_, index) => index + 1)
        .filter(number => !linkedCategoryNumbers.has(number));
    const caseSummary = textValue(value?.case_summary)
        || "The model output was preserved without a case summary.";
    if (!textValue(value?.case_summary)) {
        systemProcessingNotes.push({
            code: "CASE_SUMMARY_NOT_SUPPLIED",
            detail: "No case summary was supplied. The model output remains preserved and the report remains processible."
        });
    }

    return {
        meaningUnits,
        codes,
        categories,
        tentativeThemes,
        unassignedCodeNumbers,
        unassignedCategoryNumbers,
        caseSummary,
        systemProcessingNotes
    };
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
    operationType = FRESH_ANALYSIS_OPERATION,
    rulesSnapshot = null
}) {
    const scope = researchTopic || "Sleeping habits";
    return [
        `Execution operation: ${operationType}. Authoritative source: ${AUTHORITATIVE_SOURCE}. Legacy analytical inputs: ${LEGACY_ANALYSIS_INPUT}.`,
        "Perform one complete Preliminary Case-Based Analysis for exactly one completed interview independently from its original transcript. No prior meaning unit, code, category, theme, report, model output, corpus vocabulary, or codebook is supplied or permitted as analytical input.",
        `Research project: ${projectName || "Historical sleeping-habits dataset"}. Research topic/scope: ${scope}. Include an activity only when the participant or transcript makes its connection to the research topic explicit.`,
        "Complete this case upward in this order: Transcript → Meaning Units → Preliminary Codes → Preliminary Categories → Preliminary Tentative Themes. Do not compare this participant with any other case. Do not use frequencies, refined cross-case concepts, or a predetermined global codebook.",
        "Read every participant message from beginning to end and segment all substantive research-relevant meanings into Meaning Units. Each Meaning Unit must be the smallest sufficient coherent original-language span that preserves its meaning in context. Copy exact_source_text verbatim from original_text, never from analysis_text, English translation, or a prior report. Use occurrence_index to identify a repeated span.",
        "Meaning Units remain case-grounded and must not be standardized. A Meaning Unit is an evidence segment, not an analytical label. Do not include interviewer text, greetings, thanks, farewells, consent formalities, or other conversational courtesies unless they contain substantive evidence relevant to the study topic.",
        "Full-transcript coverage is mandatory. Do not stop because similar evidence appeared earlier. Do not omit later or low-frequency evidence such as a stated preference, desired change, problem, condition, routine, consequence, evaluation, uncertainty, or contradiction when its connection to the study topic is explicit.",
        "Do not create overlapping Meaning Units. When adjacent words belong to the same coherent meaning, preserve them in one smallest sufficient span. When one participant passage contains analytically separable meanings, use separate non-overlapping exact spans.",
        "Create concise English Preliminary Codes from the actual Meaning Units in this case. Each code should normally be one to three words and must name the specific phenomenon supported by every linked Meaning Unit. Link codes by meaning_unit_numbers; multiple codes may link to one Meaning Unit and one code may link to multiple Meaning Units.",
        "Create case-specific Preliminary Categories as broader descriptive groupings of supported codes. Link them by code_numbers. Relationships are many-to-many: a code may contribute to more than one justified category. Do not force unrelated codes together and do not require exclusive or unshared children.",
        "Create Preliminary Tentative Themes that express the patterned meaning supported by the case's categories. Link them by category_numbers. Relationships are many-to-many. A tentative theme is not a cross-case final theme and must not claim prevalence beyond this participant.",
        "Use English for code, category, tentative-theme, definition, rationale, and case-summary text. Preserve exact_source_text in the original transcript language. If a higher layer is genuinely unsupported, leave that array empty and explain the unsynthesized result in case_summary; never invent support merely to fill a form.",
        "Return the complete structured case report. This is the only AI analysis pass for this case. The platform preserves the response as generated and assigns local MU, CO, CA, and TH display positions without using an analytical validator to accept or reject the report. No previous analysis, second AI audit, repair call, or human approval gate will be used.",
        rulesSnapshot
            ? `Researcher-selected rules frozen for this run (JSON):\n${JSON.stringify(rulesSnapshot)}`
            : "No additional researcher-selected rule snapshot was supplied."
    ].join("\n\n");
}

function responseOptions(model, reasoningEffort, schema, name, input, background = false) {
    return {
        model,
        store: background,
        background,
        max_output_tokens: ADVANCED_PRELIMINARY_MAX_OUTPUT_TOKENS,
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

function preservedAnalysisFromResponse(response, messages, normalizedModel) {
    const rawModelOutputText = responseText(response);
    const responseNotes = [];
    let rawModelOutput = null;
    if (!rawModelOutputText) {
        responseNotes.push({
            code: "MODEL_OUTPUT_EMPTY",
            detail: "The provider completed without readable output text. The empty response is preserved as a system issue."
        });
    } else {
        try {
            rawModelOutput = JSON.parse(rawModelOutputText);
        } catch {
            responseNotes.push({
                code: "MODEL_OUTPUT_NOT_JSON",
                detail: "The provider output is not parseable JSON. The exact raw response is preserved for system investigation."
            });
        }
    }
    const analysis = projectAdvancedPreliminaryAnalysis(
        rawModelOutput || {},
        messages
    );
    const systemProcessingNotes = [
        ...responseNotes,
        ...analysis.systemProcessingNotes
    ];
    return {
        ...analysis,
        rawModelOutputText,
        rawModelOutput,
        systemProcessingNotes,
        audit: {
            reviewStatus: "model_output_preserved_without_validator",
            validationType: "none_no_analytical_validator",
            relationalProjectionType: "non_rejecting_system_projection",
            priorAnalysisUsed: false,
            aiAnalysisPassCount: 1,
            stage1Only: false,
            meaningUnitCount: analysis.meaningUnits.length,
            codeCount: analysis.codes.length,
            categoryCount: analysis.categories.length,
            tentativeThemeCount: analysis.tentativeThemes.length,
            systemProcessingNoteCount: systemProcessingNotes.length,
            overallSummary: `Generated independently from the original transcript in one ${normalizedModel} analysis pass and preserved without an analytical validator. No prior-model analysis, AI audit, repair call, or per-case approval was used.`
        },
        inputTokenCount: response?.usage?.input_tokens || null,
        outputTokenCount: response?.usage?.output_tokens || null
    };
}

export async function probeAdvancedPreliminaryModel(
    analysisClient,
    {
        provider,
        model,
        reasoningEffort = process.env.ADVANCED_PRELIMINARY_REASONING_EFFORT
            || ADVANCED_PRELIMINARY_REASONING_EFFORT
    } = {}
) {
    const normalizedModel = normalizeAnalysisModel(model);
    const response = await analysisClient.responses.create(responseOptions(
        normalizedModel,
        reasoningEffort,
        modelProbeSchema,
        "advanced_preliminary_model_probe",
        [{
            role: "user",
            content: "Return ready=true. This verifies structured-output and reasoning support."
        }]
    ));
    const value = parseResponse(response, "Advanced-model capability probe");
    if (value?.ready !== true) {
        throw new Error("The configured advanced model failed its capability probe.");
    }
    return {
        provider,
        model: normalizedModel,
        resolvedModel: normalizedText(response?.model) || normalizedModel,
        reasoningEffort
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
    return preservedAnalysisFromResponse(response, messages, normalizedModel);
}

async function savePreservedModelOutput(supabase, claim, analysis) {
    const { error } = await supabase.rpc(
        "save_advanced_preliminary_model_output",
        {
            p_job_id: claim.job_id,
            p_raw_model_output_text: analysis.rawModelOutputText,
            p_parsed_model_output: analysis.rawModelOutput,
            p_system_processing_notes: analysis.systemProcessingNotes
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

async function providerResponseIsStale(supabase, claim, now = new Date()) {
    const { data, error } = await supabase
        .from("advanced_preliminary_analysis_jobs")
        .select("provider_response_submitted_at")
        .eq("id", claim.job_id)
        .maybeSingle();
    if (error) {
        throw new Error("The provider-response submission time could not be loaded.", {
            cause: error
        });
    }
    const submittedAt = Date.parse(data?.provider_response_submitted_at || "");
    return Number.isFinite(submittedAt)
        && now.getTime() - submittedAt
            >= ADVANCED_PRELIMINARY_STALE_RESPONSE_MINUTES * 60 * 1000;
}

async function resolveStalledProviderResponse(
    analysisClient,
    supabase,
    claim,
    response
) {
    if (!["queued", "in_progress"].includes(response.status)
        || !(await providerResponseIsStale(supabase, claim))) {
        return null;
    }

    let cancelledResponse;
    try {
        cancelledResponse = await analysisClient.responses.cancel(response.id);
    } catch (cancelError) {
        const latestResponse = await analysisClient.responses.retrieve(response.id);
        await saveProviderResponse(supabase, claim, latestResponse);
        if (latestResponse.status === "completed") {
            return { completedResponse: latestResponse };
        }
        throw cancelError;
    }
    await saveProviderResponse(supabase, claim, cancelledResponse);

    const { data: resolution, error } = await supabase.rpc(
        "resolve_stalled_advanced_preliminary_response",
        {
            p_job_id: claim.job_id,
            p_provider_response_id: response.id,
            p_reason: `Provider response remained ${response.status} for at least ${ADVANCED_PRELIMINARY_STALE_RESPONSE_MINUTES} minutes.`
        }
    );
    if (error || !resolution) {
        throw new Error("The stalled provider response was cancelled but its retry lineage was not saved.", {
            cause: error || undefined
        });
    }
    return { resolution };
}

async function persistCompletedAnalysis(supabase, claim, source, analysis) {
    const payload = {
        meaningUnits: analysis.meaningUnits,
        codes: analysis.codes,
        categories: analysis.categories,
        tentativeThemes: analysis.tentativeThemes,
        unassignedCodeNumbers: analysis.unassignedCodeNumbers,
        unassignedCategoryNumbers: analysis.unassignedCategoryNumbers,
        caseSummary: analysis.caseSummary,
        audit: analysis.audit,
        rawModelOutputText: analysis.rawModelOutputText,
        rawModelOutput: analysis.rawModelOutput,
        systemProcessingNotes: analysis.systemProcessingNotes
    };
    const { data: reportId, error: completionError } = await supabase.rpc(
        "complete_advanced_preliminary_analysis",
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
        throw new Error("The advanced preliminary report was not saved.", {
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
            operationType: claim.operation_type,
            rulesSnapshot: claim.rules_snapshot || null
        }
    };
}

async function failJob(supabase, jobId, error, retryable = true) {
    const { error: persistenceError } = await supabase.rpc(
        "fail_advanced_preliminary_analysis",
        {
            p_job_id: jobId,
            p_error: error instanceof Error ? error.message : String(error),
            p_retryable: retryable
        }
    );
    if (persistenceError) {
        console.error("Advanced preliminary failure state was not saved:", persistenceError);
    }
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
                        `advanced-preliminary-${claim.job_id}-attempt-${claim.attempt_count}`
                }
            );
            await saveProviderResponse(supabase, claim, response);
        }

        if (["queued", "in_progress"].includes(response.status)) {
            const staleResolution = await resolveStalledProviderResponse(
                analysisClient, supabase, claim, response
            );
            if (staleResolution?.completedResponse) {
                response = staleResolution.completedResponse;
            } else if (staleResolution?.resolution) {
                return {
                    claimed: true,
                    completed: false,
                    staleResolved: true,
                    runId: claim.run_id,
                    caseNumber: claim.case_number,
                    providerResponseId: response.id,
                    providerResponseStatus: "cancelled",
                    resolution: staleResolution.resolution
                };
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
        if (response.status !== "completed") {
            const providerError = response?.error?.message
                || response?.incomplete_details?.reason
                || `Model response ended with status ${response.status || "unknown"}.`;
            throw new Error(providerError);
        }

        const analysis = preservedAnalysisFromResponse(
            response,
            source.messages,
            normalizeAnalysisModel(claim.model)
        );
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
        await failJob(supabase, claim.job_id, error, true);
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
