import { storedIdentifier } from "./corpus.js";

export const QUALITATIVE_ANALYSIS_MODEL = "gpt-5.1";
export const QUALITATIVE_ANALYSIS_VERSION = "task-014-v2";
export const DEFAULT_ANALYSIS_BATCH_SIZE = 40;

function normalizedText(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
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
                    rationale: { type: "string" }
                },
                required: [
                    "theme",
                    "codes",
                    "keywords",
                    "supporting_message_ids",
                    "code_evidence",
                    "rationale"
                ],
                additionalProperties: false
            }
        }
    },
    required: ["items"],
    additionalProperties: false
};

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
    const items = [];
    let invalidEvidenceIds = 0;
    let skippedItems = 0;

    (Array.isArray(value?.items) ? value.items : []).forEach(item => {
        const theme = normalizedText(item?.theme);
        const rationale = normalizedText(item?.rationale);
        const codes = normalizedList(item.codes);
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

        if (!theme || !rationale || evidenceIds.length === 0) {
            skippedItems += 1;
            return;
        }

        const evidenceCodesById = new Map(
            evidenceIds.map(id => [id, []])
        );

        (Array.isArray(item?.code_evidence) ? item.code_evidence : [])
            .forEach(attribution => {
                const code = normalizedAttributionCodes(
                    [attribution?.code],
                    codes
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
                });
            });

        items.push({
            theme,
            codes,
            keywords: normalizedList(item.keywords),
            rationale,
            evidenceIds,
            evidence: evidenceIds.map(messageId => ({
                messageId,
                codes: evidenceCodesById.get(messageId)
            }))
        });
    });

    return { items, invalidEvidenceIds, skippedItems };
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
                content: "You are assisting a qualitative researcher. Analyse only the participant messages supplied. Return provisional themes, qualitative codes, keywords, exact supporting participant message IDs, explicit code-to-message attribution, and concise English rationales. Attribute evidence only to codes returned in the same item. Never cite an ID that is not in the supplied evidence set. Do not quote, invent, or rewrite evidence."
            },
            {
                role: "user",
                content: `Participant evidence set (JSON):\n${messagesForModel(messages)}`
            }
        ]
    });

    return validateSuggestedItems(
        parseStructuredResponse(response, "AI qualitative-analysis output"),
        messages
    );
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

export function workingAnalysisFields(item) {
    return {
        theme: normalizedText(item?.researcher_theme)
            || normalizedText(item?.ai_theme),
        codes: Array.isArray(item?.researcher_codes)
            && item.researcher_codes.length
            ? normalizedList(item.researcher_codes)
            : normalizedList(item?.ai_codes),
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
