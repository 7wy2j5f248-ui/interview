import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handleChat } from "../api/chat.js";
import {
    buildCorpusStatistics,
    calculateSessionTiming
} from "../api/statistics.js";
import {
    resolveInactivityTimeoutMinutes
} from "../server/sessionLifecycle.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260719001826_add_session_inactivity_and_active_duration.sql",
    import.meta.url
);

function responseRecorder() {
    const response = {
        statusCode: null,
        payload: null,
        headers: {},
        setHeader(name, value) {
            response.headers[name] = value;
        },
        status(code) {
            response.statusCode = code;
            return response;
        },
        json(payload) {
            response.payload = payload;
            return payload;
        }
    };

    return response;
}

test("uses 30 minutes by default and validates configured timeouts", () => {
    assert.equal(resolveInactivityTimeoutMinutes(undefined), 30);
    assert.equal(resolveInactivityTimeoutMinutes("45"), 45);
    assert.throws(() => resolveInactivityTimeoutMinutes("0"));
    assert.throws(() => resolveInactivityTimeoutMinutes("30.5"));
});

test("short gaps and an exact-threshold gap remain active", () => {
    const base = Date.parse("2026-07-18T12:00:00.000Z");
    const timing = calculateSessionTiming([
        base,
        base + 2 * 60_000,
        base + 6 * 60_000,
        base + 36 * 60_000
    ], 30);

    assert.equal(timing.activeDurationMs, 36 * 60_000);
    assert.equal(timing.elapsedDurationMs, 36 * 60_000);
    assert.equal(timing.inactivityBreakCount, 0);
    assert.equal(timing.excludedIdleDurationMs, 0);
});

test("excludes a whole six-hour interval instead of capping it", () => {
    const base = Date.parse("2026-07-18T12:00:00.000Z");
    const timing = calculateSessionTiming([
        base,
        base + 2 * 60_000,
        base + 6 * 60_000,
        base + (6 * 60 + 6) * 60_000,
        base + (6 * 60 + 9) * 60_000
    ], 30);

    assert.equal(timing.activeDurationMs, 9 * 60_000);
    assert.equal(timing.elapsedDurationMs, (6 * 60 + 9) * 60_000);
    assert.equal(timing.inactivityBreakCount, 1);
    assert.equal(timing.excludedIdleDurationMs, 6 * 60 * 60_000);
});

test("language averages use active duration while preserving elapsed span", () => {
    const base = Date.parse("2026-07-18T12:00:00.000Z");
    const rows = [
        { Session: "one", Participant: "p1", Language: "en", Timestamp: new Date(base).toISOString() },
        { Session: "one", Participant: "p1", Language: "en", Timestamp: new Date(base + 5 * 60_000).toISOString() },
        { Session: "two", Participant: "p2", Language: "en", Timestamp: new Date(base).toISOString() },
        { Session: "two", Participant: "p2", Language: "en", Timestamp: new Date(base + 6 * 60 * 60_000).toISOString() },
        { Session: "two", Participant: "p2", Language: "en", Timestamp: new Date(base + (6 * 60 + 5) * 60_000).toISOString() }
    ];
    const statistics = buildCorpusStatistics(rows, []);
    const english = statistics.languages.find(language => language.code === "en");

    assert.equal(english.averageActiveDurationMs, 5 * 60_000);
    assert.equal(english.averageSessionDurationMs, 5 * 60_000);
    assert.equal(
        english.sessions.find(session => session.session === "two")
            .elapsedDurationMs,
        (6 * 60 + 5) * 60_000
    );
});

test("an expired request creates a distinct continuation before any AI call", async () => {
    const calls = [];
    const response = responseRecorder();
    const sessionClient = {
        from(table) {
            assert.equal(table, "participant_descriptors");
            return {
                async upsert(row) {
                    calls.push({ type: "descriptor", row });
                    return { error: null };
                }
            };
        },
        async rpc(name) {
            calls.push({ type: "rpc", name });
            assert.equal(name, "prepare_interview_session");
            return {
                data: [{
                    accepted_session_id: "session-continuation",
                    previous_session_id: "session-old",
                    expired: true,
                    created: true,
                    timeout_at: "2026-07-18T12:30:00.000Z"
                }],
                error: null
            };
        }
    };

    await handleChat({
        method: "POST",
        body: {
            message: "Returning after a long break",
            history: [],
            participantId: "participant-1",
            sessionId: "session-old",
            language: "en"
        }
    }, response, {
        openaiClient: {
            responses: {
                async create() {
                    assert.fail("Expired requests must not call OpenAI.");
                }
            }
        },
        supabaseClient: {
            from() {
                assert.fail("Expired requests must not read or write messages.");
            }
        },
        sessionSupabaseClient: sessionClient,
        inactivityTimeoutMinutes: 30,
        now: () => new Date("2026-07-18T18:00:00.000Z")
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, "SESSION_EXPIRED");
    assert.equal(response.payload.sessionId, "session-continuation");
    assert.equal(response.payload.previousSessionId, "session-old");
    assert.deepEqual(calls.map(call => call.type), ["rpc", "descriptor"]);
});

test("migration persists lifecycle, duration transparency, and backend-only access", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    [
        "last_activity_at",
        "ended_at",
        "session_status",
        "end_reason",
        "timed_out_at",
        "continuation_of_session_id",
        "inactivity_timeout_minutes",
        "active_duration_ms",
        "elapsed_duration_ms",
        "inactivity_break_count",
        "excluded_idle_duration_ms",
        "inactivity_breaks",
        "prepare_interview_session",
        "refresh_interview_session_metrics"
    ].forEach(value => assert.match(migration, new RegExp(value)));

    assert.match(migration, /gap_ms > 30 \* 60 \* 1000/);
    assert.match(migration, /gap_ms <= 30 \* 60 \* 1000/);
    assert.match(migration, /grant execute[\s\S]*prepare_interview_session[\s\S]*to service_role/);
    assert.match(migration, /revoke all on table public\.interview_sessions[\s\S]*from public, anon, authenticated, service_role/);
    assert.doesNotMatch(
        migration,
        /(?:alter table|update|delete from|insert into)\s+public\.interview_messages/i
    );
});

test("participant UI persists session identity and handles server expiry in all languages", async () => {
    const interview = await readFile(
        new URL("../interview.html", import.meta.url),
        "utf8"
    );
    const translationNames = [
        "en", "zh", "ar", "es", "fr", "pt", "tr", "hi", "bn",
        "vi", "ta", "sw", "ur", "id", "so", "my", "fa", "prs"
    ];

    assert.match(interview, /localStorage\.getItem\(SESSION_ID_STORAGE_KEY\)/);
    assert.match(interview, /SESSION_LANGUAGE_STORAGE_KEY/);
    assert.match(interview, /storedSessionLanguage === language/);
    assert.match(interview, /response\.status === 409/);
    assert.match(interview, /data\.code === "SESSION_EXPIRED"/);
    assert.match(interview, /sessionId = data\.sessionId\.trim\(\)/);
    assert.match(interview, /messageBox\.value = message/);

    for (const language of translationNames) {
        const translation = JSON.parse(await readFile(
            new URL(`../translations/${language}.json`, import.meta.url),
            "utf8"
        ));
        assert.ok(translation.session_expired, language);
    }
});

test("researcher UI labels active and elapsed time separately", async () => {
    const dashboard = await readFile(
        new URL("../researcher.html", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /Average active interview duration/);
    assert.match(dashboard, /Active interview duration/);
    assert.match(dashboard, /Elapsed clock span/);
    assert.match(dashboard, /Inactivity breaks/);
    assert.match(dashboard, /Excluded idle time/);
    assert.match(dashboard, /session\.activeDurationMs/);
    assert.match(dashboard, /language\.averageActiveDurationMs/);
});
