import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateItemStatistics } from "../server/analysisStatistics.js";
import {
    validateEvidenceRecords,
    validateSuggestedItems
} from "../server/analysisCore.js";

const runId = "10000000-0000-4000-8000-000000000001";
const ids = {
    en1: "00000000-0000-4000-8000-000000000001",
    en2: "00000000-0000-4000-8000-000000000002",
    zh: "00000000-0000-4000-8000-000000000003",
    ar: "00000000-0000-4000-8000-000000000004",
    legacy: "00000000-0000-4000-8000-000000000005"
};

const corpus = [
    {
        id: ids.en1,
        Session: "session-en",
        Participant: "participant-one",
        Language: "en"
    },
    {
        id: ids.en2,
        Session: "session-en",
        Participant: "participant-one",
        Language: "en"
    },
    {
        id: ids.zh,
        Session: "session-zh",
        Participant: "participant-two",
        Language: "zh"
    },
    {
        id: ids.ar,
        Session: "session-ar",
        Participant: "",
        Language: "ar"
    },
    {
        id: ids.legacy,
        Session: "",
        Participant: null,
        Language: "unrecognized-language"
    }
];

const evidence = [
    {
        message_id: ids.en1,
        included: true,
        evidence_round: 0,
        source: "initial_ai",
        code_attributions: ["Support"]
    },
    {
        message_id: ids.en1,
        included: true,
        evidence_round: 1,
        source: "feedback_ai",
        code_attributions: ["Support", "Access"]
    },
    {
        message_id: ids.en2,
        included: true,
        evidence_round: 1,
        source: "feedback_ai",
        code_attributions: ["Access"]
    },
    {
        message_id: ids.zh,
        included: false,
        evidence_round: 0,
        source: "initial_ai",
        code_attributions: ["Support"]
    },
    {
        message_id: ids.ar,
        included: true,
        evidence_round: 0,
        source: "initial_ai",
        code_attributions: ["Support"]
    },
    {
        message_id: ids.legacy,
        included: true,
        evidence_round: 1,
        source: "researcher_manual",
        code_attributions: ["Access"]
    }
];

function calculate(overrides = {}) {
    return calculateItemStatistics({
        analysisRunId: runId,
        workingCodes: ["Support", "Access"],
        evidenceLinks: evidence,
        corpusMessages: corpus,
        calculatedAt: "2026-07-16T12:00:00.000Z",
        ...overrides
    });
}

test("deduplicates evidence and calculates the frozen-session denominator", () => {
    const statistics = calculate();

    assert.equal(statistics.supportingMessageCount, 4);
    assert.equal(statistics.supportingSessionCount, 2);
    assert.equal(statistics.eligibleSessionCount, 3);
    assert.equal(statistics.sessionPrevalencePercentage, 66.7);
    assert.equal(statistics.uniqueParticipantCount, 1);
    assert.equal(statistics.uniqueParticipantCountAvailable, true);
});

test("keeps legacy messages out of session counts and uses stored languages", () => {
    const statistics = calculate();

    assert.deepEqual(
        statistics.languageDistribution,
        [
            { code: "ar", label: "Arabic", messageCount: 1, sessionCount: 1 },
            { code: "en", label: "English", messageCount: 2, sessionCount: 1 },
            {
                code: "__unknown__",
                label: "Unknown / legacy",
                messageCount: 1,
                sessionCount: 0
            }
        ]
    );
    assert.equal(statistics.languageCount, 3);
});

test("calculates English, Simplified Chinese, and RTL-language evidence", () => {
    const statistics = calculate({
        evidenceLinks: [
            {
                message_id: ids.en1,
                included: true,
                evidence_round: 0,
                source: "initial_ai",
                code_attributions: ["Support"]
            },
            {
                message_id: ids.zh,
                included: true,
                evidence_round: 0,
                source: "initial_ai",
                code_attributions: ["Support"]
            },
            {
                message_id: ids.ar,
                included: true,
                evidence_round: 0,
                source: "initial_ai",
                code_attributions: ["Support"]
            }
        ]
    });

    assert.deepEqual(
        statistics.languageDistribution.map(language => language.code),
        ["ar", "en", "zh"]
    );
    assert.equal(statistics.supportingMessageCount, 3);
    assert.equal(statistics.supportingSessionCount, 3);
});

test("counts only explicitly attributed evidence for each working code", () => {
    const statistics = calculate();

    assert.deepEqual(statistics.perCode, [
        { code: "Support", messageCount: 2, sessionCount: 2 },
        { code: "Access", messageCount: 3, sessionCount: 1 }
    ]);
});

test("excluded evidence contributes nothing and missing participants remain unavailable", () => {
    const statistics = calculate({
        evidenceLinks: evidence.map(link => ({
            ...link,
            included: link.message_id === ids.ar
        }))
    });

    assert.equal(statistics.supportingMessageCount, 1);
    assert.equal(statistics.supportingSessionCount, 1);
    assert.equal(statistics.uniqueParticipantCount, null);
    assert.equal(statistics.uniqueParticipantCountAvailable, false);
});

test("confirmed statistics remain stable until an explicit recalculation replaces them", () => {
    const confirmedSnapshot = structuredClone(calculate());
    const changedWorkingStatistics = calculate({
        evidenceLinks: evidence.map(link => ({ ...link, included: true }))
    });

    assert.equal(confirmedSnapshot.supportingMessageCount, 4);
    assert.equal(changedWorkingStatistics.supportingMessageCount, 5);
    assert.equal(confirmedSnapshot.supportingMessageCount, 4);

    const reconfirmedSnapshot = structuredClone(changedWorkingStatistics);
    assert.equal(reconfirmedSnapshot.supportingMessageCount, 5);
    assert.equal(reconfirmedSnapshot.analysisRunId, runId);
});

test("structured AI output retains explicit validated code attribution", () => {
    const available = corpus.map(message => ({
        id: message.id,
        sessionId: message.Session,
        participantId: message.Participant,
        language: message.Language,
        originalText: "participant response"
    }));
    const suggestions = validateSuggestedItems({
        items: [{
            theme: "Community support",
            codes: ["Support", "Access"],
            coded_phrases: [{
                phrase: "participant response",
                message_ids: [ids.en1]
            }],
            keywords: ["community"],
            supporting_message_ids: [ids.en1, ids.zh],
            code_evidence: [
                { code: "Support", message_ids: [ids.en1, ids.zh] },
                { code: "Unknown code", message_ids: [ids.en1] }
            ],
            keyword_evidence: [
                { keyword: "community", message_ids: [ids.en1, ids.zh] }
            ],
            rationale: "Grounded in participant accounts."
        }]
    }, available);

    assert.deepEqual(suggestions.items[0].evidence, [
        { messageId: ids.en1, codes: ["Support"] },
        { messageId: ids.zh, codes: ["Support"] }
    ]);

    const collection = validateEvidenceRecords({
        evidence: [
            { message_id: ids.en1, codes: ["access", "invented"] },
            { message_id: ids.ar, codes: ["Support"] }
        ]
    }, available, ["Support", "Access"]);

    assert.deepEqual(collection.evidence, [
        { messageId: ids.en1, codes: ["Access"] },
        { messageId: ids.ar, codes: ["Support"] }
    ]);
});

test("migration and API preserve the quantitative confirmation snapshot", async () => {
    const [migration, api, dashboard] = await Promise.all([
        readFile(new URL(
            "../supabase/migrations/20260716120000_add_collaborative_qualitative_analysis.sql",
            import.meta.url
        ), "utf8"),
        readFile(new URL("../api/analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../researcher-analysis.js", import.meta.url), "utf8")
    ]);

    assert.match(migration, /code_attributions text\[\] not null/);
    assert.match(migration, /confirmed_statistics jsonb/);
    assert.match(migration, /enable row level security/g);
    assert.doesNotMatch(migration, /grant[^;]*delete/i);
    assert.match(api, /confirmed_statistics: confirmedStatistics/);
    assert.match(api, /descriptiveStatistics: item\.confirmed_statistics/);
    assert.match(dashboard, /Linked-evidence distribution/);
    assert.match(dashboard, /Save code attribution/);
});
