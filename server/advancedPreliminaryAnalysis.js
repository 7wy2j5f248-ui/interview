import {
    isConversationalCourtesy,
    prepareParticipantMessages
} from "./stagedTranscript.js";
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
        },
        codes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    definition: { type: "string" },
                    rationale: { type: "string" },
                    meaning_unit_numbers: {
                        type: "array",
                        items: { type: "integer" }
                    }
                },
                required: [
                    "label", "definition", "rationale", "meaning_unit_numbers"
                ],
                additionalProperties: false
            }
        },
        categories: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    definition: { type: "string" },
                    rationale: { type: "string" },
                    code_numbers: {
                        type: "array",
                        items: { type: "integer" }
                    }
                },
                required: ["label", "definition", "rationale", "code_numbers"],
                additionalProperties: false
            }
        },
        tentative_themes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    rationale: { type: "string" },
                    category_numbers: {
                        type: "array",
                        items: { type: "integer" }
                    }
                },
                required: ["label", "rationale", "category_numbers"],
                additionalProperties: false
            }
        },
        case_summary: { type: "string" }
    },
    required: [
        "meaning_units", "codes", "categories", "tentative_themes",
        "case_summary"
    ],
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

    const normalizeNumbers = (values, maximum) => [...new Set(
        (Array.isArray(values) ? values : []).filter(number =>
            Number.isInteger(number) && number > 0 && number <= maximum
        )
    )];
    const codes = [];
    (Array.isArray(value?.codes) ? value.codes : []).forEach((raw, index) => {
        const label = normalizedText(raw?.label);
        const definition = normalizedText(raw?.definition);
        const rationale = normalizedText(raw?.rationale);
        const meaningUnitNumbers = normalizeNumbers(
            raw?.meaning_unit_numbers,
            meaningUnits.length
        );
        if (!label || !definition || !rationale || !meaningUnitNumbers.length) {
            invalidReasons.push(
                `CO${index + 1} is missing a label, explanation, or valid Meaning Unit link.`
            );
            return;
        }
        codes.push({ label, definition, rationale, meaningUnitNumbers });
    });

    const categories = [];
    (Array.isArray(value?.categories) ? value.categories : [])
        .forEach((raw, index) => {
            const label = normalizedText(raw?.label);
            const definition = normalizedText(raw?.definition);
            const rationale = normalizedText(raw?.rationale);
            const codeNumbers = normalizeNumbers(raw?.code_numbers, codes.length);
            if (!label || !definition || !rationale || !codeNumbers.length) {
                invalidReasons.push(
                    `CA${index + 1} is missing a label, explanation, or valid Code link.`
                );
                return;
            }
            categories.push({ label, definition, rationale, codeNumbers });
        });

    const tentativeThemes = [];
    (Array.isArray(value?.tentative_themes) ? value.tentative_themes : [])
        .forEach((raw, index) => {
            const label = normalizedText(raw?.label);
            const rationale = normalizedText(raw?.rationale);
            const categoryNumbers = normalizeNumbers(
                raw?.category_numbers,
                categories.length
            );
            if (!label || !rationale || !categoryNumbers.length) {
                invalidReasons.push(
                    `TH${index + 1} is missing a label, explanation, or valid Category link.`
                );
                return;
            }
            tentativeThemes.push({ label, rationale, categoryNumbers });
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
    const caseSummary = normalizedText(value?.case_summary);
    const complete = Boolean(
        meaningUnits.length && codes.length && caseSummary && !invalidReasons.length
    );

    return {
        meaningUnits,
        codes,
        categories,
        tentativeThemes,
        unassignedCodeNumbers,
        unassignedCategoryNumbers,
        caseSummary: caseSummary || "The independent case analysis was incomplete.",
        invalidReasons,
        complete
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
        "Return the complete structured case report. This is the only AI analysis pass for this case. The application assigns stable MU, CO, CA, and TH positions and performs only local deterministic checks of exact transcript spans and relationship references. No previous analysis, second AI audit, repair call, or human approval gate will be used.",
        rulesSnapshot
            ? `Researcher-selected rules frozen for this run (JSON):\n${JSON.stringify(rulesSnapshot)}`
            : "No additional researcher-selected rule snapshot was supplied."
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
    const input = [
        { role: "system", content: analysisInstruction(context) },
        {
            role: "user",
            content: `Original participant transcript (JSON):\n${transcriptForModel(messages)}`
        }
    ];
    const response = await analysisClient.responses.create(responseOptions(
        normalizedModel,
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
            reviewStatus: "independent_complete_preliminary_case_analysis",
            validationType: "local_deterministic_source_and_relationship_integrity",
            priorAnalysisUsed: false,
            aiAnalysisPassCount: 1,
            stage1Only: false,
            meaningUnitCount: analysis.meaningUnits.length,
            codeCount: analysis.codes.length,
            categoryCount: analysis.categories.length,
            tentativeThemeCount: analysis.tentativeThemes.length,
            overallSummary: `Generated independently from the original transcript in one ${normalizedModel} analysis pass. No prior-model analysis, AI audit, repair call, or per-case approval was used.`
        },
        inputTokenCount: response?.usage?.input_tokens || null,
        outputTokenCount: response?.usage?.output_tokens || null
    };
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

async function failJob(supabase, jobId, error, retryable = false) {
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
        providerClientFactory = provider =>
            createAnalysisProviderClient(provider).client
    } = {}
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
        const analysisClient = providerClientFactory(claim.provider);
        const source = await loadClaimedTranscript(supabase, claim);
        const analysis = await generateAdvancedPreliminaryAnalysis(
            analysisClient,
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
            tentativeThemes: analysis.tentativeThemes,
            unassignedCodeNumbers: analysis.unassignedCodeNumbers,
            unassignedCategoryNumbers: analysis.unassignedCategoryNumbers,
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
        await failJob(supabase, claim.job_id, error, false);
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
