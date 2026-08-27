import { storedIdentifier } from "./corpus.js";
import { DEFAULT_OPENAI_MODEL } from "./modelConfiguration.js";

export const QUALITATIVE_ANALYSIS_MODEL = DEFAULT_OPENAI_MODEL;
export const QUALITATIVE_ANALYSIS_VERSION = "task-014-v7-complete-cases-before-summary";
export const DEFAULT_ANALYSIS_BATCH_SIZE = 40;
export const MAX_THEME_SUBJECT_WORDS = 2;
export const MAX_THEME_SUBJECT_LENGTH = 60;

function normalizedText(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
}

export function isShortThemeSubject(value) {
    const theme = normalizedText(value)?.replace(/\s+/gu, " ");

    if (!theme || theme.length > MAX_THEME_SUBJECT_LENGTH) {
        return false;
    }

    const words = theme.split(" ").filter(Boolean);
    return words.length <= MAX_THEME_SUBJECT_WORDS
        && !/[.!?;:]$/u.test(theme);
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
                content: "You are producing one qualitative individual case report. The supplied evidence belongs to exactly one participant session; never compare, combine, or generalize across participants. Analyse this case bottom-up: first identify exact evidence phrases and concise keywords, then group them into concise codes, then group those codes into themes. Return the required theme-centred JSON structure only after completing that bottom-up case analysis. The case must have at least one theme when substantive answers are present. A theme is a reusable, comparable subject label, not a case summary. It must be exactly one or two words. Reuse labels such as 'Sleep routine', 'Sleep duration', 'Night waking', 'Sleep strategies', 'Technology', 'Work', 'Family', 'Ageing', 'Environment', and 'Satisfaction'. For example, replace 'Stable sleep routines anchored by longstanding habits' with the theme 'Sleep routine'; put 'Stable' and 'Longstanding' under concise codes. Under 'Work', use codes such as 'Long hours', 'Overtime', 'Weekend work', or 'Overwork'. If this case covers two subjects such as work and family, create separate themes rather than a compound statement. Themes and codes must be short labels, never sentences, findings, cause-and-effect interpretations, or case summaries. Put fuller case interpretation in the rationale. Return exact supporting participant message IDs, explicit code-to-message attribution, explicit keyword-to-message attribution, and exact verbatim coded phrases. A coded phrase must appear verbatim in the original message or its supplied English translation. Never cite an ID outside this single-case evidence set. Do not invent or rewrite evidence."
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
