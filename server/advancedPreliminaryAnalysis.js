import { ensureEnglishTranslations } from "./messageTranslation.js";
import {
    isConversationalCourtesy,
    prepareParticipantMessages
} from "./analysisCore.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { normalizeOpenAIModel } from "./modelConfiguration.js";

export const ADVANCED_PRELIMINARY_PROVIDER = "openai";
export const ADVANCED_PRELIMINARY_MODEL = "gpt-5.6-sol";
export const ADVANCED_PRELIMINARY_REASONING_EFFORT = "high";
export const ADVANCED_PRELIMINARY_ANALYSIS_VERSION =
    "advanced-preliminary-v3-overlapping-categories";
export const ADVANCED_PRELIMINARY_PROMPT_VERSION =
    "advanced-preliminary-prompt-v3-many-to-many-categories";

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
                    "label", "definition", "rationale",
                    "meaning_unit_numbers"
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
                required: [
                    "label", "definition", "rationale", "code_numbers"
                ],
                additionalProperties: false
            }
        },
        case_summary: { type: "string" }
    },
    required: ["meaning_units", "codes", "categories", "case_summary"],
    additionalProperties: false
};

const auditSchema = {
    type: "object",
    properties: {
        code_checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    code_number: { type: "integer" },
                    label: { type: "string" },
                    transcript_grounded: { type: "boolean" },
                    analytical_concept: { type: "boolean" },
                    not_case_paraphrase: { type: "boolean" },
                    potentially_reusable: { type: "boolean" },
                    appropriately_specific: { type: "boolean" },
                    meaning_unit_fit: { type: "boolean" },
                    explanation: { type: "string" }
                },
                required: [
                    "code_number", "label", "transcript_grounded",
                    "analytical_concept", "not_case_paraphrase",
                    "potentially_reusable", "appropriately_specific",
                    "meaning_unit_fit", "explanation"
                ],
                additionalProperties: false
            }
        },
        category_checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    category_number: { type: "integer" },
                    label: { type: "string" },
                    derived_from_codes: { type: "boolean" },
                    coherent_grouping: { type: "boolean" },
                    higher_order_abstraction: { type: "boolean" },
                    no_theme_claim: { type: "boolean" },
                    explanation: { type: "string" }
                },
                required: [
                    "category_number", "label", "derived_from_codes",
                    "coherent_grouping", "higher_order_abstraction",
                    "no_theme_claim", "explanation"
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
        summary_uses_only_coded_evidence: { type: "boolean" },
        overall_summary: { type: "string" }
    },
    required: [
        "code_checks", "category_checks", "full_transcript_coverage",
        "omitted_relevant_evidence", "summary_uses_only_coded_evidence",
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

function labelIsAnalytical(value, maximumWords = 5) {
    const label = normalizedText(value)?.replace(/\s+/gu, " ");
    if (!label || label.length > 100 || /[.!?;:/|&_]/u.test(label)) {
        return false;
    }
    const words = label.split(" ").filter(Boolean);
    return words.length <= maximumWords
        && !/\b(?:and|or|but|because|although)\b/iu.test(label);
}

function uniqueIntegers(values, maximum) {
    return [...new Set((Array.isArray(values) ? values : []).filter(value =>
        Number.isInteger(value) && value > 0 && value <= maximum
    ))];
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

    const codes = [];
    const codeLabels = new Set();
    (Array.isArray(value?.codes) ? value.codes : []).forEach((raw, index) => {
        const label = normalizedText(raw?.label)?.replace(/\s+/gu, " ");
        const definition = normalizedText(raw?.definition);
        const rationale = normalizedText(raw?.rationale);
        const meaningUnitNumbers = uniqueIntegers(
            raw?.meaning_unit_numbers,
            meaningUnits.length
        );
        const labelKey = label?.toLocaleLowerCase();
        if (!labelIsAnalytical(label) || !definition || !rationale
            || !meaningUnitNumbers.length || codeLabels.has(labelKey)) {
            invalidReasons.push(
                `CO${index + 1} lacks a distinct concise concept, definition, rationale, or valid meaning-unit link.`
            );
            return;
        }
        codeLabels.add(labelKey);
        codes.push({ label, definition, rationale, meaningUnitNumbers });
    });

    const categories = [];
    const categoryLabels = new Set();
    // Coverage tracker only: an existing link never invalidates another link.
    const groupedCodeNumbers = new Set();
    (Array.isArray(value?.categories) ? value.categories : [])
        .forEach((raw, index) => {
            const label = normalizedText(raw?.label)?.replace(/\s+/gu, " ");
            const definition = normalizedText(raw?.definition);
            const rationale = normalizedText(raw?.rationale);
            const codeNumbers = uniqueIntegers(raw?.code_numbers, codes.length);
            const labelKey = label?.toLocaleLowerCase();
            if (!labelIsAnalytical(label, 8) || !definition || !rationale
                || codeNumbers.length < 2 || categoryLabels.has(labelKey)) {
                invalidReasons.push(
                    `CA${index + 1} does not form a distinct higher-order grouping of at least two valid codes with a label, definition, and rationale.`
                );
                return;
            }
            categoryLabels.add(labelKey);
            codeNumbers.forEach(number => groupedCodeNumbers.add(number));
            categories.push({ label, definition, rationale, codeNumbers });
        });

    const unassignedCodeNumbers = codes
        .map((_, index) => index + 1)
        .filter(number => !groupedCodeNumbers.has(number));
    const caseSummary = normalizedText(value?.case_summary);
    const categoriesRequired = codes.length >= 2;
    const complete = Boolean(
        meaningUnits.length
        && codes.length
        && caseSummary
        && (!categoriesRequired || categories.length)
        && !invalidReasons.length
    );

    return {
        meaningUnits,
        codes,
        categories,
        unassignedCodeNumbers,
        caseSummary,
        invalidReasons,
        complete
    };
}

export function validateAdvancedPreliminaryAudit(analysis, value) {
    const codeChecksByNumber = new Map();
    (Array.isArray(value?.code_checks) ? value.code_checks : [])
        .forEach(check => {
            if (Number.isInteger(check?.code_number)) {
                codeChecksByNumber.set(check.code_number, check);
            }
        });
    const categoryChecksByNumber = new Map();
    (Array.isArray(value?.category_checks) ? value.category_checks : [])
        .forEach(check => {
            if (Number.isInteger(check?.category_number)) {
                categoryChecksByNumber.set(check.category_number, check);
            }
        });

    const codeChecks = analysis.codes.map((code, index) => {
        const check = codeChecksByNumber.get(index + 1);
        const accepted = Boolean(
            check?.label === code.label
            && check?.transcript_grounded
            && check?.analytical_concept
            && check?.not_case_paraphrase
            && check?.potentially_reusable
            && check?.appropriately_specific
            && check?.meaning_unit_fit
        );
        return {
            codeNumber: index + 1,
            label: code.label,
            transcriptGrounded: Boolean(check?.transcript_grounded),
            analyticalConcept: Boolean(check?.analytical_concept),
            notCaseParaphrase: Boolean(check?.not_case_paraphrase),
            potentiallyReusable: Boolean(check?.potentially_reusable),
            appropriatelySpecific: Boolean(check?.appropriately_specific),
            meaningUnitFit: Boolean(check?.meaning_unit_fit),
            explanation: normalizedText(check?.explanation)
                || "The independent audit did not return this code.",
            accepted
        };
    });
    const categoryChecks = analysis.categories.map((category, index) => {
        const check = categoryChecksByNumber.get(index + 1);
        const accepted = Boolean(
            check?.label === category.label
            && check?.derived_from_codes
            && check?.coherent_grouping
            && check?.higher_order_abstraction
            && check?.no_theme_claim
        );
        return {
            categoryNumber: index + 1,
            label: category.label,
            derivedFromCodes: Boolean(check?.derived_from_codes),
            coherentGrouping: Boolean(check?.coherent_grouping),
            higherOrderAbstraction: Boolean(check?.higher_order_abstraction),
            noThemeClaim: Boolean(check?.no_theme_claim),
            explanation: normalizedText(check?.explanation)
                || "The independent audit did not return this category.",
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
    const summaryUsesOnlyCodedEvidence = Boolean(
        value?.summary_uses_only_coded_evidence
    );
    return {
        codeChecks,
        categoryChecks,
        fullTranscriptCoverage,
        omittedRelevantEvidence,
        summaryUsesOnlyCodedEvidence,
        overallSummary: normalizedText(value?.overall_summary)
            || "No audit summary was supplied.",
        complete: Boolean(
            codeChecks.length === codeChecksByNumber.size
            && categoryChecks.length === categoryChecksByNumber.size
            && codeChecks.every(check => check.accepted)
            && categoryChecks.every(check => check.accepted)
            && fullTranscriptCoverage
            && !omittedRelevantEvidence.length
            && summaryUsesOnlyCodedEvidence
        )
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

function draftForAudit(analysis) {
    return {
        meaning_units: analysis.meaningUnits.map(unit => ({
            message_id: unit.messageId,
            exact_source_text: unit.exactSourceText,
            context_note: unit.contextNote
        })),
        codes: analysis.codes.map(code => ({
            label: code.label,
            definition: code.definition,
            rationale: code.rationale,
            meaning_unit_numbers: code.meaningUnitNumbers
        })),
        categories: analysis.categories.map(category => ({
            label: category.label,
            definition: category.definition,
            rationale: category.rationale,
            code_numbers: category.codeNumbers
        })),
        case_summary: analysis.caseSummary
    };
}

function analysisInstruction({ projectName, researchTopic }) {
    const scope = researchTopic || "Sleeping habits";
    return [
        "Analyze exactly one completed interview independently from its original transcript. No prior meaning unit, code, category, theme, report, corpus vocabulary, or codebook is supplied or permitted as analytical input.",
        `Research project: ${projectName || "Historical sleeping-habits dataset"}. Research topic/scope: ${scope}. Include an activity only when the participant or transcript makes its connection to the research topic explicit.`,
        "Stop at preliminary categories. Do not generate themes, tentative themes, refined codes, cross-case comparisons, frequencies, or a global codebook.",
        "First segment the participant transcript into research-relevant Meaning Units. Each Meaning Unit must be the smallest sufficient coherent span that preserves its meaning in context. Copy exact_source_text verbatim from original_text, never from analysis_text or a prior report. Use occurrence_index to identify a repeated span. Do not standardize Meaning Units and do not include greetings, thanks, farewells, or other conversational courtesies.",
        "Then generate preliminary analytical codes. A code identifies the concept expressed by one or more Meaning Units; it is not a shortened retelling of a participant sentence. Make each label concise, conceptually meaningful, potentially reusable, and specific enough to preserve genuine distinctions. Prefer a familiar one-to-five-word concept such as Late bedtime. Do not include a participant-specific clock time, personal circumstance, pronoun, sentence, or compound list merely because it appears in one Meaning Unit.",
        "One Meaning Unit may support multiple codes only when it contains multiple analytically distinct concepts. One code may govern multiple Meaning Units when they express the same concept. Do not manufacture codes or collapse different meanings.",
        "After coding within this case, derive preliminary categories only from relationships among the generated codes. Each category must group at least two related codes into one coherent higher-order descriptive concept. Leave a firm code unassigned when no justified category exists. Categories remain case-based and need not match another case.",
        "Preserve complete Category → Code → Meaning Unit → original transcript-message traceability. C01 and CA01 are presentation positions only; the database will assign stable object IDs.",
        "Frequency never determines analytical meaning or code order. Keep codes in case-grounded analytical order; do not rank or renumber them by frequency. Frequency remains separately calculable metadata.",
        "Full-transcript coverage is mandatory. Before returning, reread every participant message from beginning to end. Every substantive meaning explicitly relevant to the research topic must appear as an exact Meaning Unit and link to at least one code. Do not stop coding because similar evidence appeared earlier. Exclude greetings, phatic text, and substantively unrelated material, but never omit relevant later evidence such as a stated preference, desired change, problem, condition, routine, consequence, or evaluation.",
        "The case summary may mention only meanings represented in the coded Meaning Units. It must not introduce or repeat uncoded transcript evidence.",
        "Return the complete structured result and no theme layer."
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
                "Act as an independent qualitative-analysis auditor for exactly one case.",
                "Return one code_check for every numbered code and one category_check for every numbered category, with no missing or extra checks.",
                "Reject a code when it is merely a shortened participant-specific paraphrase, contains incidental details instead of an analytical concept, imports an unsupported explanation, is too broad to preserve meaning, or does not fit every assigned Meaning Unit.",
                "Potentially reusable means the concept could govern another Meaning Unit with equivalent meaning; it does not mean that another case was consulted or that a global codebook exists.",
                "Reject a category unless it is derived from all and only its linked codes, forms one coherent higher-order grouping, and remains a preliminary category rather than a theme claim.",
                "Perform a separate full-transcript coverage pass after the code and category checks. Read every participant message from beginning to end and compare it against all proposed Meaning Units. Set full_transcript_coverage=true only when every substantive study-relevant meaning is represented by an exact Meaning Unit linked to a code. Put every omitted relevant span in omitted_relevant_evidence with its message ID, exact original text, and explanation. An omitted later or low-frequency meaning is still a failure.",
                "Set summary_uses_only_coded_evidence=true only when every claim in the case summary is supported by the proposed coded Meaning Units. Frequency and code position are not coverage tests.",
                "Audit only the supplied transcript and draft. Do not compare cases and do not invent a replacement analysis in the audit response.",
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
            "Create a complete replacement directly from the original transcript. Do not reuse invalid spans or add a theme layer."
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
            "Repair every rejected code or category and add every omitted substantive research-relevant span as an exact original-language Meaning Unit linked to an analytical code. Remove any case-summary claim that is not supported by coded Meaning Units. Recheck the full transcript from beginning to end. Do not rank codes by frequency. Preserve all traceability and return no themes."
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

    if (!audited.audit.complete) {
        const failures = [
            ...audited.audit.codeChecks.filter(check => !check.accepted)
                .map(check => `CO${check.codeNumber} ${check.label}: ${check.explanation}`),
            ...audited.audit.categoryChecks.filter(check => !check.accepted)
                .map(check => `CA${check.categoryNumber} ${check.label}: ${check.explanation}`),
            ...(!audited.audit.fullTranscriptCoverage
                ? ["Full-transcript coverage failed: substantive research-relevant evidence was omitted."]
                : []),
            ...audited.audit.omittedRelevantEvidence.map(item =>
                `Omitted evidence in message ${item.messageId}: ${item.exactSourceText} (${item.explanation})`
            ),
            ...(!audited.audit.summaryUsesOnlyCodedEvidence
                ? ["The case summary contains a claim not supported by coded Meaning Units."]
                : [])
        ];
        throw new Error(
            `The advanced preliminary analysis failed its independent concept audit: ${failures.join(" | ")}`
        );
    }

    return {
        ...generated.analysis,
        audit: audited.audit,
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
