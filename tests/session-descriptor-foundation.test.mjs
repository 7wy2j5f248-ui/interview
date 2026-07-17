import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    filterRowsByEligibleSessions,
    loadEligibleSessionRows,
    normalizeCompletionFilter,
    sessionMatchesCompletionFilter
} from "../server/corpus.js";
import {
    ensureParticipantDescriptor,
    loadParticipantDescriptor,
    normalizedDescriptorChanges,
    updateParticipantDescriptor
} from "../server/participantDescriptors.js";
import { handleChat } from "../api/chat.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260717015303_add_session_metadata_and_participant_descriptors.sql",
    import.meta.url
);

function sessionClient(sessionRows) {
    return {
        from(table) {
            assert.equal(table, "interview_sessions");
            let completed;

            const query = {
                select() {
                    return query;
                },
                order() {
                    return query;
                },
                eq(column, value) {
                    assert.equal(column, "completed");
                    completed = value;
                    return query;
                },
                async range(from, to) {
                    const eligible = completed === undefined
                        ? sessionRows
                        : sessionRows.filter(row => row.completed === completed);
                    return {
                        data: eligible.slice(from, to + 1),
                        error: null
                    };
                }
            };

            return query;
        }
    };
}

function descriptorClient() {
    const records = new Map();

    return {
        records,
        from(table) {
            assert.equal(table, "participant_descriptors");

            return {
                async upsert(record, options) {
                    assert.deepEqual(options, {
                        onConflict: "session_id",
                        ignoreDuplicates: true
                    });

                    if (!records.has(record.session_id)) {
                        records.set(record.session_id, {
                            id: `descriptor-${records.size + 1}`,
                            ...record,
                            current_country: null,
                            additional_descriptors: {}
                        });
                    }

                    return { error: null };
                },
                select() {
                    let sessionId;
                    const query = {
                        eq(column, value) {
                            assert.equal(column, "session_id");
                            sessionId = value;
                            return query;
                        },
                        async maybeSingle() {
                            return {
                                data: records.get(sessionId) || null,
                                error: null
                            };
                        }
                    };
                    return query;
                },
                update(changes) {
                    let sessionId;
                    const query = {
                        eq(column, value) {
                            assert.equal(column, "session_id");
                            sessionId = value;
                            return query;
                        },
                        select() {
                            return query;
                        },
                        async maybeSingle() {
                            const current = records.get(sessionId);
                            const updated = current
                                ? { ...current, ...changes }
                                : null;

                            if (updated) {
                                records.set(sessionId, updated);
                            }

                            return { data: updated, error: null };
                        }
                    };
                    return query;
                }
            };
        }
    };
}

test("completion selection defaults to completed and supports all three scopes", () => {
    assert.equal(normalizeCompletionFilter(), "completed");
    assert.equal(normalizeCompletionFilter("completed"), "completed");
    assert.equal(normalizeCompletionFilter("all"), "all");
    assert.equal(normalizeCompletionFilter("incomplete"), "incomplete");
    assert.throws(
        () => normalizeCompletionFilter("unknown"),
        /completed, all, or incomplete/
    );

    assert.equal(
        sessionMatchesCompletionFilter({ completed: true }, "completed"),
        true
    );
    assert.equal(
        sessionMatchesCompletionFilter({ completed: false }, "completed"),
        false
    );
    assert.equal(
        sessionMatchesCompletionFilter({ completed: false }, "incomplete"),
        true
    );
    assert.equal(sessionMatchesCompletionFilter({}, "all"), true);
});

test("session metadata is selected before transcript messages", async () => {
    const sessions = [
        { session_id: "completed-session", completed: true },
        { session_id: "incomplete-session", completed: false }
    ];
    const rows = [
        { Session: "completed-session", Message: "complete" },
        { Session: "incomplete-session", Message: "incomplete" },
        { Session: "legacy-session", Message: "not in metadata" },
        { Session: null, Message: "no session" }
    ];
    const client = sessionClient(sessions);

    const completed = await loadEligibleSessionRows(client, "completed");
    const incomplete = await loadEligibleSessionRows(client, "incomplete");
    const all = await loadEligibleSessionRows(client, "all");

    assert.deepEqual(
        filterRowsByEligibleSessions(rows, completed).map(row => row.Message),
        ["complete"]
    );
    assert.deepEqual(
        filterRowsByEligibleSessions(rows, incomplete).map(row => row.Message),
        ["incomplete"]
    );
    assert.deepEqual(
        filterRowsByEligibleSessions(rows, all).map(row => row.Message),
        ["complete", "incomplete"]
    );
});

test("one descriptor is created per session and backend reads and updates it", async () => {
    const client = descriptorClient();

    await ensureParticipantDescriptor(client, {
        sessionId: "session-1",
        participantId: "participant-1"
    });
    await ensureParticipantDescriptor(client, {
        sessionId: "session-1",
        participantId: "participant-1"
    });

    assert.equal(client.records.size, 1);
    assert.equal(
        (await loadParticipantDescriptor(client, "session-1")).participant_id,
        "participant-1"
    );

    const updated = await updateParticipantDescriptor(
        client,
        "session-1",
        {
            current_country: " Canada ",
            birth_cohort: "post_1990s",
            age: 25,
            additional_descriptors: { migration_generation: "first" }
        }
    );

    assert.equal(updated.current_country, "Canada");
    assert.equal(updated.birth_cohort, "post_1990s");
    assert.equal(updated.age, 25);
    assert.deepEqual(updated.additional_descriptors, {
        migration_generation: "first"
    });
});

test("descriptor normalization preserves explicit missing-information states", () => {
    assert.deepEqual(normalizedDescriptorChanges({
        current_country: "unidentified",
        gender: "declined",
        education_level: "not_asked",
        social_identity: null
    }), {
        current_country: "unidentified",
        gender: "declined",
        education_level: "not_asked",
        social_identity: null
    });
});

test("migration preserves transcripts and defines session-linked secure descriptors", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    assert.doesNotMatch(
        migration,
        /alter\s+table\s+public\.interview_messages/i
    );
    assert.doesNotMatch(
        migration,
        /(insert\s+into|update|delete\s+from)\s+public\.interview_messages/i
    );
    assert.match(migration, /add column id uuid default gen_random_uuid\(\)/);
    assert.match(migration, /on conflict \(session_id\) do nothing/);
    assert.match(migration, /create table public\.participant_descriptors/);
    assert.match(migration, /unique \(session_id\)/);
    assert.match(
        migration,
        /references public\.interview_sessions\(session_id, participant_id\)/
    );
    assert.match(
        migration,
        /alter table public\.participant_descriptors enable row level security/
    );
    assert.match(
        migration,
        /revoke all on table public\.participant_descriptors\s+from public, anon, authenticated, service_role/
    );
    assert.match(
        migration,
        /grant select, insert, update on table public\.participant_descriptors\s+to service_role/
    );
    assert.doesNotMatch(
        migration,
        /grant[^;]*(anon|authenticated)|grant[^;]*delete/i
    );
    assert.match(migration, /completion_filter in \('completed', 'all', 'incomplete'\)/);
    assert.match(migration, /alter column completion_filter set default 'completed'/);
    assert.match(migration, /alter column completed_only set default true/);
    assert.match(
        migration,
        /completed_only = \(completion_filter = 'completed'\)/
    );
});

test("application keeps completion semantics and secret access server-side", async () => {
    const [chat, analysis, dashboard, browserConfig] = await Promise.all([
        readFile(new URL("../api/chat.js", import.meta.url), "utf8"),
        readFile(new URL("../api/analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../researcher-analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../config.js", import.meta.url), "utf8")
    ]);

    assert.match(chat, /finalQuestionAnswered/);
    assert.match(chat, /complete_interview_session/);
    assert.match(chat, /ensureParticipantDescriptor/);
    assert.match(analysis, /loadEligibleSessionRows/);
    assert.match(analysis, /loadInterviewMessagesForSessions/);
    assert.match(analysis, /completion_filter: completionFilter/);
    assert.match(dashboard, /completionFilter\.value/);
    assert.doesNotMatch(browserConfig, /SUPABASE_SECRET_KEY/);
});

test("a final canonical answer persists messages, completion, and a descriptor", async () => {
    const calls = [];
    const design = {
        id: "design-1",
        research_goal: "Understand participant experience.",
        ai_role: "Ask neutral questions.",
        ending_message: "Thank the participant.",
        interview_questions: "1. What happened?",
        interview_question_count: 1,
        maximum_interviewer_questions: 3
    };
    const messageClient = {
        from(table) {
            if (table === "active_design") {
                const query = {
                    select() { return query; },
                    order() { return query; },
                    limit() { return query; },
                    async maybeSingle() {
                        return {
                            data: { active_design_id: design.id },
                            error: null
                        };
                    }
                };
                return query;
            }

            if (table === "research_designs") {
                const query = {
                    select() { return query; },
                    eq() { return query; },
                    async maybeSingle() {
                        return { data: design, error: null };
                    }
                };
                return query;
            }

            assert.equal(table, "interview_messages");
            return {
                select() {
                    return {
                        eq() {
                            return {
                                async order() {
                                    return { data: [], error: null };
                                }
                            };
                        }
                    };
                },
                async insert(rows) {
                    calls.push({ operation: "messages", rows });
                    return { error: null };
                }
            };
        }
    };
    const sessionClient = {
        from(table) {
            assert.ok([
                "interview_sessions",
                "participant_descriptors"
            ].includes(table));
            return {
                async upsert(row) {
                    calls.push({ operation: table, row });
                    return { error: null };
                }
            };
        },
        async rpc(name, args) {
            calls.push({ operation: "rpc", name, args });
            return { data: true, error: null };
        }
    };
    const response = {
        statusCode: null,
        payload: null,
        status(code) {
            response.statusCode = code;
            return response;
        },
        json(payload) {
            response.payload = payload;
            return payload;
        }
    };

    await handleChat({
        method: "POST",
        body: {
            message: "My answer.",
            history: [{ role: "user", content: "My answer." }],
            participantId: "participant-1",
            sessionId: "session-1",
            language: "en"
        }
    }, response, {
        openaiClient: {
            responses: {
                async create() {
                    return {
                        output_text: JSON.stringify({
                            reply: "Thank you.",
                            final_question_answered: true
                        })
                    };
                }
            }
        },
        supabaseClient: messageClient,
        sessionSupabaseClient: sessionClient
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { reply: "Thank you." });
    assert.deepEqual(calls.map(call => call.operation), [
        "interview_sessions",
        "participant_descriptors",
        "messages",
        "rpc"
    ]);
    assert.equal(calls[3].name, "complete_interview_session");
    assert.deepEqual(calls[3].args, { p_session_id: "session-1" });
});
