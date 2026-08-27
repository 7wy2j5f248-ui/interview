import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateAutomaticCaseAnalysis } from "../server/analysisCore.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260827143920_automatic_case_analysis_pipeline.sql",
    import.meta.url
);

test("automatic case analysis retains exact keyword offsets and local hierarchy", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Weekend work",
            rationale: "Work schedule evidence.",
            keyword_evidence: [{
                message_id: "message-1",
                exact_text: "work on weekends"
            }]
        }],
        themes: [{
            label: "Work",
            rationale: "The code concerns work.",
            code_numbers: [1]
        }],
        case_interpretation: "Weekend work affects this case."
    }, [{
        id: "message-1",
        originalText: "I often work on weekends and sleep later.",
        englishText: "I often work on weekends and sleep later."
    }]);

    assert.equal(result.complete, true);
    assert.deepEqual(result.codes[0].highlights[0], {
        messageId: "message-1",
        exactText: "work on weekends",
        startOffset: 8,
        endOffset: 24
    });
    assert.deepEqual(result.themes[0].codeNumbers, [1]);
});

test("automatic case analysis rejects paraphrased evidence and unassigned codes", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Weekend work",
            rationale: "Work schedule evidence.",
            keyword_evidence: [{
                message_id: "message-1",
                exact_text: "unpaid overtime"
            }]
        }],
        themes: [],
        case_interpretation: "Work affects sleep."
    }, [{
        id: "message-1",
        originalText: "I work on weekends.",
        englishText: "I work on weekends."
    }]);

    assert.equal(result.complete, false);
    assert.equal(result.codes.length, 0);
    assert.ok(result.invalidEvidence > 0);
});

test("invalid extra evidence is omitted without discarding an otherwise exact case", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Weekend work",
            rationale: "Work schedule evidence.",
            keyword_evidence: [
                { message_id: "message-1", exact_text: "work on weekends" },
                { message_id: "message-1", exact_text: "unpaid overtime" }
            ]
        }],
        themes: [{
            label: "Work",
            rationale: "The code concerns work.",
            code_numbers: [1]
        }],
        case_interpretation: "Weekend work affects this case."
    }, [{
        id: "message-1",
        originalText: "I often work on weekends.",
        englishText: "I often work on weekends."
    }]);

    assert.equal(result.complete, true);
    assert.equal(result.invalidEvidence, 1);
    assert.equal(result.codes[0].highlights.length, 1);
});

test("formal completion enqueues a strict FIFO atomic case pipeline", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

    assert.match(migration, /interview_sessions_enqueue_case_analysis/);
    assert.match(migration, /source_completed_at[\s\S]*queued_at[\s\S]*session_id/);
    assert.match(migration, /automatic_case_analysis_fifo/);
    assert.match(migration, /complete_automatic_case_analysis/);
    assert.match(migration, /for update/);
    assert.match(migration, /enable row level security/);
    assert.match(chat, /if \(finalQuestionAnswered\)[\s\S]*scheduleAutomaticCaseAnalysis\(req\)/);
});

test("researcher dashboard uses cases, positional codes, and positional themes", async () => {
    const html = await readFile(new URL("../researcher.html", import.meta.url), "utf8");
    const script = await readFile(
        new URL("../researcher-automatic-analysis.js", import.meta.url),
        "utf8"
    );

    assert.match(html, /1 · Cases &amp; keywords/);
    assert.match(html, /2 · Codes/);
    assert.match(html, /3 · Themes/);
    assert.match(html, /Download current form/);
    assert.match(script, /Array\.from\(\{ length: maximum \}[^\n]*`\$\{prefix\}\$\{index \+ 1\}`/);
    assert.match(script, /Participant ID:/);
    assert.match(script, /start_offset/);
});
