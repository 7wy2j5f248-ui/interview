import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    isConversationalCourtesy,
    validateAutomaticCaseAnalysis
} from "../server/analysisCore.js";

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

test("greetings and conversational courtesies are never retained as keywords", () => {
    assert.equal(isConversationalCourtesy("Hello!"), true);
    assert.equal(isConversationalCourtesy("谢谢"), true);
    assert.equal(isConversationalCourtesy("مرحبا"), true);
    assert.equal(isConversationalCourtesy("work on weekends"), false);

    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Greeting",
            rationale: "Routine conversation.",
            keyword_evidence: [{
                message_id: "message-1",
                exact_text: "Hello"
            }]
        }],
        themes: [{
            label: "Conversation",
            rationale: "Routine conversation.",
            code_numbers: [1]
        }],
        case_interpretation: "A greeting occurred."
    }, [{
        id: "message-1",
        originalText: "Hello!",
        englishText: "Hello!"
    }]);

    assert.equal(result.complete, false);
    assert.equal(result.codes.length, 0);
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
    assert.match(html, /automaticCaseReportDialog/);
    assert.match(script, /Array\.from\(\{ length: maximum \}[^\n]*`\$\{prefix\}\$\{index \+ 1\}`/);
    assert.match(script, /Participant ID:/);
    assert.match(script, /start_offset/);
    assert.match(script, /FORM_ONE_DEMOGRAPHIC_COLUMNS/);
    assert.match(
        script,
        /\["current_country", "Country of residence"\][\s\S]*\["country_of_origin", "Country of origin"\][\s\S]*\["gender", "Gender"\][\s\S]*\["age", "Age"\][\s\S]*\["occupation", "Occupation"\][\s\S]*\["education_level", "Education"\]/
    );
    assert.match(
        script,
        /"Participant code",\s*"Link to transcript",\s*"Language",\s*\.\.\.FORM_ONE_DEMOGRAPHIC_COLUMNS/
    );
    assert.match(script, /transcriptUrl\(item\)/);
    assert.match(script, /URLSearchParams\(window\.location\.search\)\.get\("case"\)/);
    assert.match(script, /openRequestedTranscript\(\)/);
    assert.match(script, /Open case report/);
    assert.doesNotMatch(script, /"Demographic data",\s*"Case report"/);
});

test("v2 preserves superseded reports and restarts the FIFO queue", async () => {
    const migration = await readFile(
        new URL(
            "../supabase/migrations/20260827152027_refine_automatic_case_analysis_v2.sql",
            import.meta.url
        ),
        "utf8"
    );

    assert.match(migration, /superseded_at/);
    assert.match(migration, /where superseded_at is null/);
    assert.match(migration, /case-analysis-v2-no-conversational-courtesies/);
    assert.match(migration, /status = 'pending'/);
});

test("automatic dashboard selects only stored transcript columns", async () => {
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /EnglishTranslation, Timestamp/);
    assert.doesNotMatch(dashboard, /\.select\([^)]*TranslationState/);
});
