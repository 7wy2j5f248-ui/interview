import { createClient } from "@supabase/supabase-js";
import {
    corpusPeriodFromRequest,
    filterCorpusRows,
    storedIdentifier,
    validTimestamp
} from "./corpus.js";

export const SUPPORTED_LANGUAGE_NAMES = Object.freeze({
    en: "English",
    zh: "Simplified Chinese",
    ar: "Arabic",
    es: "Spanish",
    fr: "French",
    pt: "Portuguese",
    tr: "Turkish",
    hi: "Hindi",
    bn: "Bengali",
    vi: "Vietnamese",
    ta: "Tamil",
    sw: "Swahili",
    ur: "Urdu",
    id: "Indonesian",
    so: "Somali",
    my: "Burmese",
    fa: "Persian / Farsi",
    prs: "Dari"
});

export const UNKNOWN_LANGUAGE_CODE = "__unknown__";

function normalizedLanguage(value) {
    return typeof value === "string" && value.trim()
        ? value.trim().toLowerCase()
        : UNKNOWN_LANGUAGE_CODE;
}

function languageName(code) {
    if (code === UNKNOWN_LANGUAGE_CODE) {
        return "Unknown / legacy";
    }

    return SUPPORTED_LANGUAGE_NAMES[code] || `Other / unrecognized (${code})`;
}

function summarizeSession(session, completed) {
    const timestamps = session.timestamps;
    const startTimestamp = timestamps.length
        ? timestamps.reduce((earliest, timestamp) =>
            Math.min(earliest, timestamp)
        )
        : null;
    const endTimestamp = timestamps.length
        ? timestamps.reduce((latest, timestamp) =>
            Math.max(latest, timestamp)
        )
        : null;

    return {
        session: session.session,
        participants: [...session.participants].sort(),
        completed,
        messageCount: session.messageCount,
        startTime: startTimestamp === null
            ? null
            : new Date(startTimestamp).toISOString(),
        endTime: endTimestamp === null
            ? null
            : new Date(endTimestamp).toISOString(),
        durationMs: startTimestamp === null || endTimestamp === null
            ? null
            : endTimestamp - startTimestamp
    };
}

function compareSessions(left, right) {
    if (left.endTime === null && right.endTime === null) {
        return left.session.localeCompare(right.session);
    }

    if (left.endTime === null) {
        return 1;
    }

    if (right.endTime === null) {
        return -1;
    }

    return Date.parse(right.endTime) - Date.parse(left.endTime)
        || left.session.localeCompare(right.session);
}

export function buildCorpusStatistics(rows, completionRows = []) {
    const messages = Array.isArray(rows) ? rows : [];
    const completionBySession = new Map(
        (Array.isArray(completionRows) ? completionRows : [])
            .map(row => [
                storedIdentifier(row?.session_id),
                {
                    completed: row?.completed === true,
                    language: normalizedLanguage(row?.language)
                }
            ])
            .filter(([sessionId]) => sessionId)
    );
    const sessions = new Map();
    const languages = new Map();
    let invalidTimestampMessages = 0;

    messages.forEach(row => {
        const languageCode = normalizedLanguage(row?.Language);
        const sessionId = storedIdentifier(row?.Session);
        const participantId = storedIdentifier(row?.Participant);
        const timestamp = validTimestamp(row?.Timestamp);

        if (!languages.has(languageCode)) {
            languages.set(languageCode, {
                code: languageCode,
                name: languageName(languageCode),
                messageCount: 0,
                sessionIds: new Set()
            });
        }

        const language = languages.get(languageCode);
        language.messageCount += 1;

        if (timestamp === null) {
            invalidTimestampMessages += 1;
        }

        if (!sessionId) {
            return;
        }

        language.sessionIds.add(sessionId);

        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
                session: sessionId,
                participants: new Set(),
                messageCount: 0,
                timestamps: []
            });
        }

        const session = sessions.get(sessionId);
        session.messageCount += 1;

        if (participantId) {
            session.participants.add(participantId);
        }

        if (timestamp !== null) {
            session.timestamps.push(timestamp);
        }
    });

    const sessionSummaries = new Map(
        [...sessions.entries()].map(([sessionId, session]) => [
            sessionId,
            summarizeSession(
                session,
                completionBySession.get(sessionId)?.completed === true
            )
        ])
    );

    const languageSummaries = [...languages.values()].map(language => {
        const languageSessions = [...language.sessionIds]
            .map(sessionId => sessionSummaries.get(sessionId))
            .filter(Boolean)
            .sort(compareSessions);
        const durations = languageSessions
            .map(session => session.durationMs)
            .filter(Number.isFinite);

        return {
            code: language.code,
            name: language.name,
            sessionCount: languageSessions.length,
            completedSessionCount: languageSessions.filter(
                session => session.completed
                    && completionBySession.get(session.session)?.language
                        === language.code
            ).length,
            messageCount: language.messageCount,
            averageSessionDurationMs: durations.length
                ? Math.round(
                    durations.reduce((total, duration) => total + duration, 0)
                    / durations.length
                )
                : null,
            sessions: languageSessions
        };
    }).sort((left, right) => {
        if (left.code === UNKNOWN_LANGUAGE_CODE) {
            return 1;
        }

        if (right.code === UNKNOWN_LANGUAGE_CODE) {
            return -1;
        }

        return left.name.localeCompare(right.name);
    });

    return {
        totals: {
            sessions: sessions.size,
            completedSessions: [...sessionSummaries.values()].filter(
                session => session.completed
            ).length,
            languages: languageSummaries.filter(
                language => language.code !== UNKNOWN_LANGUAGE_CODE
            ).length,
            messages: messages.length
        },
        languages: languageSummaries,
        metadata: {
            unknownLanguageMessages: languages.get(UNKNOWN_LANGUAGE_CODE)
                ?.messageCount || 0,
            messagesWithoutSession: messages.filter(
                row => !storedIdentifier(row?.Session)
            ).length,
            invalidTimestampMessages
        }
    };
}

export async function loadSessionCompletionRows(
    supabaseClient,
    pageSize = 1000
) {
    const rows = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabaseClient
            .from("interview_sessions")
            .select("session_id, language, completed")
            .order("session_id", { ascending: true })
            .range(from, from + pageSize - 1);

        if (error) {
            throw new Error("Interview completion statistics could not be loaded.", {
                cause: error
            });
        }

        const page = data || [];
        rows.push(...page);

        if (page.length < pageSize) {
            return rows;
        }

        from += pageSize;
    }
}

export async function loadStatisticsRows(supabaseClient, pageSize = 1000) {
    const rows = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Participant, Session, Language, Timestamp")
            .order("id", { ascending: true })
            .range(from, from + pageSize - 1);

        if (error) {
            throw new Error("Interview statistics could not be loaded.", {
                cause: error
            });
        }

        const page = data || [];
        rows.push(...page);

        if (page.length < pageSize) {
            return rows;
        }

        from += pageSize;
    }
}

export async function handleStatistics(
    req,
    res,
    { supabaseClient, sessionSupabaseClient }
) {
    if (req.method && req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed." });
    }

    try {
        res.setHeader("Cache-Control", "no-store");
        const period = corpusPeriodFromRequest(req);
        const [rows, completionRows] = await Promise.all([
            loadStatisticsRows(supabaseClient),
            loadSessionCompletionRows(sessionSupabaseClient)
        ]);
        const statistics = buildCorpusStatistics(
            filterCorpusRows(rows, period),
            completionRows
        );

        statistics.metadata.period = period;

        return res.status(200).json(statistics);
    } catch (error) {
        if (error?.message?.includes("date/time")) {
            return res.status(400).json({ error: error.message });
        }

        console.error("Researcher statistics loading failed:", error);
        return res.status(500).json({
            error: "Unable to load interview statistics."
        });
    }
}

export default async function handler(req, res) {
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            error: "Server configuration is incomplete."
        });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
    );
    const sessionSupabaseClient = createClient(
        process.env.SUPABASE_URL,
        secretKey,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        }
    );

    return handleStatistics(req, res, {
        supabaseClient,
        sessionSupabaseClient
    });
}
