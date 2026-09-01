import { ensureEnglishTranslations } from "./messageTranslation.js";
import {
    isConversationalCourtesy,
    prepareParticipantMessages
} from "./stagedTranscript.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { normalizeOpenAIModel } from "./modelConfiguration.js";

export const ADVANCED_PRELIMINARY_PROVIDER = "openai";
export const ADVANCED_PRELIMINARY_MODEL = "gpt-5.6-sol";
export const ADVANCED_PRELIMINARY_REASONING_EFFORT = "high";
export const ADVANCED_PRELIMINARY_ANALYSIS_VERSION =
    "staged-analysis-stage1-v2-fresh-single-pass-meaning-units";
export const ADVANCED_PRELIMINARY_PROMPT_VERSION =
    "staged-analysis-stage1-prompt-v2-transcript-only-single-pass";
export const ADVANCED_PRELIMINARY_STOP_LAYER = "meaning_units";
export const SLEEPING_HABITS_PROJECT_CODE = "SLEEPING-HABITS";

const analysisSchema = {
    type: "object",
    properties: {
        meaning_units: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    message_id: { type: "string" },
                    exact_source_text: { type: "string" },
                    occurrence_index: { type: "integer" },
                    context_note: { type: "string" }
                },
                required: [
                    "message_id",
                    "exact_source_text",
                    "occurrence_index",
                    "context_note"
                ],
                additionalProperties: false
            }
        }
    },
    required: ["meaning_units"],
    additionalProperties: false
};

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

export function validateAdvancedPreliminaryAnalysis(value, messages) {
    const messagesById = new Map((messages || []).map(message => [
        message.id,
        message
    ]));
    const meaningUnits = [];
    const meaningUnitKeys = new Set();
    const invalidReasons = [];

    (Array.isArray(value?.meaning_units) ? value.meaning_units : [])
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
            if (!message || !occurrence
                || isConversationalCourtesy(occurrence.exactSourceText)) {
                invalidReasons.push(
                    `MU${index + 1} is not an exact substantive span in its original transcript message.`
                );
                return;
            }
            const key = `${messageId}:${occurrence.startOffset}:${occurrence.endOffset}`;
            if (meaningUnitKeys.has(key)) {
                invalidReasons.push(`MU${index + 1} duplicates an earlier meaning unit.`);
                return;
            }
            const overlaps = meaningUnits.some(unit =>
                unit.messageId === messageId
                && occurrence.startOffset < unit.endOffset
                && occurrence.endOffset > unit.startOffset
            );
            if (overlaps) {
                invalidReasons.push(
                    `MU${index + 1} overlaps another Meaning Unit in the same transcript message.`
                );
                return;
            }
            meaningUnitKeys.add(key);
            meaningUnits.push({
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

    const complete = Boolean(meaningUnits.length && !invalidReasons.length);

    return {
        meaningUnits,
        codes: [],
        categories: [],
        unassignedCodeNumbers: [],
        caseSummary: meaningUnits.length
            ? `Stage 1 preserved ${meaningUnits.length} exact Meaning Unit${meaningUnits.length === 1 ? "" : "s"}. No codes, categories, or themes were generated.`
            : "Stage 1 did not produce a valid Meaning Unit.",
        invalidReasons,
        complete
    };
}

function transcriptForModel(messages) {
    return JSON.stringify(messages.map(message => ({
        message_id: message.id,
        language: message.language,
        original_text: message.originalText,
        english_translation: message.englishTranslation,
        analysis_text: message.analysisText
    })));
}

function analysisInstruction({ projectName, researchTopic }) {
    const scope = researchTopic || "Sleeping habits";
    return [
        "Perform Stage 1 Meaning Unit identification for exactly one completed interview independently from its original transcript. No prior meaning unit, code, category, theme, report, corpus vocabulary, or codebook is supplied or permitted as analytical input.",
        `Research project: ${projectName || "Historical sleeping-habits dataset"}. Research topic/scope: ${scope}. Include an activity only when the participant or transcript makes its connection to the research topic explicit.`,
        "Stop at Meaning Units. Do not generate, name, imply, copy, or evaluate codes, categories, themes, tentative themes, refined concepts, cross-case comparisons, frequencies, or a global codebook.",
        "Read every participant message from beginning to end and segment all substantive research-relevant meanings into Meaning Units. Each Meaning Unit must be the smallest sufficient coherent original-language span that preserves its meaning in context. Copy exact_source_text verbatim from original_text, never from analysis_text, English translation, or a prior report. Use occurrence_index to identify a repeated span.",
        "Meaning Units remain case-grounded and must not be standardized. A Meaning Unit is an evidence segment, not an analytical label. Do not include interviewer text, greetings, thanks, farewells, consent formalities, or other conversational courtesies unless they contain substantive evidence relevant to the study topic.",
        "Full-transcript coverage is mandatory. Do not stop because similar evidence appeared earlier. Do not omit later or low-frequency evidence such as a stated preference, desired change, problem, condition, routine, consequence, evaluation, uncertainty, or contradiction when its connection to the study topic is explicit.",
        "Do not create overlapping Meaning Units. When adjacent words belong to the same coherent meaning, preserve them in one smallest sufficient span. When one participant passage contains analytically separable meanings, use separate non-overlapping exact spans.",
        "Return only the complete meaning_units array. This is the only AI analysis pass for this case. The application assigns stable MU numbers and performs only local deterministic checks that each quoted span exists exactly in the original transcript. No previous analysis and no second AI audit will be used."
    ].join("\n\n");
}

function responseOptions(model, reasoningEffort, schema, name, input) {
    return {
        model,
        store: false,
        reasoning: {
            effort: reasoningEffort,
            context: "current_turn"
        },
        text: {
            verbosity: "medium",
            format: { type: "json_schema", name, strict: true, schema }
        },
        input
    };
}

export async function probeAdvancedPreliminaryModel(
    openaiClient,
    {
        model = process.env.ADVANCED_PRELIMINARY_ANALYSIS_MODEL
            || ADVANCED_PRELIMINARY_MODEL,
        reasoningEffort = process.env.ADVANCED_PRELIMINARY_REASONING_EFFORT
            || ADVANCED_PRELIMINARY_REASONING_EFFORT
    } = {}
) {
    const normalizedModel = normalizeOpenAIModel(model);
    const response = await openaiClient.responses.create(responseOptions(
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
        provider: ADVANCED_PRELIMINARY_PROVIDER,
        model: normalizedModel,
        resolvedModel: normalizedText(response?.model) || normalizedModel,
        reasoningEffort
    };
}

export async function generateAdvancedPreliminaryAnalysis(
    openaiClient,
    messages,
    context,
    {
        model = ADVANCED_PRELIMINARY_MODEL,
        reasoningEffort = ADVANCED_PRELIMINARY_REASONING_EFFORT
    } = {}
) {
    const input = [
        { role: "system", content: analysisInstruction(context) },
        {
            role: "user",
            content: `Original participant transcript (JSON):\n${transcriptForModel(messages)}`
        }
    ];
    const response = await openaiClient.responses.create(responseOptions(
        model,
        reasoningEffort,
        analysisSchema,
        "advanced_preliminary_case_analysis",
        input
    ));
    const analysis = validateAdvancedPreliminaryAnalysis(
        parseResponse(response, "Advanced preliminary case analysis"),
        messages
    );
    if (!analysis.complete) {
        throw new Error(
            `The single-pass analysis failed deterministic transcript traceability validation: ${analysis.invalidReasons.join(" | ")}`
        );
    }
    return {
        ...analysis,
        audit: {
            reviewStatus: "single_pass_from_original_transcript",
            validationType: "local_deterministic_exact_transcript_traceability",
            priorAnalysisUsed: false,
            aiAnalysisPassCount: 1,
            stage1Only: true,
            meaningUnitCount: analysis.meaningUnits.length,
            overallSummary: "Generated from the original transcript in one 5.6 analysis pass. No prior-model analysis and no second AI audit were used."
        },
        inputTokenCount: response?.usage?.input_tokens || null,
        outputTokenCount: response?.usage?.output_tokens || null
    };
}

async function loadClaimedTranscript(supabase, openaiClient, claim) {
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
    await ensureEnglishTranslations(
        supabase,
        openaiClient,
        sourceRows,
        { concurrency: 4, failOnError: true }
    );
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
                || "Sleeping habits"
        }
    };
}

async function failJob(supabase, jobId, error) {
    const { error: persistenceError } = await supabase.rpc(
        "fail_advanced_preliminary_analysis",
        {
            p_job_id: jobId,
            p_error: error instanceof Error ? error.message : String(error),
            p_retryable: true
        }
    );
    if (persistenceError) {
        console.error("Advanced preliminary failure state was not saved:", persistenceError);
    }
}

export async function processNextAdvancedPreliminaryAnalysis(
    supabase,
    openaiClient
) {
    const { data, error } = await supabase.rpc(
        "claim_next_advanced_preliminary_analysis"
    );
    if (error) {
        throw new Error("The next advanced preliminary case could not be claimed.", {
            cause: error
        });
    }
    const claim = Array.isArray(data) ? data[0] || null : data || null;
    if (!claim) return { claimed: false };

    try {
        const source = await loadClaimedTranscript(supabase, openaiClient, claim);
        const analysis = await generateAdvancedPreliminaryAnalysis(
            openaiClient,
            source.messages,
            source.context,
            {
                model: claim.model,
                reasoningEffort: claim.reasoning_effort
            }
        );
        const payload = {
            meaningUnits: analysis.meaningUnits,
            codes: analysis.codes,
            categories: analysis.categories,
            unassignedCodeNumbers: analysis.unassignedCodeNumbers,
            caseSummary: analysis.caseSummary,
            audit: analysis.audit
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
