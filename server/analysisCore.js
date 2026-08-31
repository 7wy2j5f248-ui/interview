import { storedIdentifier } from "./corpus.js";
import { DEFAULT_OPENAI_MODEL } from "./modelConfiguration.js";
import { analysisFrameworkInstruction } from "./analysisFramework.js";

export const QUALITATIVE_ANALYSIS_MODEL = DEFAULT_OPENAI_MODEL;
export const QUALITATIVE_ANALYSIS_VERSION = "task-014-v7-complete-cases-before-summary";
export const AUTOMATIC_CASE_ANALYSIS_VERSION =
    "case-analysis-v4-theme-hierarchy-audited";
export const AUTOMATIC_CASE_REANALYSIS_VERSION =
    "case-reanalysis-v3-theme-hierarchy-audited";
export const DEFAULT_ANALYSIS_BATCH_SIZE = 40;
export const MAX_THEME_SUBJECT_WORDS = 3;
export const MAX_THEME_SUBJECT_LENGTH = 60;

function normalizedText(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
}

export function isNaturalAnalyticLabelShape(value) {
    const label = normalizedText(value)?.replace(/\s+/gu, " ");

    if (!label || label.length > MAX_THEME_SUBJECT_LENGTH) {
        return false;
    }

    const words = label.split(" ").filter(Boolean);
    return words.length <= MAX_THEME_SUBJECT_WORDS
        && !/[.!?;:,/|&]/u.test(label)
        && !/\b(?:and|or|but|because|while|although)\b/iu.test(label)
        && !/\b(?:affects|causes|creates|disrupts|improves|increases|interrupts|leads|prevents|reduces|supports|worsens)\b/iu.test(label);
}

export function isShortThemeSubject(value) {
    return isNaturalAnalyticLabelShape(value);
}

function normalizedList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return [...new Set(
        value
            .map(normalizedText)
            .filter(Boolean)
    )];
}

export function isParticipantMessage(row) {
    const speaker = normalizedText(row?.Speaker)?.toLowerCase();
    return speaker === "user" || speaker === "participant";
}

export function prepareParticipantMessages(rows) {
    const messages = [];
    let skippedRecords = 0;

    (Array.isArray(rows) ? rows : []).forEach(row => {
        const id = storedIdentifier(row?.id);
        const originalText = normalizedText(row?.Message);

        if (!id || !originalText || !isParticipantMessage(row)) {
            skippedRecords += 1;
            return;
        }

        const language = normalizedText(row?.Language)?.toLowerCase() || null;
        const englishTranslation = normalizedText(row?.EnglishTranslation);

        messages.push({
            id,
            sessionId: storedIdentifier(row?.Session),
            participantId: storedIdentifier(row?.Participant),
            language,
            timestamp: normalizedText(row?.Timestamp),
            originalText,
            englishTranslation,
            analysisText: language === "en"
                ? originalText
                : englishTranslation || originalText
        });
    });

    return { messages, skippedRecords };
}

export function buildAnalysisBatches(
    messages,
    batchSize = DEFAULT_ANALYSIS_BATCH_SIZE
) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error("Analysis batch size must be a positive integer.");
    }

    const groups = [];
    const groupByKey = new Map();

    messages.forEach(message => {
        const key = message.sessionId || `legacy:${message.id}`;

        if (!groupByKey.has(key)) {
            const group = [];
            groupByKey.set(key, group);
            groups.push(group);
        }

        groupByKey.get(key).push(message);
    });

    const batches = [];
    let currentBatch = [];

    function commitCurrentBatch() {
        if (currentBatch.length) {
            batches.push(currentBatch);
            currentBatch = [];
        }
    }

    groups.forEach(group => {
        if (group.length > batchSize) {
            commitCurrentBatch();

            for (let index = 0; index < group.length; index += batchSize) {
                batches.push(group.slice(index, index + batchSize));
            }

            return;
        }

        if (currentBatch.length + group.length > batchSize) {
            commitCurrentBatch();
        }

        currentBatch.push(...group);
    });

    commitCurrentBatch();
    return batches;
}

export function buildIndividualCaseBatches(messages) {
    const cases = [];
    const caseByKey = new Map();

    (Array.isArray(messages) ? messages : []).forEach(message => {
        const key = message.sessionId
            || `legacy:${message.participantId || message.id}`;

        if (!caseByKey.has(key)) {
            const individualCase = [];
            caseByKey.set(key, individualCase);
            cases.push(individualCase);
        }

        caseByKey.get(key).push(message);
    });

    return cases;
}

function responseText(response) {
    const candidates = [
        response?.output_text,
        ...(response?.output || []).flatMap(item =>
            (item?.content || []).map(content => content?.text)
        )
    ];

    return candidates.find(candidate =>
        typeof candidate === "string" && candidate.trim()
    )?.trim() || "";
}

function parseStructuredResponse(response, description) {
    const text = responseText(response);

    if (!text) {
        throw new Error(`${description} was empty.`);
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${description} was malformed.`, { cause: error });
    }
}

function messagesForModel(messages) {
    return JSON.stringify(messages.map(message => ({
        message_id: message.id,
        session_id: message.sessionId,
        language: message.language,
        original_text: message.originalText,
        english_translation: message.englishTranslation,
        analysis_text: message.analysisText
    })));
}

const suggestionSchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    theme: { type: "string" },
                    codes: { type: "array", items: { type: "string" } },
                    coded_phrases: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                phrase: { type: "string" },
                                message_ids: {
                                    type: "array",
                                    items: { type: "string" }
                                }
                            },
                            required: ["phrase", "message_ids"],
                            additionalProperties: false
                        }
                    },
                    keywords: { type: "array", items: { type: "string" } },
                    supporting_message_ids: {
                        type: "array",
                        items: { type: "string" }
                    },
                    code_evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                code: { type: "string" },
                                message_ids: {
                                    type: "array",
                                    items: { type: "string" }
                                }
                            },
                            required: ["code", "message_ids"],
                            additionalProperties: false
                        }
                    },
                    keyword_evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                keyword: { type: "string" },
                                message_ids: {
                                    type: "array",
                                    items: { type: "string" }
                                }
                            },
                            required: ["keyword", "message_ids"],
                            additionalProperties: false
                        }
                    },
                    rationale: { type: "string" }
                },
                required: [
                    "theme",
                    "codes",
                    "coded_phrases",
                    "keywords",
                    "supporting_message_ids",
                    "code_evidence",
                    "keyword_evidence",
                    "rationale"
                ],
                additionalProperties: false
            }
        }
    },
    required: ["items"],
    additionalProperties: false
};

function nullableEvidenceSchema(valueType) {
    return {
        type: "object",
        properties: {
            value: { type: [valueType, "null"] },
            message_id: { type: ["string", "null"] },
            exact_text: { type: ["string", "null"] },
            basis: {
                type: ["string", "null"],
                enum: ["stated", "derived", null]
            }
        },
        required: ["value", "message_id", "exact_text", "basis"],
        additionalProperties: false
    };
}

const automaticDemographicSchema = {
    type: "object",
    properties: {
        current_country: nullableEvidenceSchema("string"),
        current_region: nullableEvidenceSchema("string"),
        country_of_origin: nullableEvidenceSchema("string"),
        diaspora_status: nullableEvidenceSchema("string"),
        gender: nullableEvidenceSchema("string"),
        age: nullableEvidenceSchema("integer"),
        birth_year: nullableEvidenceSchema("integer"),
        birth_cohort: nullableEvidenceSchema("string"),
        youth_status: nullableEvidenceSchema("string"),
        occupation: nullableEvidenceSchema("string"),
        education_level: nullableEvidenceSchema("string"),
        social_identity: nullableEvidenceSchema("string")
    },
    required: [
        "current_country",
        "current_region",
        "country_of_origin",
        "diaspora_status",
        "gender",
        "age",
        "birth_year",
        "birth_cohort",
        "youth_status",
        "occupation",
        "education_level",
        "social_identity"
    ],
    additionalProperties: false
};

const automaticCaseSchema = {
    type: "object",
    properties: {
        demographics: automaticDemographicSchema,
        codes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    rationale: { type: "string" },
                    keyword_evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                message_id: { type: "string" },
                                exact_text: { type: "string" }
                            },
                            required: ["message_id", "exact_text"],
                            additionalProperties: false
                        }
                    }
                },
                required: ["label", "rationale", "keyword_evidence"],
                additionalProperties: false
            }
        },
        themes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    rationale: { type: "string" },
                    code_numbers: {
                        type: "array",
                        items: { type: "integer" }
                    }
                },
                required: ["label", "rationale", "code_numbers"],
                additionalProperties: false
            }
        },
        case_interpretation: { type: "string" }
    },
    required: ["demographics", "codes", "themes", "case_interpretation"],
    additionalProperties: false
};

const automaticThemeSchema = {
    type: "object",
    properties: {
        themes: automaticCaseSchema.properties.themes
    },
    required: ["themes"],
    additionalProperties: false
};

const automaticCaseRelevanceAuditSchema = {
    type: "object",
    properties: {
        checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    code_number: { type: "integer" },
                    message_id: { type: "string" },
                    exact_text: { type: "string" },
                    transcript_grounded: { type: "boolean" },
                    supports_code: { type: "boolean" },
                    supports_theme: { type: "boolean" },
                    research_scope_relevant: { type: "boolean" },
                    explanation: { type: "string" }
                },
                required: [
                    "code_number",
                    "message_id",
                    "exact_text",
                    "transcript_grounded",
                    "supports_code",
                    "supports_theme",
                    "research_scope_relevant",
                    "explanation"
                ],
                additionalProperties: false
            }
        },
        overall_summary: { type: "string" }
    },
    required: ["checks", "overall_summary"],
    additionalProperties: false
};

const automaticLabelQualityAuditSchema = {
    type: "object",
    properties: {
        checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["code", "theme"] },
                    number: { type: "integer" },
                    label: { type: "string" },
                    natural_language: { type: "boolean" },
                    coherent_concept: { type: "boolean" },
                    conceptually_distinct: { type: "boolean" },
                    evidence_supported: { type: "boolean" },
                    topic_relevant: { type: "boolean" },
                    comparison_useful: { type: "boolean" },
                    theme_has_multiple_codes: { type: "boolean" },
                    theme_semantic_coverage: { type: "boolean" },
                    theme_higher_level_abstraction: { type: "boolean" },
                    theme_not_one_to_one_paraphrase: { type: "boolean" },
                    theme_coherent_story: { type: "boolean" },
                    explanation: { type: "string" }
                },
                required: [
                    "kind",
                    "number",
                    "label",
                    "natural_language",
                    "coherent_concept",
                    "conceptually_distinct",
                    "evidence_supported",
                    "topic_relevant",
                    "comparison_useful",
                    "theme_has_multiple_codes",
                    "theme_semantic_coverage",
                    "theme_higher_level_abstraction",
                    "theme_not_one_to_one_paraphrase",
                    "theme_coherent_story",
                    "explanation"
                ],
                additionalProperties: false
            }
        },
        ungrouped_code_checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    code_number: { type: "integer" },
                    label: { type: "string" },
                    review_needed: { type: "boolean" },
                    reason: { type: "string" }
                },
                required: [
                    "code_number",
                    "label",
                    "review_needed",
                    "reason"
                ],
                additionalProperties: false
            }
        },
        overall_summary: { type: "string" }
    },
    required: ["checks", "ungrouped_code_checks", "overall_summary"],
    additionalProperties: false
};

const CONVERSATIONAL_COURTESIES = new Set([
    "hi", "hello", "hello there", "hey", "greetings", "good morning",
    "good afternoon", "good evening", "thanks", "thank you",
    "thank you very much", "bye", "goodbye",
    "你好", "您好", "早上好", "下午好", "晚上好", "谢谢", "再见",
    "مرحبا", "أهلا", "السلام عليكم", "شكرا", "مع السلامة",
    "hola", "buenos días", "buenas tardes", "gracias", "adiós",
    "bonjour", "bonsoir", "merci", "au revoir",
    "olá", "bom dia", "boa tarde", "obrigado", "obrigada", "tchau",
    "merhaba", "günaydın", "teşekkürler", "hoşça kal",
    "नमस्ते", "नमस्कार", "धन्यवाद", "अलविदा",
    "হ্যালো", "নমস্কার", "ধন্যবাদ", "বিদায়",
    "xin chào", "chào bạn", "cảm ơn", "tạm biệt",
    "வணக்கம்", "நன்றி", "பிரியாவிடை",
    "habari", "jambo", "asante", "kwa heri",
    "سلام", "السلام علیکم", "شکریہ", "خدا حافظ",
    "halo", "selamat pagi", "terima kasih", "sampai jumpa",
    "salaan", "mahadsanid", "nabad gelyo",
    "မင်္ဂလာပါ", "ကျေးဇူးတင်ပါတယ်", "နှုတ်ဆက်ပါတယ်",
    "درود", "سلام", "صبح بخیر", "تشکر", "ممنون", "خداحافظ"
].map(value => normalizedCourtesy(value)));

function normalizedCourtesy(value) {
    return (typeof value === "string" ? value : "")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function isConversationalCourtesy(value) {
    const normalized = normalizedCourtesy(value);
    return Boolean(normalized) && CONVERSATIONAL_COURTESIES.has(normalized);
}

function exactTextOccurrences(source, phrase) {
    const sourceText = typeof source === "string" ? source : "";
    const exactText = normalizedText(phrase);

    if (!sourceText || !exactText) {
        return [];
    }

    const haystack = sourceText.toLocaleLowerCase();
    const needle = exactText.toLocaleLowerCase();
    const occurrences = [];
    let startOffset = 0;

    while (startOffset <= haystack.length - needle.length) {
        const matchOffset = haystack.indexOf(needle, startOffset);

        if (matchOffset < 0) {
            break;
        }

        occurrences.push({
            exactText: sourceText.slice(
                matchOffset,
                matchOffset + exactText.length
            ),
            startOffset: matchOffset,
            endOffset: matchOffset + exactText.length
        });
        startOffset = matchOffset + Math.max(needle.length, 1);
    }

    return occurrences;
}

function validateAutomaticThemes(rawThemes, codes) {
    const themes = [];
    const assignedCodeNumbers = new Set();
    const invalidLabels = [];
    const rejectedThemeAssignments = [];
    let invalidThemes = 0;

    (Array.isArray(rawThemes) ? rawThemes : []).forEach(rawTheme => {
        const label = normalizedText(rawTheme?.label);
        const rationale = normalizedText(rawTheme?.rationale);
        const codeNumbers = [...new Set(
            (Array.isArray(rawTheme?.code_numbers)
                ? rawTheme.code_numbers
                : []
            ).filter(number =>
                Number.isInteger(number)
                && number > 0
                && number <= codes.length
            )
        )];

        if (!isShortThemeSubject(label)
            || !rationale
            || codeNumbers.length < 2
        ) {
            invalidThemes += 1;
            if (!isShortThemeSubject(label)) {
                invalidLabels.push({ kind: "theme", label: label || "" });
            }
            rejectedThemeAssignments.push({
                label: label || "",
                codeNumbers,
                reason: codeNumbers.length < 2
                    ? "A theme requires at least two semantically related codes; a one-code theme is not permitted."
                    : "The proposed theme label or rationale failed structural validation."
            });
            return;
        }

        codeNumbers.forEach(number => assignedCodeNumbers.add(number));
        themes.push({ label, rationale, codeNumbers });
    });

    const unassignedCodeNumbers = codes
        .map((_, index) => index + 1)
        .filter(number => !assignedCodeNumbers.has(number));

    return {
        themes,
        invalidThemes,
        unassignedCodeNumbers,
        invalidLabels,
        rejectedThemeAssignments
    };
}

const AUTOMATIC_DEMOGRAPHIC_FIELDS = Object.freeze([
    ["current_country", "text"],
    ["current_region", "text"],
    ["country_of_origin", "text"],
    ["diaspora_status", "text"],
    ["gender", "text"],
    ["age", "age"],
    ["birth_year", "birth_year"],
    ["birth_cohort", "birth_cohort"],
    ["youth_status", "text"],
    ["occupation", "text"],
    ["education_level", "text"],
    ["social_identity", "text"]
]);

function normalizedDemographicValue(value, type) {
    if (type === "age") {
        return Number.isInteger(value) && value >= 0 && value <= 130
            ? value
            : null;
    }

    if (type === "birth_year") {
        return Number.isInteger(value) && value >= 1000 && value <= 9999
            ? value
            : null;
    }

    const text = normalizedText(value);

    if (type !== "birth_cohort") {
        return text;
    }

    return text && (
        [
            "unidentified",
            "not_asked",
            "declined",
            "unclear",
            "not_applicable"
        ].includes(text)
        || /^(post|pre)_[0-9]{4}s$/u.test(text)
    ) ? text : null;
}

function validateAutomaticDemographics(value, messagesById) {
    const demographics = {};
    const descriptorSources = {};
    let invalidDemographicEvidence = 0;

    AUTOMATIC_DEMOGRAPHIC_FIELDS.forEach(([field, type]) => {
        const entry = value?.[field];

        if (entry?.value === null || entry?.value === undefined) {
            return;
        }

        const normalizedValue = normalizedDemographicValue(entry.value, type);
        const messageId = normalizedText(entry.message_id);
        const message = messagesById.get(messageId);
        const occurrences = exactTextOccurrences(
            message?.originalText,
            entry.exact_text
        );
        const basis = entry?.basis === "derived" ? "derived" : "stated";
        const numericEvidenceMatches = !["age", "birth_year"].includes(type)
            || occurrences.some(occurrence =>
                occurrence.exactText.includes(String(normalizedValue))
            );

        if (normalizedValue === null
            || !message
            || !occurrences.length
            || !numericEvidenceMatches
        ) {
            invalidDemographicEvidence += 1;
            return;
        }

        if (field === "occupation") {
            demographics.additional_descriptors = {
                ...(demographics.additional_descriptors || {}),
                occupation: normalizedValue
            };
        } else {
            demographics[field] = normalizedValue;
        }

        descriptorSources[field] = {
            source_message_id: messageId,
            raw_answer: occurrences[0].exactText,
            extracted_segment: occurrences[0].exactText,
            basis,
            extraction_method: AUTOMATIC_CASE_ANALYSIS_VERSION
        };
    });

    return { demographics, descriptorSources, invalidDemographicEvidence };
}

export function validateAutomaticCaseAnalysis(value, availableMessages) {
    const messagesById = new Map(
        (Array.isArray(availableMessages) ? availableMessages : [])
            .map(message => [message.id, message])
    );
    const codes = [];
    const usedHighlights = new Set();
    const invalidLabels = [];
    let invalidEvidence = 0;
    let droppedCodes = 0;

    (Array.isArray(value?.codes) ? value.codes : []).forEach(rawCode => {
        const label = normalizedText(rawCode?.label);
        const rationale = normalizedText(rawCode?.rationale);
        const highlights = [];

        (Array.isArray(rawCode?.keyword_evidence)
            ? rawCode.keyword_evidence
            : []
        ).forEach(evidence => {
            const messageId = normalizedText(evidence?.message_id);
            const message = messagesById.get(messageId);
            const occurrences = exactTextOccurrences(
                message?.originalText,
                evidence?.exact_text
            );

            if (!message
                || isConversationalCourtesy(evidence?.exact_text)
                || !occurrences.length
            ) {
                invalidEvidence += 1;
                return;
            }

            occurrences.forEach(occurrence => {
                const key = `${messageId}:${occurrence.startOffset}:${occurrence.endOffset}`;

                if (usedHighlights.has(key)) {
                    return;
                }

                usedHighlights.add(key);
                highlights.push({ messageId, ...occurrence });
            });
        });

        if (!isNaturalAnalyticLabelShape(label)
            || !rationale
            || !highlights.length) {
            invalidEvidence += 1;
            droppedCodes += 1;
            if (!isNaturalAnalyticLabelShape(label)) {
                invalidLabels.push({ kind: "code", label: label || "" });
            }
            return;
        }

        codes.push({ label, rationale, highlights });
    });

    const themeValidation = validateAutomaticThemes(value?.themes, codes);
    const {
        themes,
        unassignedCodeNumbers,
        rejectedThemeAssignments
    } = themeValidation;
    invalidLabels.push(...themeValidation.invalidLabels);
    invalidEvidence += themeValidation.invalidThemes;
    const demographicValidation = validateAutomaticDemographics(
        value?.demographics,
        messagesById
    );

    const caseInterpretation = normalizedText(value?.case_interpretation);

    return {
        codes,
        themes,
        caseInterpretation,
        invalidEvidence,
        droppedCodes,
        invalidLabels,
        unassignedCodeNumbers,
        rejectedThemeAssignments,
        ...demographicValidation,
        complete: Boolean(
            codes.length
            && caseInterpretation
            && droppedCodes === 0
        )
    };
}

function labelQualityKey(kind, number) {
    return `${kind}:${number}`;
}

export function validateAutomaticLabelQualityAudit(analysis, value) {
    const expected = [
        ...(analysis?.codes || []).map((record, index) => ({
            kind: "code",
            number: index + 1,
            label: record.label
        })),
        ...(analysis?.themes || []).map((record, index) => ({
            kind: "theme",
            number: index + 1,
            label: record.label,
            codeNumbers: record.codeNumbers || []
        }))
    ];
    const labelCounts = expected.reduce((counts, item) => {
        const key = `${item.kind}:${
            normalizedText(item.label)?.toLocaleLowerCase() || ""
        }`;
        counts.set(key, (counts.get(key) || 0) + 1);
        return counts;
    }, new Map());
    const auditByKey = new Map();
    let duplicateChecks = 0;

    (Array.isArray(value?.checks) ? value.checks : []).forEach(check => {
        const kind = check?.kind === "code" || check?.kind === "theme"
            ? check.kind
            : null;
        const number = Number.isInteger(check?.number) && check.number > 0
            ? check.number
            : null;
        const label = normalizedText(check?.label);
        if (!kind || !number || !label) return;
        const key = labelQualityKey(kind, number);
        if (auditByKey.has(key)) duplicateChecks += 1;
        auditByKey.set(key, {
            kind,
            number,
            label,
            naturalLanguage: check.natural_language === true,
            coherentConcept: check.coherent_concept === true,
            conceptuallyDistinct: check.conceptually_distinct === true,
            evidenceSupported: check.evidence_supported === true,
            topicRelevant: check.topic_relevant === true,
            comparisonUseful: check.comparison_useful === true,
            themeHasMultipleCodes:
                check.theme_has_multiple_codes === true,
            themeSemanticCoverage:
                check.theme_semantic_coverage === true,
            themeHigherLevelAbstraction:
                check.theme_higher_level_abstraction === true,
            themeNotOneToOneParaphrase:
                check.theme_not_one_to_one_paraphrase === true,
            themeCoherentStory:
                check.theme_coherent_story === true,
            explanation: normalizedText(check.explanation)
                || "No label-quality explanation was supplied."
        });
    });

    const checks = expected.map(item => {
        const audit = auditByKey.get(labelQualityKey(item.kind, item.number));
        const exactLabel = audit?.label === item.label;
        const structurallyValid = isNaturalAnalyticLabelShape(item.label);
        const uniqueAtLevel = labelCounts.get(
            `${item.kind}:${
                normalizedText(item.label)?.toLocaleLowerCase() || ""
            }`
        ) === 1;
        const themeHierarchyAccepted = item.kind !== "theme" || Boolean(
            item.codeNumbers.length >= 2
            && audit?.themeHasMultipleCodes
            && audit?.themeSemanticCoverage
            && audit?.themeHigherLevelAbstraction
            && audit?.themeNotOneToOneParaphrase
            && audit?.themeCoherentStory
        );
        const accepted = Boolean(
            exactLabel
            && structurallyValid
            && uniqueAtLevel
            && audit?.naturalLanguage
            && audit?.coherentConcept
            && audit?.conceptuallyDistinct
            && audit?.evidenceSupported
            && audit?.topicRelevant
            && audit?.comparisonUseful
            && themeHierarchyAccepted
        );
        return {
            ...item,
            naturalLanguage: Boolean(audit?.naturalLanguage),
            coherentConcept: Boolean(audit?.coherentConcept),
            conceptuallyDistinct: Boolean(audit?.conceptuallyDistinct)
                && uniqueAtLevel,
            evidenceSupported: Boolean(audit?.evidenceSupported),
            topicRelevant: Boolean(audit?.topicRelevant),
            comparisonUseful: Boolean(audit?.comparisonUseful),
            codeNumbers: item.codeNumbers || [],
            themeHasMultipleCodes: item.kind !== "theme"
                || Boolean(audit?.themeHasMultipleCodes)
                    && item.codeNumbers.length >= 2,
            themeSemanticCoverage: item.kind !== "theme"
                || Boolean(audit?.themeSemanticCoverage),
            themeHigherLevelAbstraction: item.kind !== "theme"
                || Boolean(audit?.themeHigherLevelAbstraction),
            themeNotOneToOneParaphrase: item.kind !== "theme"
                || Boolean(audit?.themeNotOneToOneParaphrase),
            themeCoherentStory: item.kind !== "theme"
                || Boolean(audit?.themeCoherentStory),
            structurallyValid,
            accepted,
            explanation: audit?.explanation
                || "The independent label audit did not return this record."
        };
    });
    const expectedKeys = new Set(expected.map(item =>
        labelQualityKey(item.kind, item.number)
    ));
    const unexpectedCheckCount = [...auditByKey.keys()].filter(
        key => !expectedKeys.has(key)
    ).length;
    const rejectedLabels = checks.filter(check => !check.accepted);
    const expectedUngrouped = new Map(
        (analysis?.unassignedCodeNumbers || []).map(codeNumber => [
            codeNumber,
            analysis.codes?.[codeNumber - 1]?.label || ""
        ])
    );
    const ungroupedByNumber = new Map();
    let duplicateUngroupedChecks = 0;
    (Array.isArray(value?.ungrouped_code_checks)
        ? value.ungrouped_code_checks
        : []
    ).forEach(check => {
        const codeNumber = Number.isInteger(check?.code_number)
            && check.code_number > 0
            ? check.code_number
            : null;
        if (!codeNumber) return;
        if (ungroupedByNumber.has(codeNumber)) duplicateUngroupedChecks += 1;
        ungroupedByNumber.set(codeNumber, {
            codeNumber,
            label: normalizedText(check?.label) || "",
            reviewNeeded: check?.review_needed === true,
            reason: normalizedText(check?.reason)
                || "No reason was supplied for this ungrouped code."
        });
    });
    const ungroupedCodes = [...expectedUngrouped].map(
        ([codeNumber, label]) => {
            const audit = ungroupedByNumber.get(codeNumber);
            const accepted = Boolean(
                audit?.label === label
                && audit?.reviewNeeded
                && audit?.reason
            );
            return {
                codeNumber,
                label,
                reviewNeeded: Boolean(audit?.reviewNeeded),
                reason: audit?.reason
                    || "This code has no supported multi-code theme and needs researcher review.",
                accepted
            };
        }
    );
    const unexpectedUngroupedChecks = [...ungroupedByNumber.keys()].filter(
        codeNumber => !expectedUngrouped.has(codeNumber)
    ).length;
    const hierarchyChecks = checks.filter(check => check.kind === "theme");
    const hierarchyComplete = Boolean(
        !hierarchyChecks.some(check => !check.accepted)
        && !ungroupedCodes.some(check => !check.accepted)
        && !duplicateUngroupedChecks
        && !unexpectedUngroupedChecks
    );

    return {
        checks,
        overallSummary: normalizedText(value?.overall_summary)
            || "No overall label-quality summary was supplied.",
        rejectedLabels,
        duplicateChecks,
        unexpectedCheckCount,
        themeHierarchy: {
            checks: hierarchyChecks,
            ungroupedCodes,
            rejectedThemeAssignments:
                analysis?.rejectedThemeAssignments || [],
            complete: hierarchyComplete
        },
        complete: Boolean(
            expected.length
            && !rejectedLabels.length
            && !duplicateChecks
            && !unexpectedCheckCount
            && auditByKey.size === expected.length
            && hierarchyComplete
        )
    };
}

function automaticAnalysisDraftForModel(analysis) {
    return {
        demographics: analysis.demographics,
        codes: (analysis.codes || []).map(code => ({
            label: code.label,
            rationale: code.rationale,
            keyword_evidence: (code.highlights || []).map(highlight => ({
                message_id: highlight.messageId,
                exact_text: highlight.exactText
            }))
        })),
        themes: (analysis.themes || []).map(theme => ({
            label: theme.label,
            rationale: theme.rationale,
            code_numbers: theme.codeNumbers
        })),
        case_interpretation: analysis.caseInterpretation
    };
}

async function auditAutomaticLabelQuality(
    openaiClient,
    messages,
    analysis,
    model,
    analysisFramework
) {
    const analysisForAudit = automaticAnalysisDraftForModel(analysis);
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "automatic_case_label_quality_audit",
                strict: true,
                schema: automaticLabelQualityAuditSchema
            }
        },
        input: [{
            role: "system",
            content: [
                "Act as a strict independent label-quality auditor for one qualitative case.",
                "Return exactly one check for every numbered code and theme, and no other checks.",
                "Set natural_language true only for a normal everyday English word or familiar natural phrase, never a concatenation of descriptors.",
                "Set coherent_concept true only when the whole label names one meaningful concept rather than a finding, sentence, list, or bag of words.",
                "Set conceptually_distinct true only when the label is not duplicative or confusingly overlapping with another label at the same level.",
                "Set evidence_supported true only when a code summarizes its exact keyword evidence or a theme is supported by its assigned codes.",
                "Set topic_relevant true only when the label satisfies the named project's topic, scope, inclusion, and exclusion rules.",
                "Set comparison_useful true only when another researcher could understand and compare the concept across cases without reading its rationale.",
                "For code checks, set all five theme_* fields true because they are not applicable to a code.",
                "For a theme, set theme_has_multiple_codes true only when it has at least two distinct supporting codes.",
                "Set theme_semantic_coverage true only when the theme covers the shared meaning of every assigned code, not just a repeated surface word.",
                "Set theme_higher_level_abstraction true only when the theme advances beyond its codes into a genuine higher-level concept.",
                "Set theme_not_one_to_one_paraphrase true only when the theme is not a paraphrase, slight word deletion, or relabeling of one code or keyword.",
                "Set theme_coherent_story true only when the assigned codes combine into one meaningful participant story, behavioral profile, contributing life pattern, or attitude/state.",
                "For the named project, reject a generic activity theme unless its entire code/evidence chain establishes explicit relevance to the research topic.",
                "Return exactly one ungrouped_code_check for every code number that has no assigned valid theme and no others. Mark review_needed true and explain why a second semantically related code was unavailable. Never invent a theme to avoid an ungrouped code.",
                analysisFrameworkInstruction(analysisFramework)
            ].join("\n\n")
        }, {
            role: "user",
            content: [
                `Preserved participant transcript (JSON):\n${messagesForModel(messages)}`,
                `Proposed analytical hierarchy (JSON):\n${JSON.stringify(analysisForAudit)}`
            ].join("\n\n")
        }]
    });
    return {
        audit: validateAutomaticLabelQualityAudit(
            analysis,
            parseStructuredResponse(response, "Automatic label-quality audit")
        ),
        inputTokenCount: Number.isInteger(response?.usage?.input_tokens)
            ? response.usage.input_tokens
            : null
    };
}

const evidenceSchema = {
    type: "object",
    properties: {
        evidence: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    message_id: { type: "string" },
                    codes: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                required: ["message_id", "codes"],
                additionalProperties: false
            }
        }
    },
    required: ["evidence"],
    additionalProperties: false
};

const discussionSchema = {
    type: "object",
    properties: {
        reply: { type: "string" },
        proposal: {
            type: "object",
            properties: {
                should_apply: { type: "boolean" },
                theme: { type: "string" },
                codes: {
                    type: "array",
                    items: { type: "string" }
                },
                keywords: {
                    type: "array",
                    items: { type: "string" }
                },
                code_keyword_groups: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            code: { type: "string" },
                            keywords: {
                                type: "array",
                                items: { type: "string" }
                            }
                        },
                        required: ["code", "keywords"],
                        additionalProperties: false
                    }
                },
                rationale: { type: "string" }
            },
            required: [
                "should_apply",
                "theme",
                "codes",
                "keywords",
                "code_keyword_groups",
                "rationale"
            ],
            additionalProperties: false
        }
    },
    required: ["reply", "proposal"],
    additionalProperties: false
};

function normalizedAttributionCodes(values, allowedCodes) {
    const allowedByKey = new Map(
        normalizedList(allowedCodes).map(code => [code.toLowerCase(), code])
    );

    return normalizedList(values)
        .map(code => allowedByKey.get(code.toLowerCase()))
        .filter(Boolean);
}

export function validateSuggestedItems(value, availableMessages) {
    const availableIds = new Set(availableMessages.map(message => message.id));
    const availableById = new Map(
        availableMessages.map(message => [message.id, message])
    );
    const items = [];
    let invalidEvidenceIds = 0;
    let skippedItems = 0;
    let skippedComponents = 0;

    (Array.isArray(value?.items) ? value.items : []).forEach(item => {
        const theme = normalizedText(item?.theme);
        const rationale = normalizedText(item?.rationale);
        const requestedCodes = normalizedList(item.codes);
        const requestedKeywords = normalizedList(item.keywords);
        const evidenceIds = [];

        (Array.isArray(item?.supporting_message_ids)
            ? item.supporting_message_ids
            : []
        ).forEach(value => {
            const id = normalizedText(value);

            if (!id || !availableIds.has(id)) {
                invalidEvidenceIds += 1;
                return;
            }

            if (!evidenceIds.includes(id)) {
                evidenceIds.push(id);
            }
        });

        if (!isShortThemeSubject(theme)
            || !rationale
            || evidenceIds.length === 0
        ) {
            skippedItems += 1;
            return;
        }

        const evidenceCodesById = new Map(
            evidenceIds.map(id => [id, []])
        );
        const codeMessages = new Map(
            requestedCodes.map(code => [code, []])
        );

        (Array.isArray(item?.code_evidence) ? item.code_evidence : [])
            .forEach(attribution => {
                const code = normalizedAttributionCodes(
                    [attribution?.code],
                    requestedCodes
                )[0];

                if (!code) {
                    return;
                }

                (Array.isArray(attribution?.message_ids)
                    ? attribution.message_ids
                    : []
                ).forEach(value => {
                    const id = normalizedText(value);

                    if (!id || !availableIds.has(id) || !evidenceCodesById.has(id)) {
                        invalidEvidenceIds += 1;
                        return;
                    }

                    const attributedCodes = evidenceCodesById.get(id);

                    if (!attributedCodes.includes(code)) {
                        attributedCodes.push(code);
                    }

                    if (!codeMessages.get(code).includes(id)) {
                        codeMessages.get(code).push(id);
                    }
                });
            });

        const codes = requestedCodes.filter(code => {
            const traceable = codeMessages.get(code)?.length > 0;

            if (!traceable) {
                skippedComponents += 1;
            }

            return traceable;
        });
        const keywordMessages = new Map(
            requestedKeywords.map(keyword => [keyword, []])
        );

        (Array.isArray(item?.keyword_evidence) ? item.keyword_evidence : [])
            .forEach(attribution => {
                const keyword = normalizedAttributionCodes(
                    [attribution?.keyword],
                    requestedKeywords
                )[0];

                if (!keyword) {
                    return;
                }

                (Array.isArray(attribution?.message_ids)
                    ? attribution.message_ids
                    : []
                ).forEach(value => {
                    const id = normalizedText(value);

                    if (!id || !availableIds.has(id) || !evidenceIds.includes(id)) {
                        invalidEvidenceIds += 1;
                        return;
                    }

                    if (!keywordMessages.get(keyword).includes(id)) {
                        keywordMessages.get(keyword).push(id);
                    }
                });
            });

        const keywords = requestedKeywords.filter(keyword => {
            const traceable = keywordMessages.get(keyword)?.length > 0;

            if (!traceable) {
                skippedComponents += 1;
            }

            return traceable;
        });
        const codedPhrases = [];
        const codedPhraseByKey = new Map();

        (Array.isArray(item?.coded_phrases) ? item.coded_phrases : [])
            .forEach(entry => {
                const phrase = normalizedText(entry?.phrase);

                if (!phrase) {
                    skippedComponents += 1;
                    return;
                }

                const phraseKey = phrase.toLowerCase();
                const messageIds = [];

                (Array.isArray(entry?.message_ids) ? entry.message_ids : [])
                    .forEach(value => {
                        const id = normalizedText(value);
                        const message = availableById.get(id);
                        const exactSourceText = [
                            message?.originalText,
                            message?.englishTranslation,
                            message?.analysisText
                        ].filter(Boolean).some(text =>
                            text.toLowerCase().includes(phraseKey)
                        );

                        if (!id || !evidenceIds.includes(id) || !exactSourceText) {
                            invalidEvidenceIds += 1;
                            return;
                        }

                        if (!messageIds.includes(id)) {
                            messageIds.push(id);
                        }
                    });

                if (!messageIds.length) {
                    skippedComponents += 1;
                    return;
                }

                if (codedPhraseByKey.has(phraseKey)) {
                    const existing = codedPhraseByKey.get(phraseKey);
                    existing.messageIds = [...new Set([
                        ...existing.messageIds,
                        ...messageIds
                    ])];
                    return;
                }

                const record = { phrase, messageIds };
                codedPhraseByKey.set(phraseKey, record);
                codedPhrases.push(record);
            });

        const suggestionSources = [
            ...evidenceIds.map(messageId => ({
                suggestionType: "theme",
                suggestionValue: theme,
                messageId
            })),
            ...codes.flatMap(code => codeMessages.get(code).map(messageId => ({
                suggestionType: "code",
                suggestionValue: code,
                messageId
            }))),
            ...codedPhrases.flatMap(entry => entry.messageIds.map(messageId => ({
                suggestionType: "coded_phrase",
                suggestionValue: entry.phrase,
                messageId
            }))),
            ...keywords.flatMap(keyword => keywordMessages.get(keyword).map(messageId => ({
                suggestionType: "keyword",
                suggestionValue: keyword,
                messageId
            })))
        ];

        items.push({
            theme,
            codes,
            codedPhrases: codedPhrases.map(entry => entry.phrase),
            keywords,
            rationale,
            evidenceIds,
            evidence: evidenceIds.map(messageId => ({
                messageId,
                codes: evidenceCodesById.get(messageId)
                    .filter(code => codes.includes(code))
            })),
            suggestionSources
        });
    });

    return {
        items,
        invalidEvidenceIds,
        skippedItems,
        skippedComponents
    };
}

export function validateEvidenceIds(value, availableMessages) {
    const availableIds = new Set(availableMessages.map(message => message.id));
    const messageIds = [];
    let invalidEvidenceIds = 0;

    const values = Array.isArray(value?.message_ids)
        ? value.message_ids
        : Array.isArray(value?.evidence)
            ? value.evidence.map(entry => entry?.message_id)
            : [];

    values
        .forEach(value => {
            const id = normalizedText(value);

            if (!id || !availableIds.has(id)) {
                invalidEvidenceIds += 1;
                return;
            }

            if (!messageIds.includes(id)) {
                messageIds.push(id);
            }
        });

    return { messageIds, invalidEvidenceIds };
}

export function validateEvidenceRecords(
    value,
    availableMessages,
    allowedCodes = []
) {
    const validatedIds = validateEvidenceIds(value, availableMessages);
    const recordsById = new Map(
        validatedIds.messageIds.map(messageId => [messageId, {
            messageId,
            codes: []
        }])
    );

    (Array.isArray(value?.evidence) ? value.evidence : []).forEach(entry => {
        const id = normalizedText(entry?.message_id);

        if (!recordsById.has(id)) {
            return;
        }

        const record = recordsById.get(id);
        const attributedCodes = normalizedAttributionCodes(
            entry?.codes,
            allowedCodes
        );
        record.codes = [...new Set([...record.codes, ...attributedCodes])];
    });

    return {
        ...validatedIds,
        evidence: [...recordsById.values()]
    };
}

export async function generateSuggestionsForBatch(
    openaiClient,
    messages,
    { model = QUALITATIVE_ANALYSIS_MODEL } = {}
) {
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "qualitative_analysis_suggestions",
                strict: true,
                schema: suggestionSchema
            }
        },
        input: [
            {
                role: "system",
                content: "You are producing one qualitative individual case report. The supplied evidence belongs to exactly one participant session; never compare, combine, or generalize across participants. Analyse this case bottom-up: first identify exact evidence phrases and concise keywords, then group them into concise codes, then group those codes into themes. Return the required theme-centred JSON structure only after completing that bottom-up case analysis. The case must have at least one theme when substantive answers are present. A theme is a reusable, comparable subject label, not a case summary. Prefer one word; use two or three words only when they form one familiar natural phrase. Reuse labels such as 'Sleep routine', 'Sleep duration', 'Night waking', 'Sleep strategies', 'Technology', 'Work', 'Family', 'Ageing', 'Environment', and 'Satisfaction'. For example, replace 'Stable sleep routines anchored by longstanding habits' with the theme 'Sleep routine'; put 'Stable' and 'Longstanding' under concise codes. Under 'Work', use codes such as 'Long hours', 'Overtime', 'Weekend work', or 'Overwork'. If this case covers two subjects such as work and family, create separate themes rather than a compound statement. Themes and codes must be meaningful natural-language concepts, never sentences, findings, cause-and-effect interpretations, case summaries, or concatenated descriptor bundles. Put fuller case interpretation in the rationale. Return exact supporting participant message IDs, explicit code-to-message attribution, explicit keyword-to-message attribution, and exact verbatim coded phrases. A coded phrase must appear verbatim in the original message or its supplied English translation. Never cite an ID outside this single-case evidence set. Do not invent or rewrite evidence."
            },
            {
                role: "user",
                content: `Participant evidence set (JSON):\n${messagesForModel(messages)}`
            }
        ]
    });

    const validated = validateSuggestedItems(
        parseStructuredResponse(response, "AI qualitative-analysis output"),
        messages
    );

    return {
        ...validated,
        inputTokenCount: Number.isInteger(response?.usage?.input_tokens)
            ? response.usage.input_tokens
            : null
    };
}

export async function generateAutomaticCaseAnalysis(
    openaiClient,
    messages,
    {
        model = QUALITATIVE_ANALYSIS_MODEL,
        reanalysisContext = null,
        analysisFramework = null
    } = {}
) {
    const frameworkInstruction = analysisFrameworkInstruction(
        analysisFramework
    );
    const relevanceInstruction = reanalysisContext
        ? " This is a researcher-requested re-analysis. Apply the framework's relevance boundary strictly. Exact quotation is necessary but not sufficient: each keyword must semantically support its code and that code's assigned theme. Reject unrelated cross-topic evidence. Researcher request context (JSON): "
            + JSON.stringify(reanalysisContext)
        : "";
    const systemInstruction = "Read this single completed participant transcript line by line. The entire analytical report must be written in English, regardless of the interview language. This includes every demographic value, additional descriptor, code label, code rationale, theme label, theme rationale, and the case interpretation. Only exact_text keyword evidence remains verbatim in the participant's original language because it identifies the precise highlighted source text. First extract the fixed demographic fields. Every non-null demographic value must cite one exact participant original_text phrase and its message_id. Use null when the participant did not provide the information; never guess. Birth year must be explicitly stated. Birth cohort may be derived only from an explicitly stated birth year. Diaspora status may be derived from explicit residence and origin evidence. Mark each supported value as stated or derived. Then work strictly from evidence upward. Identify analytically meaningful words or short phrases in the participant's original_text and return them verbatim as keyword evidence with their exact message_id. Keywords are research evidence, not every word in the conversation. Never select greetings, introductions, thanks, farewells, politeness formulas, interviewer-directed courtesies, or other phatic conversational language as keywords or codes. Examples to exclude include hello, hi, good morning, thank you, and their equivalents in every interview language. Never return translated wording as exact_text or invent a keyword summary label. Then categorize the substantive keyword occurrences into participant-specific codes. A code label must be a concise, everyday, coherent English concept that summarizes its related exact keyword evidence. Prefer one word; use two or three only as a familiar natural phrase. Never concatenate multiple descriptors. Finally synthesize two or more semantically related codes into each higher-level theme. A theme must advance abstraction beyond its codes and make them cohere as one meaningful participant story, behavioral profile, contributing life pattern, or attitude/state. Never create a one-code theme, a one-to-one paraphrase, or a theme based only on a shared surface word. A theme and its entire code/evidence chain must be relevant to the named project's topic. Theme labels follow the same one-word-preferred, two-or-three-word-natural-phrase limit and must be useful for comparison across cases. If a code has no genuinely related second code, leave it unassigned; the platform will preserve it as an ungrouped review-needed code. Do not invent a theme merely to assign every code. Do not compare this case with any participant. Do not invent or paraphrase evidence. Return the substantive keyword occurrences needed to make the code system inspectable without flooding it with routine conversation. Codes, themes, and demographic values are proposals with exact provenance for researcher review, not confirmed findings."
        + "\n\n" + frameworkInstruction
        + relevanceInstruction;
    const createResponse = input => openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "automatic_individual_case_analysis",
                strict: true,
                schema: automaticCaseSchema
            }
        },
        input
    });
    const transcriptJson = messagesForModel(messages);
    const response = await createResponse([
        { role: "system", content: systemInstruction },
        {
            role: "user",
            content: `Completed participant transcript (JSON):\n${transcriptJson}`
        }
    ]);
    const draft = parseStructuredResponse(
        response,
        "Automatic individual case analysis"
    );
    let validated = validateAutomaticCaseAnalysis(draft, messages);
    let inputTokenCount = Number.isInteger(response?.usage?.input_tokens)
        ? response.usage.input_tokens
        : null;

    if (!validated.complete
        || validated.invalidDemographicEvidence > 0
        || validated.rejectedThemeAssignments.length > 0
    ) {
        const repairResponse = await createResponse([
            {
                role: "system",
                content: systemInstruction
                    + " Correct the supplied draft into a complete replacement. Preserve valid exact evidence. Remove or replace non-verbatim evidence and restore any dropped code using exact evidence. Keep a theme only when it synthesizes at least two semantically related codes into a coherent higher-level participant story relevant to the project topic. Remove one-code, paraphrase, superficial-term, or topic-detached themes. Leave a code unassigned when no valid multi-code theme exists; never invent a theme merely to assign it. Return the entire corrected JSON object."
            },
            {
                role: "user",
                content: [
                    `Completed participant transcript (JSON):\n${transcriptJson}`,
                    `Draft requiring correction (JSON):\n${JSON.stringify(draft)}`,
                    "Validation problems (JSON):",
                    JSON.stringify({
                        invalidEvidence: validated.invalidEvidence,
                        invalidDemographicEvidence:
                            validated.invalidDemographicEvidence,
                        droppedCodes: validated.droppedCodes,
                        invalidLabels: validated.invalidLabels,
                        rejectedThemeAssignments:
                            validated.rejectedThemeAssignments,
                        unassignedCodeNumbers:
                            validated.unassignedCodeNumbers
                    })
                ].join("\n\n")
            }
        ]);
        validated = validateAutomaticCaseAnalysis(
            parseStructuredResponse(
                repairResponse,
                "Corrected automatic individual case analysis"
            ),
            messages
        );

        if (Number.isInteger(repairResponse?.usage?.input_tokens)) {
            inputTokenCount = (inputTokenCount || 0)
                + repairResponse.usage.input_tokens;
        }
    }

    if (!validated.complete
        && validated.codes.length
    ) {
        const themeResponse = await openaiClient.responses.create({
            model,
            store: false,
            text: {
                format: {
                    type: "json_schema",
                    name: "automatic_case_theme_assignment",
                    strict: true,
                    schema: automaticThemeSchema
                }
            },
            input: [{
                role: "system",
                content: "Synthesize genuinely related participant-specific codes into clear higher-level English themes. Every theme must contain at least two distinct code numbers, advance abstraction beyond those codes, and make them cohere as one meaningful participant story, behavioral profile, contributing life pattern, or attitude/state relevant to the named research topic. Prefer one everyday word; use two or three only when they form one familiar natural phrase. Write every label and rationale in English. Use only the numbered codes provided. A code may remain unassigned when no genuinely related second code exists. Never invent a one-code theme or group codes merely because they share a surface term. Return coherent comparison-useful concepts, never findings, sentences, or concatenated descriptor bundles."
            }, {
                role: "user",
                content: JSON.stringify({
                    codeCount: validated.codes.length,
                    requiredCodeNumbers: validated.codes.map(
                        (_, index) => index + 1
                    ),
                    codes: validated.codes.map((code, index) => ({
                        code_number: index + 1,
                        label: code.label,
                        rationale: code.rationale
                    }))
                })
            }]
        });
        const themeValidation = validateAutomaticThemes(
            parseStructuredResponse(
                themeResponse,
                "Automatic case theme assignment"
            )?.themes,
            validated.codes
        );
        validated = {
            ...validated,
            themes: themeValidation.themes,
            unassignedCodeNumbers: themeValidation.unassignedCodeNumbers,
            rejectedThemeAssignments:
                themeValidation.rejectedThemeAssignments,
            invalidEvidence: validated.invalidEvidence
                + themeValidation.invalidThemes,
            complete: Boolean(
                validated.codes.length
                && validated.caseInterpretation
                && !themeValidation.invalidThemes
            )
        };

        if (Number.isInteger(themeResponse?.usage?.input_tokens)) {
            inputTokenCount = (inputTokenCount || 0)
                + themeResponse.usage.input_tokens;
        }

        if (!validated.complete) {
            const themeRepairResponse = await openaiClient.responses.create({
                model,
                store: false,
                text: {
                    format: {
                        type: "json_schema",
                        name: "corrected_case_theme_assignment",
                        strict: true,
                        schema: automaticThemeSchema
                    }
                },
                input: [{
                    role: "system",
                    content: "Return a corrected theme assignment containing only defensible multi-code themes. Every theme must synthesize at least two semantically related codes into a coherent higher-level participant story relevant to the project topic. A code may remain unassigned when it lacks a genuinely related second code. Remove one-code, paraphrase, superficial-term, and bag-of-words themes. Prefer one everyday word; use two or three only as one familiar natural phrase. Return the entire replacement theme list."
                }, {
                    role: "user",
                    content: JSON.stringify({
                        codeCount: validated.codes.length,
                        requiredCodeNumbers: validated.codes.map(
                            (_, index) => index + 1
                        ),
                        previouslyMissingCodeNumbers:
                            validated.unassignedCodeNumbers,
                        previousThemes: validated.themes,
                        codes: validated.codes.map((code, index) => ({
                            code_number: index + 1,
                            label: code.label,
                            rationale: code.rationale
                        }))
                    })
                }]
            });
            const repairedThemes = validateAutomaticThemes(
                parseStructuredResponse(
                    themeRepairResponse,
                    "Corrected case theme assignment"
                )?.themes,
                validated.codes
            );
            validated = {
                ...validated,
                themes: repairedThemes.themes,
                unassignedCodeNumbers:
                    repairedThemes.unassignedCodeNumbers,
                rejectedThemeAssignments:
                    repairedThemes.rejectedThemeAssignments,
                invalidEvidence: validated.invalidEvidence
                    + repairedThemes.invalidThemes,
                complete: Boolean(
                    validated.codes.length
                    && validated.caseInterpretation
                    && !repairedThemes.invalidThemes
                )
            };

            if (Number.isInteger(
                themeRepairResponse?.usage?.input_tokens
            )) {
                inputTokenCount = (inputTokenCount || 0)
                    + themeRepairResponse.usage.input_tokens;
            }
        }
    }

    let labelQualityAudit = {
        checks: [],
        rejectedLabels: [],
        overallSummary: "Label quality was not audited because the evidence hierarchy was incomplete.",
        complete: false
    };

    if (validated.complete) {
        let auditedLabels = await auditAutomaticLabelQuality(
            openaiClient,
            messages,
            validated,
            model,
            analysisFramework
        );
        inputTokenCount = (inputTokenCount || 0)
            + (auditedLabels.inputTokenCount || 0);

        if (!auditedLabels.audit.complete) {
            const labelRepairResponse = await createResponse([{
                role: "system",
                content: systemInstruction
                    + " Return one complete corrected report. Repair every rejected code or theme label so it names one everyday, coherent, evidence-supported, topic-relevant concept that is useful for cross-case comparison. Every theme must synthesize at least two semantically related codes into a coherent higher-level participant story, cover all assigned codes, and avoid one-to-one paraphrase. Remove a theme and leave its code unassigned when no valid multi-code abstraction exists. Prefer one word; use two or three only as a genuine natural phrase. Remove duplicate or bag-of-words labels. Preserve exact keyword evidence and all valid demographic provenance. Put descriptive detail in rationales."
            }, {
                role: "user",
                content: [
                    `Completed participant transcript (JSON):\n${transcriptJson}`,
                    `Validated draft requiring label repair (JSON):\n${JSON.stringify(automaticAnalysisDraftForModel(validated))}`,
                    `Rejected label audit (JSON):\n${JSON.stringify({
                        rejectedLabels: auditedLabels.audit.rejectedLabels,
                        overallSummary: auditedLabels.audit.overallSummary
                    })}`
                ].join("\n\n")
            }]);
            validated = validateAutomaticCaseAnalysis(
                parseStructuredResponse(
                    labelRepairResponse,
                    "Label-corrected automatic individual case analysis"
                ),
                messages
            );
            if (Number.isInteger(labelRepairResponse?.usage?.input_tokens)) {
                inputTokenCount += labelRepairResponse.usage.input_tokens;
            }
            if (validated.complete) {
                auditedLabels = await auditAutomaticLabelQuality(
                    openaiClient,
                    messages,
                    validated,
                    model,
                    analysisFramework
                );
                inputTokenCount += auditedLabels.inputTokenCount || 0;
            }
        }

        labelQualityAudit = auditedLabels.audit;
        validated = {
            ...validated,
            complete: Boolean(
                validated.complete
                && labelQualityAudit.complete
            )
        };
    }

    return {
        ...validated,
        labelQualityAudit,
        inputTokenCount
    };
}

function relevanceEvidenceKey(codeNumber, messageId, exactText) {
    return `${codeNumber}:${messageId}:${exactText}`;
}

export function validateAutomaticCaseRelevanceAudit(analysis, value) {
    const expected = [];
    const themesByCode = new Map();

    (analysis?.themes || []).forEach((theme, themeIndex) => {
        (theme.codeNumbers || []).forEach(codeNumber => {
            const labels = themesByCode.get(codeNumber) || [];
            labels.push(`T${themeIndex + 1} ${theme.label}`);
            themesByCode.set(codeNumber, labels);
        });
    });
    (analysis?.codes || []).forEach((code, codeIndex) => {
        (code.highlights || []).forEach(highlight => {
            expected.push({
                codeNumber: codeIndex + 1,
                codeLabel: code.label,
                themeLabels: themesByCode.get(codeIndex + 1) || [],
                messageId: highlight.messageId,
                exactText: highlight.exactText
            });
        });
    });

    const auditByKey = new Map();
    let duplicateChecks = 0;
    (Array.isArray(value?.checks) ? value.checks : []).forEach(check => {
        const codeNumber = Number.isInteger(check?.code_number)
            ? check.code_number
            : null;
        const messageId = normalizedText(check?.message_id);
        const exactText = normalizedText(check?.exact_text);
        if (!codeNumber || !messageId || !exactText) return;
        const key = relevanceEvidenceKey(codeNumber, messageId, exactText);
        if (auditByKey.has(key)) duplicateChecks += 1;
        auditByKey.set(key, {
            codeNumber,
            messageId,
            exactText,
            transcriptGrounded: check.transcript_grounded === true,
            supportsCode: check.supports_code === true,
            supportsTheme: check.supports_theme === true,
            researchScopeRelevant: check.research_scope_relevant === true,
            explanation: normalizedText(check.explanation) ||
                "No relevance explanation was supplied."
        });
    });

    const checks = expected.map(evidence => {
        const key = relevanceEvidenceKey(
            evidence.codeNumber,
            evidence.messageId,
            evidence.exactText
        );
        const audit = auditByKey.get(key);
        const hasAssignedTheme = evidence.themeLabels.length > 0;
        const themeAssignmentAccepted = hasAssignedTheme
            ? audit?.supportsTheme === true
            : audit?.supportsTheme === false;
        const accepted = Boolean(
            audit?.transcriptGrounded
            && audit.supportsCode
            && themeAssignmentAccepted
            && audit.researchScopeRelevant
        );
        return {
            ...evidence,
            transcriptGrounded: Boolean(audit?.transcriptGrounded),
            supportsCode: Boolean(audit?.supportsCode),
            supportsTheme: Boolean(audit?.supportsTheme),
            hasAssignedTheme,
            themeAssignmentAccepted,
            researchScopeRelevant: Boolean(audit?.researchScopeRelevant),
            accepted,
            explanation: audit?.explanation ||
                "The independent relevance audit did not return this evidence item."
        };
    });
    const expectedKeys = new Set(expected.map(item => relevanceEvidenceKey(
        item.codeNumber,
        item.messageId,
        item.exactText
    )));
    const unexpectedCheckCount = [...auditByKey.keys()].filter(
        key => !expectedKeys.has(key)
    ).length;
    const rejectedEvidence = checks.filter(check => !check.accepted);

    return {
        checks,
        overallSummary: normalizedText(value?.overall_summary) ||
            "No overall relevance summary was supplied.",
        rejectedEvidence,
        duplicateChecks,
        unexpectedCheckCount,
        complete: Boolean(
            expected.length
            && !rejectedEvidence.length
            && !duplicateChecks
            && !unexpectedCheckCount
            && auditByKey.size === expected.length
        )
    };
}

async function auditAutomaticCaseRelevance(
    openaiClient,
    messages,
    analysis,
    model,
    analysisFramework
) {
    const themesByCode = new Map();
    analysis.themes.forEach((theme, themeIndex) => {
        theme.codeNumbers.forEach(codeNumber => {
            const themes = themesByCode.get(codeNumber) || [];
            themes.push({
                theme_number: themeIndex + 1,
                label: theme.label,
                rationale: theme.rationale
            });
            themesByCode.set(codeNumber, themes);
        });
    });
    const proposedEvidence = analysis.codes.flatMap((code, codeIndex) =>
        code.highlights.map(highlight => ({
            code_number: codeIndex + 1,
            code_label: code.label,
            code_rationale: code.rationale,
            assigned_themes: themesByCode.get(codeIndex + 1) || [],
            message_id: highlight.messageId,
            exact_text: highlight.exactText
        }))
    );
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "automatic_case_reanalysis_relevance_audit",
                strict: true,
                schema: automaticCaseRelevanceAuditSchema
            }
        },
        input: [{
            role: "system",
            content: "Act as a strict independent evidence auditor for one qualitative case. Return exactly one check for every proposed evidence item and no others. Exact transcript grounding is necessary but insufficient. Set supports_code true only when the exact phrase semantically supports the assigned code. Set supports_theme true only when that code and phrase support at least one assigned valid multi-code theme. When assigned_themes is empty because the code is explicitly ungrouped and needs review, set supports_theme false; that is the correct auditable state and must not be repaired by inventing a theme. Set research_scope_relevant true only when the evidence satisfies the supplied project-specific inclusion, exclusion, and study-scope rules. Reject unrelated cross-topic evidence even when the quotation is exact. Explain each judgment briefly.\n\n"
                + analysisFrameworkInstruction(analysisFramework)
        }, {
            role: "user",
            content: [
                `Preserved participant transcript (JSON):\n${messagesForModel(messages)}`,
                `Proposed evidence hierarchy (JSON):\n${JSON.stringify(proposedEvidence)}`
            ].join("\n\n")
        }]
    });
    return {
        audit: validateAutomaticCaseRelevanceAudit(
            analysis,
            parseStructuredResponse(
                response,
                "Automatic case re-analysis relevance audit"
            )
        ),
        inputTokenCount: Number.isInteger(response?.usage?.input_tokens)
            ? response.usage.input_tokens
            : null
    };
}

export async function generateAutomaticCaseReanalysis(
    openaiClient,
    messages,
    researcherRequest,
    {
        model = QUALITATIVE_ANALYSIS_MODEL,
        analysisFramework = null
    } = {}
) {
    let totalInputTokens = 0;
    let analysis = await generateAutomaticCaseAnalysis(
        openaiClient,
        messages,
        { model, reanalysisContext: researcherRequest, analysisFramework }
    );
    totalInputTokens += analysis.inputTokenCount || 0;

    if (!analysis.complete) {
        throw new Error(
            "The proposed re-analysis did not produce a complete evidence hierarchy."
        );
    }

    let audited = await auditAutomaticCaseRelevance(
        openaiClient,
        messages,
        analysis,
        model,
        analysisFramework
    );
    totalInputTokens += audited.inputTokenCount || 0;

    if (!audited.audit.complete) {
        const rejected = audited.audit.rejectedEvidence.map(item => ({
            codeNumber: item.codeNumber,
            codeLabel: item.codeLabel,
            themes: item.themeLabels,
            messageId: item.messageId,
            exactText: item.exactText,
            explanation: item.explanation
        }));
        analysis = await generateAutomaticCaseAnalysis(
            openaiClient,
            messages,
            {
                model,
                analysisFramework,
                reanalysisContext: {
                    ...researcherRequest,
                    rejectedEvidenceFromIndependentAudit: rejected,
                    correctionInstruction:
                        "Return a new complete report that excludes every rejected evidence item and any unsupported code or theme."
                }
            }
        );
        totalInputTokens += analysis.inputTokenCount || 0;
        if (!analysis.complete) {
            throw new Error(
                "The corrected re-analysis did not produce a complete evidence hierarchy."
            );
        }
        audited = await auditAutomaticCaseRelevance(
            openaiClient,
            messages,
            analysis,
            model,
            analysisFramework
        );
        totalInputTokens += audited.inputTokenCount || 0;
    }

    if (!audited.audit.complete) {
        throw new Error(
            "The proposed re-analysis still contained evidence that failed semantic or research-scope relevance checks. No proposal was stored."
        );
    }

    return {
        ...analysis,
        relevanceAudit: {
            ...audited.audit,
            labelQualityAudit: analysis.labelQualityAudit
        },
        inputTokenCount: totalInputTokens || null
    };
}

export function detectCompoundQuestionTurns(rows) {
    return (Array.isArray(rows) ? rows : []).flatMap(row => {
        const speaker = normalizedText(row?.Speaker)?.toLowerCase();
        const text = normalizedText(row?.Message);
        if (!["ai", "assistant", "interviewer"].includes(speaker) || !text) {
            return [];
        }
        const questionCount = (text.match(/[?？؟]/gu) || []).length;
        if (questionCount < 2) return [];
        return [{
            messageId: storedIdentifier(row.id),
            issueType: "compound_question",
            exactText: text.slice(0, 1_000),
            questionCount,
            explanation:
                "This historical interviewer turn contains multiple questions. Re-analysis may improve coding, but it does not rewrite the transcript or remove this protocol-quality issue."
        }];
    });
}

export async function collectEvidenceForBatch(
    openaiClient,
    messages,
    workingInstruction,
    { model = QUALITATIVE_ANALYSIS_MODEL } = {}
) {
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "qualitative_analysis_evidence",
                strict: true,
                schema: evidenceSchema
            }
        },
        input: [
            {
                role: "system",
                content: "You are collecting evidence for a qualitative researcher's revised analytical interpretation. The researcher's working fields are the controlling instruction. Return only exact participant message IDs from the supplied evidence set that support that interpretation. Do not quote, paraphrase, invent, or rewrite evidence."
            },
            {
                role: "user",
                content: `Researcher working instruction (JSON):\n${JSON.stringify(workingInstruction)}\n\nParticipant evidence set (JSON):\n${messagesForModel(messages)}`
            }
        ]
    });

    return validateEvidenceRecords(
        parseStructuredResponse(response, "AI evidence-collection output"),
        messages,
        workingInstruction?.codes
    );
}

export async function discussAnalysisWithResearcher(
    openaiClient,
    analysisContext,
    conversation,
    { model = QUALITATIVE_ANALYSIS_MODEL } = {}
) {
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "qualitative_analysis_discussion",
                strict: true,
                schema: discussionSchema
            }
        },
        input: [
            {
                role: "system",
                content: "You are an analytical collaborator for a qualitative researcher. Discuss the selected theme, code, and keywords using only the supplied stored transcript evidence. Treat keywords as the evidence bridge, codes as groupings of keywords, and themes as groupings of codes. A theme is a reusable, comparable subject label of exactly one or two words, not a case summary. Prefer shared labels such as 'Sleep routine', 'Sleep duration', 'Night waking', 'Sleep strategies', 'Technology', 'Work', 'Family', 'Ageing', 'Environment', and 'Satisfaction'. For example, revise 'Stable sleep routines anchored by longstanding habits' to 'Sleep routine', then place 'Stable' and 'Longstanding' under codes. Under 'Work', place differences such as 'Long hours', 'Overtime', 'Weekend work', or 'Overwork' in concise codes. Never write a theme or code as a sentence or finding; put the full interpretation in the rationale. Explicitly name the code when discussing its keywords. Distinguish the number of supporting participants from the number of passages. Researcher workbook layers are researcher-authored ordering and grouping decisions: follow them as analytical instructions, but do not present them as transcript evidence. Never invent a participant, quotation, keyword, code, theme, group, or factual claim. If the researcher requests a revision, return a complete proposed working theme, code list, keyword list, and explicit code-to-keyword groups. If no analytical revision is warranted, preserve the current values and set should_apply to false. Interface or layout feedback is not an analytical revision. Explain uncertainty and weak fit plainly."
            },
            {
                role: "user",
                content: [
                    "Selected analysis context (JSON):",
                    JSON.stringify(analysisContext),
                    "Researcher-AI discussion so far (JSON):",
                    JSON.stringify(conversation)
                ].join("\n")
            }
        ]
    });

    const value = parseStructuredResponse(
        response,
        "AI qualitative-analysis discussion"
    );
    const reply = normalizedText(value?.reply);
    const requestedTheme = normalizedText(value?.proposal?.theme);
    const proposedThemeIsValid = isShortThemeSubject(requestedTheme);
    const proposedTheme = proposedThemeIsValid
        ? requestedTheme
        : normalizedText(analysisContext?.theme) || "";
    const proposedCodes = normalizedList(value?.proposal?.codes);
    const proposedKeywords = normalizedList(value?.proposal?.keywords);
    const allowedCodes = new Map(proposedCodes.map(code => [
        code.toLowerCase(),
        code
    ]));
    const allowedKeywords = new Map(proposedKeywords.map(keyword => [
        keyword.toLowerCase(),
        keyword
    ]));
    const codeKeywordGroups = (Array.isArray(
        value?.proposal?.code_keyword_groups
    ) ? value.proposal.code_keyword_groups : []).map(group => ({
        code: allowedCodes.get(normalizedText(group?.code)?.toLowerCase()),
        keywords: normalizedList(group?.keywords).map(keyword =>
            allowedKeywords.get(keyword.toLowerCase())
        ).filter(Boolean)
    })).filter(group => group.code);

    if (!reply) {
        throw new Error("AI qualitative-analysis discussion was empty.");
    }

    return {
        reply,
        proposal: {
            shouldApply: value?.proposal?.should_apply === true
                && proposedThemeIsValid,
            theme: proposedTheme,
            codes: proposedCodes,
            keywords: proposedKeywords,
            codeKeywordGroups,
            rationale: normalizedText(value?.proposal?.rationale) || ""
        }
    };
}

export function workingAnalysisFields(item) {
    return {
        theme: normalizedText(item?.researcher_theme)
            || normalizedText(item?.ai_theme),
        codes: Array.isArray(item?.researcher_codes)
            && item.researcher_codes.length
            ? normalizedList(item.researcher_codes)
            : normalizedList(item?.ai_codes),
        codedPhrases: Array.isArray(item?.researcher_coded_phrases)
            && item.researcher_coded_phrases.length
            ? normalizedList(item.researcher_coded_phrases)
            : normalizedList(item?.ai_coded_phrases),
        keywords: Array.isArray(item?.researcher_keywords)
            && item.researcher_keywords.length
            ? normalizedList(item.researcher_keywords)
            : normalizedList(item?.ai_keywords),
        note: normalizedText(item?.researcher_note)
    };
}

export function commaSeparatedList(value) {
    if (Array.isArray(value)) {
        return normalizedList(value);
    }

    return typeof value === "string"
        ? normalizedList(value.split(","))
        : [];
}
