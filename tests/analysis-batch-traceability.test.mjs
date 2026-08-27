import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    buildAnalysisBatches,
    discussAnalysisWithResearcher,
    generateSuggestionsForBatch,
    isShortThemeSubject,
    validateSuggestedItems,
    workingAnalysisFields
} from "../server/analysisCore.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260717040000_add_analysis_batch_traceability.sql",
    import.meta.url
);

const messages = [
    {
        id: "message-1",
        sessionId: "session-1",
        participantId: "participant-1",
        language: "en",
        originalText: "Night work made it difficult to rest.",
        englishTranslation: null,
        analysisText: "Night work made it difficult to rest."
    },
    {
        id: "message-2",
        sessionId: "session-1",
        participantId: "participant-1",
        language: "en",
        originalText: "I kept checking my phone.",
        englishTranslation: null,
        analysisText: "I kept checking my phone."
    },
    {
        id: "message-3",
        sessionId: "session-2",
        participantId: "participant-2",
        language: "zh",
        originalText: "工作压力影响睡眠。",
        englishTranslation: "Work pressure affected sleep.",
        analysisText: "Work pressure affected sleep."
    }
];

function completeSuggestion() {
    return {
        items: [{
            theme: "Sleep",
            codes: ["Work pressure", "Phone checking"],
            coded_phrases: [
                {
                    phrase: "Night work",
                    message_ids: ["message-1"]
                },
                {
                    phrase: "Work pressure",
                    message_ids: ["message-3"]
                }
            ],
            keywords: ["sleep", "phone"],
            supporting_message_ids: [
                "message-1",
                "message-2",
                "message-3"
            ],
            code_evidence: [
                {
                    code: "Work pressure",
                    message_ids: ["message-1", "message-3"]
                },
                {
                    code: "Phone checking",
                    message_ids: ["message-2"]
                }
            ],
            keyword_evidence: [
                {
                    keyword: "sleep",
                    message_ids: ["message-1", "message-3"]
                },
                {
                    keyword: "phone",
                    message_ids: ["message-2"]
                }
            ],
            rationale: "Participants linked work and phone use with disrupted rest."
        }]
    };
}

test("every stored AI suggestion component has exact message provenance", () => {
    const result = validateSuggestedItems(completeSuggestion(), messages);

    assert.equal(result.items.length, 1);
    assert.equal(result.skippedComponents, 0);
    assert.deepEqual(result.items[0].codedPhrases, [
        "Night work",
        "Work pressure"
    ]);

    const types = new Set(
        result.items[0].suggestionSources.map(source => source.suggestionType)
    );
    assert.deepEqual(types, new Set([
        "theme",
        "code",
        "coded_phrase",
        "keyword"
    ]));
    result.items[0].suggestionSources.forEach(source => {
        assert.ok(messages.some(message => message.id === source.messageId));
    });
});

test("themes are one- or two-word subject headings rather than findings", () => {
    assert.equal(isShortThemeSubject("Work"), true);
    assert.equal(isShortThemeSubject("Sleep"), true);
    assert.equal(isShortThemeSubject("Work disrupts rest"), false);
    assert.equal(isShortThemeSubject("Sleep pressure."), false);

    const suggestion = completeSuggestion();
    suggestion.items[0].theme = "Work pressure affects sleep";
    const result = validateSuggestedItems(suggestion, messages);

    assert.equal(result.items.length, 0);
    assert.equal(result.skippedItems, 1);
});

test("untraceable components and non-verbatim coded phrases are not persisted", () => {
    const suggestion = completeSuggestion();
    suggestion.items[0].codes.push("No source code");
    suggestion.items[0].keywords.push("unsupported");
    suggestion.items[0].coded_phrases.push({
        phrase: "Invented quotation",
        message_ids: ["message-1"]
    });
    const result = validateSuggestedItems(suggestion, messages);

    assert.deepEqual(result.items[0].codes, [
        "Work pressure",
        "Phone checking"
    ]);
    assert.deepEqual(result.items[0].keywords, ["sleep", "phone"]);
    assert.ok(!result.items[0].codedPhrases.includes("Invented quotation"));
    assert.equal(result.skippedComponents, 3);
});

test("session-preserving batch numbers remain deterministic", () => {
    const batches = buildAnalysisBatches(messages, 2);

    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].map(message => message.id), [
        "message-1",
        "message-2"
    ]);
    assert.deepEqual(batches[1].map(message => message.id), ["message-3"]);
    assert.deepEqual(
        buildAnalysisBatches(messages, 2).map(batch =>
            batch.map(message => message.id)
        ),
        batches.map(batch => batch.map(message => message.id))
    );
});

test("available OpenAI input-token usage is retained for batch persistence", async () => {
    const openaiClient = {
        responses: {
            async create() {
                return {
                    output_text: JSON.stringify(completeSuggestion()),
                    usage: { input_tokens: 4321 }
                };
            }
        }
    };
    const result = await generateSuggestionsForBatch(openaiClient, messages);

    assert.equal(result.inputTokenCount, 4321);
    assert.equal(result.items.length, 1);
});

test("AI discussion returns an explicit code-to-keyword revision proposal", async () => {
    let request;
    const openaiClient = {
        responses: {
            async create(value) {
                request = value;
                return {
                    output_text: JSON.stringify({
                        reply: "The three keywords support one schedule-related code.",
                        proposal: {
                            should_apply: true,
                            theme: "Work",
                            codes: ["Irregular schedules"],
                            keywords: [
                                "night shift",
                                "rotating schedule",
                                "overtime"
                            ],
                            code_keyword_groups: [{
                                code: "Irregular schedules",
                                keywords: [
                                    "night shift",
                                    "rotating schedule",
                                    "overtime"
                                ]
                            }],
                            rationale: "All three describe unstable or extended work time."
                        }
                    })
                };
            }
        }
    };
    const result = await discussAnalysisWithResearcher(
        openaiClient,
        {
            theme: "Work",
            codes: ["Irregular schedules"],
            keywords: ["night shift", "rotating schedule", "overtime"],
            evidence: [{ messageId: "message-1", participantId: "participant-1" }]
        },
        [{ role: "researcher", content: "Do these form one code?" }]
    );

    assert.equal(request.store, false);
    assert.match(
        request.input[0].content,
        /under 'Work'.*'Long hours'.*'Overtime'/
    );
    assert.equal(result.proposal.shouldApply, true);
    assert.deepEqual(result.proposal.codeKeywordGroups, [{
        code: "Irregular schedules",
        keywords: ["night shift", "rotating schedule", "overtime"]
    }]);
});

test("AI discussion cannot apply a sentence-style theme proposal", async () => {
    const openaiClient = {
        responses: {
            async create() {
                return {
                    output_text: JSON.stringify({
                        reply: "The codes remain useful, but the theme is too specific.",
                        proposal: {
                            should_apply: true,
                            theme: "Work pressure disrupts sleep",
                            codes: ["Irregular schedules"],
                            keywords: ["night shift"],
                            code_keyword_groups: [{
                                code: "Irregular schedules",
                                keywords: ["night shift"]
                            }],
                            rationale: "The participant links work timing to sleep."
                        }
                    })
                };
            }
        }
    };
    const result = await discussAnalysisWithResearcher(
        openaiClient,
        {
            theme: "Work",
            codes: ["Irregular schedules"],
            keywords: ["night shift"],
            evidence: [{ messageId: "message-1" }]
        },
        [{ role: "researcher", content: "Please revise this theme." }]
    );

    assert.equal(result.proposal.shouldApply, false);
    assert.equal(result.proposal.theme, "Work");
});

test("researcher revisions preserve coded phrases through confirmation inputs", () => {
    assert.deepEqual(workingAnalysisFields({
        ai_theme: "AI theme",
        ai_codes: ["AI code"],
        ai_coded_phrases: ["AI phrase"],
        ai_keywords: ["AI keyword"],
        researcher_theme: "Revised theme",
        researcher_codes: ["Revised code"],
        researcher_coded_phrases: ["Revised phrase"],
        researcher_keywords: ["Revised keyword"]
    }), {
        theme: "Revised theme",
        codes: ["Revised code"],
        codedPhrases: ["Revised phrase"],
        keywords: ["Revised keyword"],
        note: null
    });
});

test("migration stores frozen multi-batch provenance with backend-only grants", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    for (const table of [
        "qualitative_analysis_batches",
        "qualitative_analysis_batch_sessions",
        "qualitative_analysis_batch_messages",
        "qualitative_analysis_item_batches",
        "qualitative_analysis_suggestion_sources"
    ]) {
        assert.match(migration, new RegExp(`create table public\\.${table}`));
        assert.match(
            migration,
            new RegExp(`alter table public\\.${table} enable row level security`)
        );
    }

    assert.match(migration, /unique \(analysis_run_id, batch_number\)/);
    assert.match(migration, /primary key \(analysis_item_id, batch_id\)/);
    assert.match(migration, /'generated_from'/);
    assert.match(migration, /'contributed_to'/);
    assert.match(migration, /'synthesized_from'/);
    assert.match(migration, /'coded_phrase'/);
    assert.match(migration, /'legacy_reconstructed'/);
    assert.match(migration, /create_ai_analysis_item_with_batch/);
    assert.match(migration, /security invoker/);
    assert.match(
        migration,
        /grant execute on function public\.create_ai_analysis_item_with_batch/
    );
    assert.doesNotMatch(
        migration,
        /grant[^;]*(anon|authenticated)|grant[^;]*delete/i
    );
});

test("researcher interface exposes clickable batch, session, message, and transcript paths", async () => {
    const [dashboard, analysisScript, messageApi, analysisApi] = await Promise.all([
        readFile(new URL("../researcher.html", import.meta.url), "utf8"),
        readFile(new URL("../researcher-analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../api/messages.js", import.meta.url), "utf8"),
        readFile(new URL("../api/analysis.js", import.meta.url), "utf8")
    ]);

    assert.match(dashboard, /id="provenanceDialog"/);
    assert.match(analysisScript, /Batch \$\{batch\.batchNumber\} of \$\{batch\.totalBatches\}/);
    assert.match(analysisScript, /supporting sessions/);
    assert.match(analysisScript, /supporting messages/);
    assert.match(analysisScript, /Open this message in the complete transcript/);
    assert.match(analysisScript, /Suggestion-specific sources/);
    assert.match(messageApi, /id: item\.id/);
    assert.match(dashboard, /targetTranscriptMessage/);
    assert.match(analysisApi, /create_ai_analysis_item_with_batch/);
    assert.match(analysisApi, /relationship_type: "contributed_to"/);
    assert.match(analysisApi, /async function saveFeedback/);
    assert.match(analysisApi, /async function confirmItem/);
    assert.match(analysisApi, /async function archiveItem/);
    assert.match(analysisApi, /async function reopenItem/);
});
