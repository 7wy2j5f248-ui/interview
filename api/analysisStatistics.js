import { storedIdentifier } from "./corpus.js";
import {
    SUPPORTED_LANGUAGE_NAMES,
    UNKNOWN_LANGUAGE_CODE
} from "./statistics.js";

export const DESCRIPTIVE_STATISTICS_VERSION = "task-014-descriptive-v1";

function normalizedLanguage(value) {
    const code = typeof value === "string"
        ? value.trim().toLowerCase()
        : "";

    return code && SUPPORTED_LANGUAGE_NAMES[code]
        ? code
        : UNKNOWN_LANGUAGE_CODE;
}

function languageLabel(code) {
    return code === UNKNOWN_LANGUAGE_CODE
        ? "Unknown / legacy"
        : SUPPORTED_LANGUAGE_NAMES[code];
}

function codeKey(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function messageIdentifier(message) {
    return storedIdentifier(message?.id ?? message?.messageId);
}

function messageSession(message) {
    return storedIdentifier(message?.Session ?? message?.session);
}

function messageParticipant(message) {
    return storedIdentifier(message?.Participant ?? message?.participant);
}

function messageLanguage(message) {
    return normalizedLanguage(message?.Language ?? message?.language);
}

function evidenceMessageIdentifier(link) {
    return storedIdentifier(link?.message_id ?? link?.messageId);
}

function evidenceCodes(link) {
    const values = link?.code_attributions ?? link?.codes;
    return Array.isArray(values) ? values : [];
}

function percentage(numerator, denominator) {
    return denominator > 0
        ? Math.round((numerator / denominator) * 1000) / 10
        : null;
}

export function calculateItemStatistics({
    analysisRunId,
    workingCodes = [],
    evidenceLinks = [],
    corpusMessages = [],
    calculatedAt = new Date().toISOString()
}) {
    const corpusById = new Map();
    const eligibleSessions = new Set();

    (Array.isArray(corpusMessages) ? corpusMessages : []).forEach(message => {
        const id = messageIdentifier(message);

        if (!id) {
            return;
        }

        corpusById.set(id, message);
        const session = messageSession(message);

        if (session) {
            eligibleSessions.add(session);
        }
    });

    const includedByMessage = new Map();
    const roundMessages = new Map();

    (Array.isArray(evidenceLinks) ? evidenceLinks : []).forEach(link => {
        if (link?.included !== true) {
            return;
        }

        const messageId = evidenceMessageIdentifier(link);

        if (!messageId || !corpusById.has(messageId)) {
            return;
        }

        if (!includedByMessage.has(messageId)) {
            includedByMessage.set(messageId, new Set());
        }

        evidenceCodes(link).forEach(code => {
            const key = codeKey(code);

            if (key) {
                includedByMessage.get(messageId).add(key);
            }
        });

        const round = Number.isInteger(link?.evidence_round)
            ? link.evidence_round
            : Number.isInteger(link?.round)
                ? link.round
                : 0;
        const source = typeof link?.source === "string" && link.source
            ? link.source
            : "unknown";
        const roundKey = `${round}:${source}`;

        if (!roundMessages.has(roundKey)) {
            roundMessages.set(roundKey, {
                round,
                source,
                messageIds: new Set()
            });
        }

        roundMessages.get(roundKey).messageIds.add(messageId);
    });

    const supportingSessions = new Set();
    const participants = new Set();
    const languages = new Map();
    const normalizedWorkingCodes = [];
    const workingCodeByKey = new Map();

    (Array.isArray(workingCodes) ? workingCodes : []).forEach(code => {
        if (typeof code !== "string" || !code.trim()) {
            return;
        }

        const label = code.trim();
        const key = codeKey(label);

        if (!workingCodeByKey.has(key)) {
            workingCodeByKey.set(key, label);
            normalizedWorkingCodes.push(label);
        }
    });

    const perCodeMessages = new Map(
        normalizedWorkingCodes.map(code => [codeKey(code), new Set()])
    );
    const perCodeSessions = new Map(
        normalizedWorkingCodes.map(code => [codeKey(code), new Set()])
    );

    includedByMessage.forEach((attributedCodes, messageId) => {
        const message = corpusById.get(messageId);
        const session = messageSession(message);
        const participant = messageParticipant(message);
        const language = messageLanguage(message);

        if (session) {
            supportingSessions.add(session);
        }

        if (participant) {
            participants.add(participant);
        }

        if (!languages.has(language)) {
            languages.set(language, {
                code: language,
                label: languageLabel(language),
                messageIds: new Set(),
                sessionIds: new Set()
            });
        }

        const languageEntry = languages.get(language);
        languageEntry.messageIds.add(messageId);

        if (session) {
            languageEntry.sessionIds.add(session);
        }

        attributedCodes.forEach(key => {
            if (!workingCodeByKey.has(key)) {
                return;
            }

            perCodeMessages.get(key).add(messageId);

            if (session) {
                perCodeSessions.get(key).add(session);
            }
        });
    });

    const supportingSessionCount = supportingSessions.size;
    const eligibleSessionCount = eligibleSessions.size;

    return {
        calculationVersion: DESCRIPTIVE_STATISTICS_VERSION,
        calculatedAt,
        analysisRunId,
        supportingMessageCount: includedByMessage.size,
        supportingSessionCount,
        eligibleSessionCount,
        sessionPrevalencePercentage: percentage(
            supportingSessionCount,
            eligibleSessionCount
        ),
        uniqueParticipantCount: participants.size || null,
        uniqueParticipantCountAvailable: participants.size > 0,
        languageCount: languages.size,
        languageDistribution: [...languages.values()]
            .map(language => ({
                code: language.code,
                label: language.label,
                messageCount: language.messageIds.size,
                sessionCount: language.sessionIds.size
            }))
            .sort((left, right) => {
                if (left.code === UNKNOWN_LANGUAGE_CODE) {
                    return 1;
                }

                if (right.code === UNKNOWN_LANGUAGE_CODE) {
                    return -1;
                }

                return left.label.localeCompare(right.label);
            }),
        perCode: normalizedWorkingCodes.map(code => {
            const key = codeKey(code);
            return {
                code,
                messageCount: perCodeMessages.get(key).size,
                sessionCount: perCodeSessions.get(key).size
            };
        }),
        evidenceRoundDistribution: [...roundMessages.values()]
            .sort((left, right) => left.round - right.round
                || left.source.localeCompare(right.source))
            .map(entry => ({
                round: entry.round,
                source: entry.source,
                messageCount: entry.messageIds.size
            }))
    };
}
