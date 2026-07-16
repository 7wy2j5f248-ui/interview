export function storedIdentifier(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
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
