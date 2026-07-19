export function storedIdentifier(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
}

export const COMPLETION_FILTERS = Object.freeze({
    completed: "completed",
    all: "all",
    incomplete: "incomplete"
});

export function normalizeCompletionFilter(value) {
    const normalized = value === undefined || value === null || value === ""
        ? COMPLETION_FILTERS.completed
        : typeof value === "string"
            ? value.trim().toLowerCase()
            : "";

    if (!Object.hasOwn(COMPLETION_FILTERS, normalized)) {
        throw new Error(
            "Completion filter must be completed, all, or incomplete."
        );
    }

    return normalized;
}

export function sessionMatchesCompletionFilter(session, completionFilter) {
    const filter = normalizeCompletionFilter(completionFilter);

    if (filter === COMPLETION_FILTERS.all) {
        return true;
    }

    return session?.completed === (filter === COMPLETION_FILTERS.completed);
}

export function filterRowsByEligibleSessions(rows, sessions) {
    const eligibleSessionIds = new Set(
        (Array.isArray(sessions) ? sessions : [])
            .map(session => storedIdentifier(session?.session_id))
            .filter(Boolean)
    );

    return (Array.isArray(rows) ? rows : []).filter(row => {
        const sessionId = storedIdentifier(row?.Session);
        return sessionId ? eligibleSessionIds.has(sessionId) : false;
    });
}

export async function loadEligibleSessionRows(
    supabaseClient,
    completionFilter,
    pageSize = 1000
) {
    const filter = normalizeCompletionFilter(completionFilter);
    const rows = [];
    let from = 0;

    while (true) {
        let query = supabaseClient
            .from("interview_sessions")
            .select("session_id, participant_id, language, completed, completed_at, created_at, updated_at, last_activity_at, ended_at, session_status, end_reason, timed_out_at, continuation_of_session_id, inactivity_timeout_minutes, active_duration_ms, elapsed_duration_ms, inactivity_break_count, excluded_idle_duration_ms, inactivity_breaks, duration_calculated_at")
            .order("session_id", { ascending: true });

        if (filter === COMPLETION_FILTERS.completed) {
            query = query.eq("completed", true);
        } else if (filter === COMPLETION_FILTERS.incomplete) {
            query = query.eq("completed", false);
        }

        const { data, error } = await query.range(
            from,
            from + pageSize - 1
        );

        if (error) {
            throw new Error("Eligible interview sessions could not be loaded.", {
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

export function validTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedBoundary(value, name) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    if (typeof value !== "string") {
        throw new Error(`${name} must be an ISO timestamp.`);
    }

    const timestamp = validTimestamp(value);

    if (timestamp === null) {
        throw new Error(`${name} must be an ISO timestamp.`);
    }

    return new Date(timestamp).toISOString();
}

export function normalizeCorpusPeriod(startValue, endValue) {
    const start = normalizedBoundary(startValue, "Starting date/time");
    const end = normalizedBoundary(endValue, "Ending date/time");

    if (start && end && Date.parse(start) > Date.parse(end)) {
        throw new Error("Starting date/time must not be later than ending date/time.");
    }

    return {
        start,
        end,
        allTime: !start && !end
    };
}

export function timestampIsInPeriod(timestamp, period) {
    if (timestamp === null) {
        return false;
    }

    const start = period.start ? Date.parse(period.start) : null;
    const end = period.end ? Date.parse(period.end) : null;

    return (start === null || timestamp >= start)
        && (end === null || timestamp <= end);
}

export function filterCorpusRows(rows, period) {
    const messages = Array.isArray(rows) ? rows : [];

    if (period.allTime) {
        return [...messages];
    }

    const firstTimestampBySession = new Map();

    messages.forEach(row => {
        const sessionId = storedIdentifier(row?.Session);
        const timestamp = validTimestamp(row?.Timestamp);

        if (!sessionId || timestamp === null) {
            return;
        }

        const current = firstTimestampBySession.get(sessionId);

        if (current === undefined || timestamp < current) {
            firstTimestampBySession.set(sessionId, timestamp);
        }
    });

    const includedSessions = new Set(
        [...firstTimestampBySession.entries()]
            .filter(([, timestamp]) => timestampIsInPeriod(timestamp, period))
            .map(([sessionId]) => sessionId)
    );

    return messages.filter(row => {
        const sessionId = storedIdentifier(row?.Session);

        if (sessionId) {
            return includedSessions.has(sessionId);
        }

        return timestampIsInPeriod(validTimestamp(row?.Timestamp), period);
    });
}

export function corpusPeriodFromRequest(req) {
    return normalizeCorpusPeriod(req.query?.start, req.query?.end);
}
