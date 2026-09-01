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
    "staged-analysis-stage1-v1-meaning-units-only";
export const ADVANCED_PRELIMINARY_PROMPT_VERSION =
    "staged-analysis-stage1-prompt-v1-exact-coverage";
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

const auditSchema = {
    type: "object",
    properties: {
        meaning_unit_checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    unit_number: { type: "integer" },
                    message_id: { type: "string" },
                    exact_source_match: { type: "boolean" },
                    research_relevant: { type: "boolean" },
                    smallest_sufficient_span: { type: "boolean" },
                    context_preserved: { type: "boolean" },
                    explanation: { type: "string" }
                },
                required: [
                    "unit_number", "message_id", "exact_source_match",
                    "research_relevant", "smallest_sufficient_span",
                    "context_preserved", "explanation"
                ],
                additionalProperties: false
            }
        },
        full_transcript_coverage: { type: "boolean" },
        omitted_relevant_evidence: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    message_id: { type: "string" },
                    exact_source_text: { type: "string" },
                    explanation: { type: "string" }
                },
                required: ["message_id", "exact_source_text", "explanation"],
                additionalProperties: false
            }
        },
        stage1_only: { type: "boolean" },
        overall_summary: { type: "string" }
    },
    required: [
        "meaning_unit_checks", "full_transcript_coverage",
        "omitted_relevant_evidence", "stage1_only",
        "overall_summary"
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

export function validateAdvancedPreliminaryAudit(analysis, value) {
    const checksByNumber = new Map();
    (Array.isArray(value?.meaning_unit_checks) ? value.meaning_unit_checks : [])
        .forEach(check => {
            if (Number.isInteger(check?.unit_number)) {
                checksByNumber.set(check.unit_number, check);
            }
        });
    const meaningUnitChecks = analysis.meaningUnits.map((unit, index) => {
        const check = checksByNumber.get(index + 1);
        const accepted = Boolean(
            check?.message_id === unit.messageId
            && check?.exact_source_match
            && check?.research_relevant
            && check?.smallest_sufficient_span
            && check?.context_preserved
        );
        return {
            unitNumber: index + 1,
            messageId: unit.messageId,
            exactSourceMatch: Boolean(check?.exact_source_match),
            researchRelevant: Boolean(check?.research_relevant),
            smallestSufficientSpan: Boolean(check?.smallest_sufficient_span),
            contextPreserved: Boolean(check?.context_preserved),
            explanation: normalizedText(check?.explanation)
                || "The independent audit did not return this Meaning Unit.",
            accepted
        };
    });
    const omittedRelevantEvidence = (Array.isArray(value?.omitted_relevant_evidence)
        ? value.omitted_relevant_evidence : []).map(item => ({
        messageId: normalizedText(item?.message_id),
        exactSourceText: normalizedText(item?.exact_source_text),
        explanation: normalizedText(item?.explanation)
            || "Substantive research-relevant transcript evidence was omitted."
    })).filter(item => item.messageId && item.exactSourceText);
    const fullTranscriptCoverage = Boolean(value?.full_transcript_coverage);
    const stage1Only = Boolean(value?.stage1_only);
    return {
        meaningUnitChecks,
        fullTranscriptCoverage,
        omittedRelevantEvidence,
        stage1Only,
        overallSummary: normalizedText(value?.overall_summary)
            || "No audit summary was supplied.",
        complete: Boolean(
            meaningUnitChecks.length === checksByNumber.size
            && meaningUnitChecks.every(check => check.accepted)
            && fullTranscriptCoverage
            && !omittedRelevantEvidence.length
            && stage1Only
        )
    };
}

export function coverageGapIsReviewable(audit) {
    return Boolean(
        audit
        && audit.stage1Only
        && audit.meaningUnitChecks?.length
        && (
            !audit.fullTranscriptCoverage
            || audit.meaningUnitChecks.some(check => !check.accepted)
            || audit.omittedRelevantEvidence?.length
        )
    );
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

function draftForAudit(analysis) {
    return {
        meaning_units: analysis.meaningUnits.map(unit => ({
            message_id: unit.messageId,
            exact_source_text: unit.exactSourceText,
            context_note: unit.contextNote
        }))
    };
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
        "Return only the complete meaning_units array. The application assigns stable MU numbers and database identifiers and will separately audit exact grounding and full-transcript coverage."
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

async function auditAnalysis(
    openaiClient,
    messages,
    analysis,
    context,
    model,
    reasoningEffort
) {
    const response = await openaiClient.responses.create(responseOptions(
        model,
        reasoningEffort,
        auditSchema,
        "advanced_preliminary_analysis_audit",
        [{
            role: "system",
            content: [
                "Act as an independent Stage 1 Meaning Unit auditor for exactly one case.",
                "Return one meaning_unit_check for every numbered Meaning Unit, with no missing or extra checks. Match both its number and transcript message ID.",
                "Accept a Meaning Unit only when it is an exact original-language transcript span, is substantively relevant to the named research topic, is the smallest sufficient coherent span, and preserves enough context to retain the participant's meaning.",
                "Perform a separate full-transcript coverage pass. Read every participant message from beginning to end and compare it against all proposed Meaning Units. Set full_transcript_coverage=true only when every substantive study-relevant meaning is represented. Put every omitted relevant span in omitted_relevant_evidence with its message ID, exact original text, and explanation. Later, low-frequency, contradictory, evaluative, or aspirational evidence still counts.",
                "Set stage1_only=true only when the draft contains Meaning Units alone and neither the draft nor your audit generates, names, implies, copies, or evaluates any code, category, or theme.",
                "Audit only the supplied transcript and Meaning Unit draft. Do not compare cases and do not invent a replacement analysis in the audit response.",
                analysisInstruction(context)
            ].join("\n\n")
        }, {
            role: "user",
            content: [
                `Original participant transcript (JSON):\n${transcriptForModel(messages)}`,
                `Proposed preliminary analysis (JSON):\n${JSON.stringify(draftForAudit(analysis))}`
            ].join("\n\n")
        }]
    ));
    return {
        audit: validateAdvancedPreliminaryAudit(
            analysis,
            parseResponse(response, "Advanced preliminary analysis audit")
        ),
        inputTokens: response?.usage?.input_tokens || 0,
        outputTokens: response?.usage?.output_tokens || 0
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
    const createDraft = async (additionalInput = null) => {
        const input = [
            { role: "system", content: analysisInstruction(context) },
            {
                role: "user",
                content: [
                    `Original participant transcript (JSON):\n${transcriptForModel(messages)}`,
                    additionalInput
                ].filter(Boolean).join("\n\n")
            }
        ];
        const response = await openaiClient.responses.create(responseOptions(
            model,
            reasoningEffort,
            analysisSchema,
            "advanced_preliminary_case_analysis",
            input
        ));
        return {
            response,
            analysis: validateAdvancedPreliminaryAnalysis(
                parseResponse(response, "Advanced preliminary case analysis"),
                messages
            )
        };
    };

    let generated = await createDraft();
    let totalInputTokens = generated.response?.usage?.input_tokens || 0;
    let totalOutputTokens = generated.response?.usage?.output_tokens || 0;
    if (!generated.analysis.complete) {
        generated = await createDraft([
            "The previous draft failed deterministic traceability validation.",
            `Validation problems (JSON): ${JSON.stringify(generated.analysis.invalidReasons)}`,
            "Create a complete replacement directly from the original transcript. Return exact non-overlapping Meaning Units only. Do not generate codes, categories, or themes."
        ].join("\n"));
        totalInputTokens += generated.response?.usage?.input_tokens || 0;
        totalOutputTokens += generated.response?.usage?.output_tokens || 0;
    }
    if (!generated.analysis.complete) {
        throw new Error(
            `The advanced draft failed traceability validation: ${generated.analysis.invalidReasons.join(" | ")}`
        );
    }

    let audited = await auditAnalysis(
        openaiClient,
        messages,
        generated.analysis,
        context,
        model,
        reasoningEffort
    );
    totalInputTokens += audited.inputTokens;
    totalOutputTokens += audited.outputTokens;

    if (!audited.audit.complete) {
        generated = await createDraft([
            `Audited draft requiring replacement (JSON): ${JSON.stringify(draftForAudit(generated.analysis))}`,
            `Independent audit (JSON): ${JSON.stringify(audited.audit)}`,
            "Repair every rejected Meaning Unit and add every omitted substantive research-relevant span as an exact original-language Meaning Unit. Recheck the full transcript from beginning to end. Return Meaning Units only; do not generate codes, categories, or themes."
        ].join("\n\n"));
        totalInputTokens += generated.response?.usage?.input_tokens || 0;
        totalOutputTokens += generated.response?.usage?.output_tokens || 0;
        if (!generated.analysis.complete) {
            throw new Error(
                `The audit repair failed traceability validation: ${generated.analysis.invalidReasons.join(" | ")}`
            );
        }
        audited = await auditAnalysis(
            openaiClient,
            messages,
            generated.analysis,
            context,
            model,
            reasoningEffort
        );
        totalInputTokens += audited.inputTokens;
        totalOutputTokens += audited.outputTokens;
    }

    if (!audited.audit.complete && !coverageGapIsReviewable(audited.audit)) {
        const failures = [
            ...audited.audit.meaningUnitChecks.filter(check => !check.accepted)
                .map(check => `MU${check.unitNumber}: ${check.explanation}`),
            ...(!audited.audit.fullTranscriptCoverage
                ? ["Full-transcript coverage failed: substantive research-relevant evidence was omitted."]
                : []),
            ...audited.audit.omittedRelevantEvidence.map(item =>
                `Omitted evidence in message ${item.messageId}: ${item.exactSourceText} (${item.explanation})`
            ),
            ...(!audited.audit.stage1Only
                ? ["The Stage 1 result improperly introduced a code, category, or theme."]
                : [])
        ];
        throw new Error(
            `The Stage 1 Meaning Unit analysis failed its independent coverage audit: ${failures.join(" | ")}`
        );
    }

    const coverageReviewRequired = coverageGapIsReviewable(audited.audit);
    const auditIssueCount = audited.audit.meaningUnitChecks
        .filter(check => !check.accepted).length
        + audited.audit.omittedRelevantEvidence.length;
    const audit = {
        ...audited.audit,
        coverageReviewRequired,
        reviewStatus: coverageReviewRequired
            ? "stage1_audit_issues_need_researcher_review"
            : "verified"
    };

    return {
        ...generated.analysis,
        caseSummary: coverageReviewRequired
            ? `${generated.analysis.caseSummary} The independent audit identified ${auditIssueCount} Stage 1 issue${auditIssueCount === 1 ? "" : "s"} for researcher review; the proposal is preserved and is not represented as fully verified.`
            : generated.analysis.caseSummary,
        audit,
        inputTokenCount: totalInputTokens || null,
        outputTokenCount: totalOutputTokens || null
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
