import { storedIdentifier } from "./corpus.js";
import { DEFAULT_OPENAI_MODEL } from "./modelConfiguration.js";
import { analysisFrameworkInstruction } from "./analysisFramework.js";

export const QUALITATIVE_ANALYSIS_MODEL = DEFAULT_OPENAI_MODEL;
export const QUALITATIVE_ANALYSIS_VERSION = "task-014-v7-complete-cases-before-summary";
export const AUTOMATIC_CASE_ANALYSIS_VERSION =
    "case-analysis-v5-meaning-units-categories-completed";
export const AUTOMATIC_CASE_REANALYSIS_VERSION =
    "case-reanalysis-v4-feedback-completed";
export const DEFAULT_ANALYSIS_BATCH_SIZE = 40;
export const MAX_ANALYTIC_LABEL_WORDS = 8;
export const MAX_ANALYTIC_LABEL_LENGTH = 100;
export const MAX_THEME_PATTERN_WORDS = 16;
export const MAX_THEME_PATTERN_LENGTH = 180;

function normalizedText(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
}

export function isNaturalAnalyticLabelShape(value) {
    const label = normalizedText(value)?.replace(/\s+/gu, " ");

    if (!label || label.length > MAX_ANALYTIC_LABEL_LENGTH) {
        return false;
    }

    const words = label.split(" ").filter(Boolean);
    return words.length <= MAX_ANALYTIC_LABEL_WORDS
        && !/[.!?;:/|&]/u.test(label)
        && !/\b(?:and|or|but|because|although)\b/iu.test(label);
}

export function isThemePatternLabelShape(value) {
    const label = normalizedText(value)?.replace(/\s+/gu, " ");

    if (!label || label.length > MAX_THEME_PATTERN_LENGTH) {
        return false;
    }

    const words = label.split(" ").filter(Boolean);
    return words.length >= 3
        && words.length <= MAX_THEME_PATTERN_WORDS
        && !/[;:/|&]/u.test(label);
}

export function isShortThemeSubject(value) {
    const label = normalizedText(value)?.replace(/\s+/gu, " ");
    if (!label || label.length > MAX_ANALYTIC_LABEL_LENGTH) return false;
    const words = label.split(" ").filter(Boolean);
    return words.length <= 2 && !/[.!?;:/|&]/u.test(label);
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
                    meaning_unit_evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                message_id: { type: "string" },
                                exact_text: { type: "string" },
                                anchor_expressions: {
                                    type: "array",
                                    items: { type: "string" }
                                }
                            },
                            required: [
                                "message_id",
                                "exact_text",
                                "anchor_expressions"
                            ],
                            additionalProperties: false
                        }
                    }
                },
                required: ["label", "rationale", "meaning_unit_evidence"],
                additionalProperties: false
            }
        },
        categories: {
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
        themes: {
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
        case_interpretation: { type: "string" }
    },
    required: [
        "demographics",
        "codes",
        "categories",
        "themes",
        "case_interpretation"
    ],
    additionalProperties: false
};

const automaticHierarchySchema = {
    type: "object",
    properties: {
        categories: automaticCaseSchema.properties.categories,
        themes: automaticCaseSchema.properties.themes
    },
    required: ["categories", "themes"],
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
                    supports_category: { type: "boolean" },
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
                    "supports_category",
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
                    kind: {
                        type: "string",
                        enum: ["code", "category", "theme"]
                    },
                    number: { type: "integer" },
                    label: { type: "string" },
                    natural_language: { type: "boolean" },
                    coherent_concept: { type: "boolean" },
                    conceptually_distinct: { type: "boolean" },
                    evidence_supported: { type: "boolean" },
                    topic_relevant: { type: "boolean" },
                    comparison_useful: { type: "boolean" },
                    has_multiple_children: { type: "boolean" },
                    semantic_coverage: { type: "boolean" },
                    higher_level_abstraction: { type: "boolean" },
                    patterned_meaning: { type: "boolean" },
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
                    "has_multiple_children",
                    "semantic_coverage",
                    "higher_level_abstraction",
                    "patterned_meaning",
                    "explanation"
                ],
                additionalProperties: false
            }
        },
        unsynthesized_checks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["code", "category"]
                    },
                    number: { type: "integer" },
                    label: { type: "string" },
                    reason: { type: "string" }
                },
                required: [
                    "kind",
                    "number",
                    "label",
                    "reason"
                ],
                additionalProperties: false
            }
        },
        overall_summary: { type: "string" }
    },
    required: ["checks", "unsynthesized_checks", "overall_summary"],
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

function validateAutomaticHierarchy(rawCategories, rawThemes, codes) {
    const categories = [];
    const themes = [];
    const assignedCodeNumbers = new Set();
    const assignedCategoryNumbers = new Set();
    const invalidLabels = [];
    const rejectedCategoryAssignments = [];
    const rejectedThemeAssignments = [];
    let invalidCategories = 0;
    let invalidThemes = 0;

    (Array.isArray(rawCategories) ? rawCategories : []).forEach(rawCategory => {
        const label = normalizedText(rawCategory?.label);
        const rationale = normalizedText(rawCategory?.rationale);
        const codeNumbers = [...new Set(
            (Array.isArray(rawCategory?.code_numbers)
                ? rawCategory.code_numbers
                : []
            ).filter(number =>
                Number.isInteger(number)
                && number > 0
                && number <= codes.length
            )
        )];

        if (!isNaturalAnalyticLabelShape(label)
            || !rationale
            || codeNumbers.length < 2
        ) {
            invalidCategories += 1;
            if (!isNaturalAnalyticLabelShape(label)) {
                invalidLabels.push({ kind: "category", label: label || "" });
            }
            rejectedCategoryAssignments.push({
                label: label || "",
                codeNumbers,
                reason: codeNumbers.length < 2
                    ? "A category requires at least two related codes describing the same broader phenomenon."
                    : "The proposed category label or rationale failed structural validation."
            });
            return;
        }

        codeNumbers.forEach(number => assignedCodeNumbers.add(number));
        categories.push({ label, rationale, codeNumbers });
    });

    (Array.isArray(rawThemes) ? rawThemes : []).forEach(rawTheme => {
        const label = normalizedText(rawTheme?.label);
        const rationale = normalizedText(rawTheme?.rationale);
        const categoryNumbers = [...new Set(
            (Array.isArray(rawTheme?.category_numbers)
                ? rawTheme.category_numbers
                : []
            ).filter(number =>
                Number.isInteger(number)
                && number > 0
                && number <= categories.length
            )
        )];

        if (!isThemePatternLabelShape(label)
            || !rationale
            || categoryNumbers.length < 2
        ) {
            invalidThemes += 1;
            if (!isThemePatternLabelShape(label)) {
                invalidLabels.push({ kind: "theme", label: label || "" });
            }
            rejectedThemeAssignments.push({
                label: label || "",
                categoryNumbers,
                reason: categoryNumbers.length < 2
                    ? "A theme requires at least two categories whose patterned meaning can be interpreted together."
                    : "The proposed theme label or rationale failed structural validation."
            });
            return;
        }

        categoryNumbers.forEach(number => assignedCategoryNumbers.add(number));
        themes.push({ label, rationale, categoryNumbers });
    });

    const unassignedCodeNumbers = codes
        .map((_, index) => index + 1)
        .filter(number => !assignedCodeNumbers.has(number));
    const unassignedCategoryNumbers = categories
        .map((_, index) => index + 1)
        .filter(number => !assignedCategoryNumbers.has(number));

    return {
        categories,
        themes,
        invalidCategories,
        invalidThemes,
        unassignedCodeNumbers,
        unassignedCategoryNumbers,
        invalidLabels,
        rejectedCategoryAssignments,
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
    const usedMeaningUnits = new Map();
    const invalidLabels = [];
    let invalidEvidence = 0;
    let droppedCodes = 0;

    (Array.isArray(value?.codes) ? value.codes : []).forEach(rawCode => {
        const label = normalizedText(rawCode?.label);
        const rationale = normalizedText(rawCode?.rationale);
        const meaningUnits = [];

        (Array.isArray(rawCode?.meaning_unit_evidence)
            ? rawCode.meaning_unit_evidence
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
                const anchors = normalizedList(evidence?.anchor_expressions)
                    .filter(anchor => exactTextOccurrences(
                        occurrence.exactText,
                        anchor
                    ).length > 0);
                const meaningUnit = usedMeaningUnits.get(key) || {
                    messageId,
                    ...occurrence,
                    anchors
                };
                usedMeaningUnits.set(key, meaningUnit);
                meaningUnits.push(meaningUnit);
            });
        });

        if (!isNaturalAnalyticLabelShape(label)
            || !rationale
            || !meaningUnits.length) {
            invalidEvidence += 1;
            droppedCodes += 1;
            if (!isNaturalAnalyticLabelShape(label)) {
                invalidLabels.push({ kind: "code", label: label || "" });
            }
            return;
        }

        const uniqueMeaningUnits = [...new Map(meaningUnits.map(unit => [
            `${unit.messageId}:${unit.startOffset}:${unit.endOffset}`,
            unit
        ])).values()];
        codes.push({
            label,
            rationale,
            meaningUnits: uniqueMeaningUnits,
            highlights: uniqueMeaningUnits
        });
    });

    const hierarchyValidation = validateAutomaticHierarchy(
        value?.categories,
        value?.themes,
        codes
    );
    const {
        categories,
        themes,
        unassignedCodeNumbers,
        unassignedCategoryNumbers,
        rejectedCategoryAssignments,
        rejectedThemeAssignments
    } = hierarchyValidation;
    invalidLabels.push(...hierarchyValidation.invalidLabels);
    invalidEvidence += hierarchyValidation.invalidCategories
        + hierarchyValidation.invalidThemes;
    const demographicValidation = validateAutomaticDemographics(
        value?.demographics,
        messagesById
    );

    const caseInterpretation = normalizedText(value?.case_interpretation);

    return {
        codes,
        categories,
        themes,
        caseInterpretation,
        invalidEvidence,
        droppedCodes,
        invalidLabels,
        unassignedCodeNumbers,
        unassignedCategoryNumbers,
        rejectedCategoryAssignments,
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
            label: record.label,
            childNumbers: []
        })),
        ...(analysis?.categories || []).map((record, index) => ({
            kind: "category",
            number: index + 1,
            label: record.label,
            childNumbers: record.codeNumbers || []
        })),
        ...(analysis?.themes || []).map((record, index) => ({
            kind: "theme",
            number: index + 1,
            label: record.label,
            childNumbers: record.categoryNumbers || []
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
        const kind = ["code", "category", "theme"].includes(check?.kind)
            ? check.kind : null;
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
            hasMultipleChildren: check.has_multiple_children === true,
            semanticCoverage: check.semantic_coverage === true,
            higherLevelAbstraction:
                check.higher_level_abstraction === true,
            patternedMeaning: check.patterned_meaning === true,
            explanation: normalizedText(check.explanation)
                || "No label-quality explanation was supplied."
        });
    });

    const checks = expected.map(item => {
        const audit = auditByKey.get(labelQualityKey(item.kind, item.number));
        const exactLabel = audit?.label === item.label;
        const structurallyValid = item.kind === "theme"
            ? isThemePatternLabelShape(item.label)
            : isNaturalAnalyticLabelShape(item.label);
        const uniqueAtLevel = labelCounts.get(
            `${item.kind}:${
                normalizedText(item.label)?.toLocaleLowerCase() || ""
            }`
        ) === 1;
        const hierarchyAccepted = item.kind === "code" || Boolean(
            item.childNumbers.length >= 2
            && audit?.hasMultipleChildren
            && audit?.semanticCoverage
            && audit?.higherLevelAbstraction
            && (item.kind !== "theme" || audit?.patternedMeaning)
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
            && hierarchyAccepted
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
            childNumbers: item.childNumbers || [],
            hasMultipleChildren: item.kind === "code"
                || Boolean(audit?.hasMultipleChildren)
                    && item.childNumbers.length >= 2,
            semanticCoverage: item.kind === "code"
                || Boolean(audit?.semanticCoverage),
            higherLevelAbstraction: item.kind === "code"
                || Boolean(audit?.higherLevelAbstraction),
            patternedMeaning: item.kind !== "theme"
                || Boolean(audit?.patternedMeaning),
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
    const expectedUnsynthesized = new Map([
        ...(analysis?.unassignedCodeNumbers || []).map(number => [
            `code:${number}`,
            { kind: "code", number, label: analysis.codes?.[number - 1]?.label || "" }
        ]),
        ...(analysis?.unassignedCategoryNumbers || []).map(number => [
            `category:${number}`,
            { kind: "category", number, label: analysis.categories?.[number - 1]?.label || "" }
        ])
    ]);
    const unsynthesizedByKey = new Map();
    let duplicateUnsynthesizedChecks = 0;
    (Array.isArray(value?.unsynthesized_checks)
        ? value.unsynthesized_checks
        : []
    ).forEach(check => {
        const kind = ["code", "category"].includes(check?.kind)
            ? check.kind : null;
        const number = Number.isInteger(check?.number) && check.number > 0
            ? check.number : null;
        if (!kind || !number) return;
        const key = `${kind}:${number}`;
        if (unsynthesizedByKey.has(key)) duplicateUnsynthesizedChecks += 1;
        unsynthesizedByKey.set(key, {
            kind,
            number,
            label: normalizedText(check?.label) || "",
            reason: normalizedText(check?.reason)
                || "No reason was supplied for this unsynthesized observation."
        });
    });
    const unsynthesized = [...expectedUnsynthesized].map(
        ([key, expectedItem]) => {
            const audit = unsynthesizedByKey.get(key);
            const accepted = Boolean(
                audit?.label === expectedItem.label
                && audit?.reason
            );
            return {
                ...expectedItem,
                reason: audit?.reason
                    || "This firm descriptive unit was retained without forcing it into an unsupported higher-level synthesis.",
                accepted
            };
        }
    );
    const unexpectedUnsynthesizedChecks = [...unsynthesizedByKey.keys()].filter(
        key => !expectedUnsynthesized.has(key)
    ).length;
    const hierarchyChecks = checks.filter(check => check.kind === "theme");
    const categoryChecks = checks.filter(check => check.kind === "category");
    const hierarchyComplete = Boolean(
        !hierarchyChecks.some(check => !check.accepted)
        && !categoryChecks.some(check => !check.accepted)
        && !unsynthesized.some(check => !check.accepted)
        && !duplicateUnsynthesizedChecks
        && !unexpectedUnsynthesizedChecks
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
            categoryChecks,
            unsynthesized,
            ungroupedCodes: unsynthesized.filter(item => item.kind === "code"),
            ungroupedCategories: unsynthesized.filter(
                item => item.kind === "category"
            ),
            rejectedCategoryAssignments:
                analysis?.rejectedCategoryAssignments || [],
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
            meaning_unit_evidence: (code.meaningUnits || code.highlights || [])
                .map(unit => ({
                message_id: unit.messageId,
                exact_text: unit.exactText,
                anchor_expressions: unit.anchors || []
            }))
        })),
        categories: (analysis.categories || []).map(category => ({
            label: category.label,
            rationale: category.rationale,
            code_numbers: category.codeNumbers
        })),
        themes: (analysis.themes || []).map(theme => ({
            label: theme.label,
            rationale: theme.rationale,
            category_numbers: theme.categoryNumbers
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
                "Return exactly one check for every numbered code, category, and theme, and no other checks.",
                "Set natural_language true only for a normal everyday English word or familiar natural phrase, never a concatenation of descriptors.",
                "Set coherent_concept true only when the whole label names one meaningful concept rather than a finding, sentence, list, or bag of words.",
                "Set conceptually_distinct true only when the label is not duplicative or confusingly overlapping with another label at the same level.",
                "Set evidence_supported true only when a code is supportable by its exact meaning units, a category is supported by its assigned codes, or a theme is supported by its assigned categories.",
                "Set topic_relevant true only when the label satisfies the named project's topic, scope, inclusion, and exclusion rules.",
                "Set comparison_useful true only when another researcher could understand and compare the concept across cases without reading its rationale.",
                "For a code, set has_multiple_children, semantic_coverage, higher_level_abstraction, and patterned_meaning true because those hierarchy checks do not apply.",
                "For a category, set has_multiple_children true only when it groups at least two related codes that describe one broader phenomenon. Set semantic_coverage and higher_level_abstraction according to that code-to-category relationship; patterned_meaning is not required, so set it true.",
                "For a theme, set has_multiple_children true only when it interprets at least two distinct categories. Set semantic_coverage true only when it accounts for every assigned category, higher_level_abstraction true only when it advances beyond description, and patterned_meaning true only when it states the interpretive pattern linking the categories.",
                "For the named project, reject a generic category or theme unless its entire meaning-unit/code/category chain establishes explicit relevance to the research topic.",
                "Return exactly one unsynthesized_check for every unassigned code and category and no others. Explain why it was retained as a firm descriptive result without forcing an unsupported higher-level synthesis. This is a completed analysis, not a request for researcher approval.",
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
        analysisFramework = null,
        sharedVocabulary = null
    } = {}
) {
    const frameworkInstruction = analysisFrameworkInstruction(
        analysisFramework
    );
    const relevanceInstruction = reanalysisContext
        ? " This is a completed re-analysis initiated by researcher feedback. Apply the framework's relevance boundary strictly, complete the revised report without pausing for approval, and treat the feedback as input to a new traceable analysis version. Researcher feedback context (JSON): "
            + JSON.stringify(reanalysisContext)
        : "";
    const vocabularyInstruction = sharedVocabulary
        ? "Reuse the following corpus-wide code, category, and theme terminology whenever this case's own evidence supports it. Shared vocabulary never supplies missing evidence and does not authorize comparison inside this single-case report. Create a new common term only when no existing term represents the meaning. Shared vocabulary (JSON): "
            + JSON.stringify(sharedVocabulary)
        : "No earlier corpus vocabulary is available. Create clear common-language terms that could be reused across cases.";
    const systemInstruction = [
        "Complete one autonomous qualitative analysis for exactly one participant session. Never compare, combine, or generalize across participants inside this case report.",
        "Write the analytical report in English regardless of interview language. Preserve every meaning unit as exact_text in the participant's original language.",
        "Extract demographics only from exact evidence. Never guess. Mark supported demographic values as stated or derived under the existing demographic rules.",
        "Work strictly upward from evidence: meaning units → codes → categories → themes.",
        "A meaning unit is an exact passage containing one reasonably coherent idea. It may be part of a sentence, one sentence, or several sentences; its boundary follows meaning rather than punctuation. Select enough context to keep the idea understandable. Return optional anchor_expressions as exact words or phrases inside the meaning unit.",
        "Never select greetings, thanks, farewells, interviewer courtesies, or other phatic language as meaning units or codes.",
        "A code names the specific phenomenon expressed by one or more meaning units. Every code must be supportable by its text. Do not add an unsupported cause, motive, diagnosis, social structure, evaluation, consequence, or theoretical explanation.",
        "A category answers: What is being described? Group at least two related codes into one broader descriptive phenomenon. Categories must be firm, coherent, and evidence-grounded.",
        "A theme answers: What patterned meaning links these observations? Interpret at least two categories together and state the resulting patterned meaning. A theme is interpretive, but it is still part of the completed analytical result; do not pause or ask for researcher confirmation.",
        "If a firm code or category lacks enough related material for a defensible higher level, retain it as unsynthesized. Do not manufacture a category or theme, and do not label the result as waiting for researcher review.",
        "Complete and return the whole case outcome. The researcher reviews completed work afterward and may provide feedback that starts a new version.",
        vocabularyInstruction
    ].join("\n\n")
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
        || validated.rejectedCategoryAssignments.length > 0
        || validated.rejectedThemeAssignments.length > 0
    ) {
        const repairResponse = await createResponse([
            {
                role: "system",
                content: systemInstruction
                    + " Correct the supplied draft into a complete replacement. Preserve valid exact meaning units. Remove or replace non-verbatim evidence and restore any dropped code using exact evidence. A category must descriptively group at least two related codes. A theme must interpret the patterned meaning linking at least two categories. Retain firm unsynthesized codes or categories instead of inventing a hierarchy. Return the entire corrected JSON object."
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
                        rejectedCategoryAssignments:
                            validated.rejectedCategoryAssignments,
                        rejectedThemeAssignments:
                            validated.rejectedThemeAssignments,
                        unassignedCodeNumbers:
                            validated.unassignedCodeNumbers,
                        unassignedCategoryNumbers:
                            validated.unassignedCategoryNumbers
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
                    + " Return one complete corrected report. Repair every rejected code, category, or theme label. Codes and categories must use coherent common terms suitable across cases while remaining supportable by this case alone. Categories descriptively group related codes. Themes state the patterned meaning linking categories and may use a clear interpretive phrase. Retain unsynthesized lower units instead of forcing a hierarchy. Preserve exact meaning-unit evidence, anchors, and demographic provenance."
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
    const categoriesByCode = new Map();
    const themesByCategory = new Map();
    const themesByCode = new Map();

    (analysis?.themes || []).forEach((theme, themeIndex) => {
        (theme.categoryNumbers || []).forEach(categoryNumber => {
            const labels = themesByCategory.get(categoryNumber) || [];
            labels.push(`TH${themeIndex + 1} ${theme.label}`);
            themesByCategory.set(categoryNumber, labels);
        });
    });
    (analysis?.categories || []).forEach((category, categoryIndex) => {
        (category.codeNumbers || []).forEach(codeNumber => {
            const labels = categoriesByCode.get(codeNumber) || [];
            labels.push(`CA${categoryIndex + 1} ${category.label}`);
            categoriesByCode.set(codeNumber, labels);
            const themes = themesByCode.get(codeNumber) || [];
            themes.push(...(themesByCategory.get(categoryIndex + 1) || []));
            themesByCode.set(codeNumber, [...new Set(themes)]);
        });
    });
    (analysis?.codes || []).forEach((code, codeIndex) => {
        (code.highlights || []).forEach(highlight => {
            expected.push({
                codeNumber: codeIndex + 1,
                codeLabel: code.label,
                categoryLabels: categoriesByCode.get(codeIndex + 1) || [],
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
            supportsCategory: check.supports_category === true,
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
        const hasAssignedCategory = evidence.categoryLabels.length > 0;
        const categoryAssignmentAccepted = hasAssignedCategory
            ? audit?.supportsCategory === true
            : audit?.supportsCategory === false;
        const hasAssignedTheme = evidence.themeLabels.length > 0;
        const themeAssignmentAccepted = hasAssignedTheme
            ? audit?.supportsTheme === true
            : audit?.supportsTheme === false;
        const accepted = Boolean(
            audit?.transcriptGrounded
            && audit.supportsCode
            && categoryAssignmentAccepted
            && themeAssignmentAccepted
            && audit.researchScopeRelevant
        );
        return {
            ...evidence,
            transcriptGrounded: Boolean(audit?.transcriptGrounded),
            supportsCode: Boolean(audit?.supportsCode),
            supportsCategory: Boolean(audit?.supportsCategory),
            supportsTheme: Boolean(audit?.supportsTheme),
            hasAssignedCategory,
            categoryAssignmentAccepted,
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
    const categoriesByCode = new Map();
    const themesByCategory = new Map();
    const themesByCode = new Map();
    analysis.themes.forEach((theme, themeIndex) => {
        theme.categoryNumbers.forEach(categoryNumber => {
            const themes = themesByCategory.get(categoryNumber) || [];
            themes.push({
                theme_number: themeIndex + 1,
                label: theme.label,
                rationale: theme.rationale
            });
            themesByCategory.set(categoryNumber, themes);
        });
    });
    analysis.categories.forEach((category, categoryIndex) => {
        category.codeNumbers.forEach(codeNumber => {
            const categories = categoriesByCode.get(codeNumber) || [];
            categories.push({
                category_number: categoryIndex + 1,
                label: category.label,
                rationale: category.rationale
            });
            categoriesByCode.set(codeNumber, categories);
            const themes = themesByCode.get(codeNumber) || [];
            themes.push(...(themesByCategory.get(categoryIndex + 1) || []));
            themesByCode.set(codeNumber, themes);
        });
    });
    const proposedEvidence = analysis.codes.flatMap((code, codeIndex) =>
        code.highlights.map(highlight => ({
            code_number: codeIndex + 1,
            code_label: code.label,
            code_rationale: code.rationale,
            assigned_categories: categoriesByCode.get(codeIndex + 1) || [],
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
            content: "Act as a strict independent evidence auditor for one completed qualitative case. Return exactly one check for every proposed meaning unit and no others. Exact transcript grounding is necessary but insufficient. Set supports_code true only when the meaning unit supports its code without importing an unsupported explanation. Set supports_category true only when that code validly contributes to an assigned descriptive category; when no category is assigned, set it false. Set supports_theme true only when the code's category validly contributes to an assigned patterned-meaning theme; when no theme is assigned, set it false. An unassigned lower unit is a completed unsynthesized finding, not a request for approval. Set research_scope_relevant true only when the evidence satisfies the project scope. Explain each judgment briefly.\n\n"
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
        analysisFramework = null,
        sharedVocabulary = null
    } = {}
) {
    let totalInputTokens = 0;
    let analysis = await generateAutomaticCaseAnalysis(
        openaiClient,
        messages,
        {
            model,
            reanalysisContext: researcherRequest,
            analysisFramework,
            sharedVocabulary
        }
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
                sharedVocabulary,
                reanalysisContext: {
                    ...researcherRequest,
                    rejectedEvidenceFromIndependentAudit: rejected,
                    correctionInstruction:
                        "Return a new complete report that excludes every rejected evidence item and any unsupported code, category, or theme."
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
