import { createClient } from "@supabase/supabase-js";
import {
    corpusPeriodFromRequest,
    filterCorpusRows,
    storedIdentifier,
    validTimestamp
} from "../server/corpus.js";

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

export function calculateSessionTiming(
    timestamps,
    inactivityTimeoutMinutes = 30
) {
    const thresholdMs = inactivityTimeoutMinutes * 60 * 1000;
    const ordered = (Array.isArray(timestamps) ? timestamps : [])
        .filter(Number.isFinite)
        .sort((left, right) => left - right);

    if (!ordered.length) {
        return {
            startTimestamp: null,
            endTimestamp: null,
            activeDurationMs: null,
            elapsedDurationMs: null,
            inactivityBreakCount: 0,
            excludedIdleDurationMs: 0,
            inactivityBreaks: []
        };
    }

    let activeDurationMs = 0;
    let excludedIdleDurationMs = 0;
    const inactivityBreaks = [];

    for (let index = 1; index < ordered.length; index += 1) {
        const previousTimestamp = ordered[index - 1];
        const nextTimestamp = ordered[index];
        const intervalMs = nextTimestamp - previousTimestamp;

        if (intervalMs > thresholdMs) {
            excludedIdleDurationMs += intervalMs;
            inactivityBreaks.push({
                previousMessageAt: new Date(previousTimestamp).toISOString(),
                nextMessageAt: new Date(nextTimestamp).toISOString(),
                timeoutAt: new Date(
                    previousTimestamp + thresholdMs
                ).toISOString(),
                durationMs: intervalMs,
                thresholdMinutes: inactivityTimeoutMinutes
            });
        } else {
            activeDurationMs += intervalMs;
        }
    }

    return {
        startTimestamp: ordered[0],
        endTimestamp: ordered[ordered.length - 1],
        activeDurationMs,
        elapsedDurationMs: ordered[ordered.length - 1] - ordered[0],
        inactivityBreakCount: inactivityBreaks.length,
        excludedIdleDurationMs,
        inactivityBreaks
    };
}

function normalizedStoredBreaks(value) {
    return (Array.isArray(value) ? value : []).map(item => ({
        previousMessageAt: item?.previous_message_at || null,
        nextMessageAt: item?.next_message_at || null,
        timeoutAt: item?.timeout_at || null,
        durationMs: Number(item?.duration_ms),
        thresholdMinutes: Number(item?.threshold_minutes)
    }));
}

function summarizeSession(session, lifecycle = {}) {
    const fallbackTimeoutMinutes = Number.isInteger(
        lifecycle.inactivityTimeoutMinutes
    ) && lifecycle.inactivityTimeoutMinutes > 0
        ? lifecycle.inactivityTimeoutMinutes
        : 30;
    const calculated = calculateSessionTiming(
        session.timestamps,
        fallbackTimeoutMinutes
    );
    const hasPersistedTiming = lifecycle.durationCalculatedAt
        && Number.isFinite(lifecycle.activeDurationMs)
        && Number.isFinite(lifecycle.elapsedDurationMs);
    const startTimestamp = calculated.startTimestamp;
    const endTimestamp = calculated.endTimestamp;
    const activeDurationMs = hasPersistedTiming
        ? lifecycle.activeDurationMs
        : calculated.activeDurationMs;
    const elapsedDurationMs = hasPersistedTiming
        ? lifecycle.elapsedDurationMs
        : calculated.elapsedDurationMs;
    const inactivityBreaks = hasPersistedTiming
        ? normalizedStoredBreaks(lifecycle.inactivityBreaks)
        : calculated.inactivityBreaks;

    return {
        session: session.session,
        participants: [...session.participants].sort(),
        completed: lifecycle.completed === true,
        messageCount: session.messageCount,
        startTime: startTimestamp === null
            ? null
            : new Date(startTimestamp).toISOString(),
        endTime: endTimestamp === null
            ? null
            : new Date(endTimestamp).toISOString(),
        activeDurationMs,
        elapsedDurationMs,
        durationMs: activeDurationMs,
        inactivityBreakCount: hasPersistedTiming
            ? lifecycle.inactivityBreakCount
            : calculated.inactivityBreakCount,
        excludedIdleDurationMs: hasPersistedTiming
            ? lifecycle.excludedIdleDurationMs
            : calculated.excludedIdleDurationMs,
        inactivityBreaks,
        inactivityTimeoutMinutes: fallbackTimeoutMinutes,
        lastActivityAt: lifecycle.lastActivityAt || (endTimestamp === null
            ? null
            : new Date(endTimestamp).toISOString()),
        endedAt: lifecycle.endedAt || null,
        timedOutAt: lifecycle.timedOutAt || null,
        sessionStatus: lifecycle.sessionStatus || (
            lifecycle.completed === true ? "completed" : "active"
        ),
        endReason: lifecycle.endReason || null,
        continuationOfSessionId:
            lifecycle.continuationOfSessionId || null,
        durationCalculatedAt: lifecycle.durationCalculatedAt || null
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
                    language: normalizedLanguage(row?.language),
                    lastActivityAt: row?.last_activity_at || null,
                    endedAt: row?.ended_at || null,
                    timedOutAt: row?.timed_out_at || null,
                    sessionStatus: row?.session_status || null,
                    endReason: row?.end_reason || null,
                    continuationOfSessionId:
                        row?.continuation_of_session_id || null,
                    inactivityTimeoutMinutes: Number(
                        row?.inactivity_timeout_minutes
                    ),
                    activeDurationMs: Number(row?.active_duration_ms),
                    elapsedDurationMs: Number(row?.elapsed_duration_ms),
                    inactivityBreakCount: Number(
                        row?.inactivity_break_count
                    ),
                    excludedIdleDurationMs: Number(
                        row?.excluded_idle_duration_ms
                    ),
                    inactivityBreaks: row?.inactivity_breaks,
                    durationCalculatedAt:
                        row?.duration_calculated_at || null
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
                completionBySession.get(sessionId) || {}
            )
        ])
    );

    const languageSummaries = [...languages.values()].map(language => {
        const languageSessions = [...language.sessionIds]
            .map(sessionId => sessionSummaries.get(sessionId))
            .filter(Boolean)
            .sort(compareSessions);
        const durations = languageSessions
            .map(session => session.activeDurationMs)
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
            averageActiveDurationMs: durations.length
                ? Math.round(
                    durations.reduce((total, duration) => total + duration, 0)
                    / durations.length
                )
                : null,
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
            invalidTimestampMessages,
            durationCalculation: {
                primaryMetric: "active_interview_duration",
                rule: "Sum consecutive-message intervals; exclude each interval greater than the session inactivity threshold.",
                defaultInactivityTimeoutMinutes: 30
            }
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
            .select("session_id, language, completed, last_activity_at, ended_at, session_status, end_reason, timed_out_at, continuation_of_session_id, inactivity_timeout_minutes, active_duration_ms, elapsed_duration_ms, inactivity_break_count, excluded_idle_duration_ms, inactivity_breaks, duration_calculated_at")
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
