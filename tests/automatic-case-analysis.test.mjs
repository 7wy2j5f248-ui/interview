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
const archiveMigrationUrl = new URL(
    "../supabase/migrations/20260827155638_add_case_archive_and_queue_wakeup.sql",
    import.meta.url
);
const demographicMigrationUrl = new URL(
    "../supabase/migrations/20260827164457_activate_v3_demographics_for_unfinished_cases.sql",
    import.meta.url
);
const historicalReprocessingMigrationUrl = new URL(
    "../supabase/migrations/20260827170200_reprocess_v2_reports_with_v3_demographics.sql",
    import.meta.url
);
const independentDemographicMigrationUrl = new URL(
    "../supabase/migrations/20260827171500_save_case_demographics_independently.sql",
    import.meta.url
);
const atomicReplacementGrantMigrationUrl = new URL(
    "../supabase/migrations/20260827171800_grant_atomic_report_supersede.sql",
    import.meta.url
);
const automaticTranslationMigrationUrl = new URL(
    "../supabase/migrations/20260827183500_backfill_completed_transcript_translations.sql",
    import.meta.url
);
const englishDemographicMigrationUrl = new URL(
    "../supabase/migrations/20260827190000_prefer_new_english_demographics.sql",
    import.meta.url
);
const independentTranslationQueueMigrationUrl = new URL(
    "../supabase/migrations/20260827182114_add_independent_transcript_translation_queue.sql",
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

test("automatic demographics retain only exact participant evidence and provenance", () => {
    const result = validateAutomaticCaseAnalysis({
        demographics: {
            current_country: {
                value: "Canada",
                message_id: "message-1",
                exact_text: "live in Canada",
                basis: "stated"
            },
            age: {
                value: 34,
                message_id: "message-1",
                exact_text: "I am 34",
                basis: "stated"
            },
            birth_year: {
                value: 1992,
                message_id: "message-1",
                exact_text: "born in 1991",
                basis: "stated"
            },
            occupation: {
                value: "Nurse",
                message_id: "message-1",
                exact_text: "work as a nurse",
                basis: "stated"
            }
        },
        codes: [{
            label: "Work schedule",
            rationale: "Shift work affects sleep.",
            keyword_evidence: [{
                message_id: "message-1",
                exact_text: "night shifts"
            }]
        }],
        themes: [{
            label: "Work",
            rationale: "The code concerns work.",
            code_numbers: [1]
        }],
        case_interpretation: "Night shifts affect sleep."
    }, [{
        id: "message-1",
        originalText: "I am 34, live in Canada, work as a nurse, and do night shifts. I was born in 1991.",
        englishText: "I am 34, live in Canada, work as a nurse, and do night shifts. I was born in 1991."
    }]);

    assert.equal(result.complete, true);
    assert.deepEqual(result.demographics, {
        current_country: "Canada",
        age: 34,
        additional_descriptors: { occupation: "Nurse" }
    });
    assert.equal(result.invalidDemographicEvidence, 1);
    assert.equal(
        result.descriptorSources.age.source_message_id,
        "message-1"
    );
    assert.equal(result.descriptorSources.age.raw_answer, "I am 34");
    assert.equal(result.descriptorSources.age.basis, "stated");
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
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(html, /1 · Cases &amp; keywords/);
    assert.match(html, /2 · Codes/);
    assert.match(html, /3 · Themes/);
    assert.match(html, /data-automatic-analysis-view="archive"/);
    assert.match(html, /Download current form/);
    assert.match(html, /automaticCaseReportDialog/);
    assert.match(html, /automaticCaseArchiveButton/);
    assert.match(script, /Array\.from\(\{ length: maximum \}[^\n]*`\$\{prefix\}\$\{index \+ 1\}`/);
    assert.match(script, /Participant ID:/);
    assert.match(script, /start_offset/);
    assert.match(script, /FORM_ONE_DEMOGRAPHIC_COLUMNS/);
    assert.match(
        script,
        /\["current_country", "Country of residence"\][\s\S]*\["country_of_origin", "Country of origin"\][\s\S]*\["gender", "Gender"\][\s\S]*\["age", "Age"\][\s\S]*\["occupation", "Occupation"\][\s\S]*\["education_level", "Education"\]/
    );
    assert.match(script, /\["current_region", "Region of residence"\]/);
    assert.match(script, /\["diaspora_status", "Diaspora status"\]/);
    assert.match(script, /\["birth_year", "Year of birth"\]/);
    assert.match(script, /\["birth_cohort", "Birth cohort"\]/);
    assert.match(script, /\["youth_status", "Youth status"\]/);
    assert.match(script, /\["social_identity", "Social identity"\]/);
    assert.match(
        script,
        /"Participant code",\s*"Session number",\s*"Link to transcript",\s*"Language",\s*\.\.\.FORM_ONE_DEMOGRAPHIC_COLUMNS/
    );
    assert.match(script, /transcriptUrl\(item\)/);
    assert.match(script, /URLSearchParams\(window\.location\.search\)\.get\("case"\)/);
    assert.match(script, /openRequestedTranscript\(\)/);
    assert.match(script, /Open case report/);
    assert.match(script, /function archiveCaseButton/);
    assert.match(script, /button\.textContent = caseRecord\.hasReport[\s\S]*?"Archive"/);
    assert.match(script, /setArchiveState\(caseRecord, true\)/);
    assert.match(script, /renderArchive/);
    assert.match(script, /Restore to active analysis/);
    assert.match(script, /action: shouldArchive \? "archive" : "restore"/);
    assert.match(script, /function casesForCaseAndKeywordForm/);
    assert.match(script, /leftCompleted \? -1 : 1/);
    assert.match(script, /participantCode\(left\)\.localeCompare/);
    assert.match(script, /function sessionNumber/);
    assert.match(script, /"Participant code", "Session number"/);
    assert.match(script, /permanent participant-code order/);
    assert.match(script, /caseRecord\.hasReport/);
    assert.match(dashboard, /hasReport: Boolean\(report\)/);
    assert.doesNotMatch(script, /"Demographic data",\s*"Case report"/);
});

test("researcher archive is durable, auditable, and excluded from future claims", async () => {
    const migration = await readFile(archiveMigrationUrl, "utf8");
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const api = await readFile(
        new URL("../api/automatic-analysis.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /add column archived_at timestamptz/);
    assert.match(migration, /automatic_case_analysis_archive_events/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /set_automatic_case_archive/);
    assert.match(
        migration,
        /claim_next_automatic_case_analysis[\s\S]*job\.archived_at is null/
    );
    assert.match(migration, /pli-automatic-case-analysis-wakeup/);
    assert.match(migration, /\* \* \* \* \*/);
    assert.match(migration, /https:\/\/intervu\.quest\/api\/loadDesign/);
    assert.match(dashboard, /scope === "archived"/);
    assert.match(dashboard, /set_automatic_case_archive/);
    assert.match(api, /\["archive", "restore"\]/);
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

test("v3 saves evidenced demographics atomically without replacing completed reports", async () => {
    const migration = await readFile(demographicMigrationUrl, "utf8");
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const core = await readFile(
        new URL("../server/analysisCore.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /participant_descriptors as descriptor/);
    assert.match(migration, /descriptorSources/);
    assert.match(migration, /descriptor_sources/);
    assert.match(migration, /stored_demographics/);
    assert.match(migration, /case-analysis-v3-evidence-backed-demographics/);
    assert.match(migration, /where archived_at is null\s+and status <> 'completed'/);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/);
    assert.match(migration, /from public, anon, authenticated/);
    assert.match(worker, /demographics: analysis\.demographics/);
    assert.match(worker, /descriptorSources: analysis\.descriptorSources/);
    assert.match(core, /source_message_id/);
    assert.match(core, /extraction_method: AUTOMATIC_CASE_ANALYSIS_VERSION/);
});

test("historical v2 reports remain active until an atomic v3 replacement succeeds", async () => {
    const migration = await readFile(
        historicalReprocessingMigrationUrl,
        "utf8"
    );

    assert.match(migration, /before insert on public\.qualitative_case_reports/);
    assert.match(migration, /superseded_at = now\(\)/);
    assert.match(migration, /new\.analysis_version/);
    assert.match(migration, /security invoker/);
    assert.match(migration, /from public, anon, authenticated/);
    assert.match(migration, /status = 'pending'/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.match(
        migration,
        /report\.analysis_version =\s*'case-analysis-v2-no-conversational-courtesies'/
    );
    assert.doesNotMatch(migration, /delete from public\.qualitative_case_reports/);
});

test("evidenced demographics survive an invalid replacement hierarchy", async () => {
    const migration = await readFile(
        independentDemographicMigrationUrl,
        "utf8"
    );
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /save_automatic_case_demographics/);
    assert.match(migration, /job\.status <> 'processing'/);
    assert.match(migration, /participant_descriptors as descriptor/);
    assert.match(migration, /descriptor_sources/);
    assert.match(migration, /to service_role/);
    assert.match(worker, /save_automatic_case_demographics/);
    assert.match(worker, /if \(!analysis\.complete/);
    assert.ok(
        worker.indexOf("save_automatic_case_demographics")
        < worker.indexOf("if (!analysis.complete")
    );
    assert.match(dashboard, /function mergedDemographics/);
    assert.match(dashboard, /demographics: mergedDemographics/);
});

test("atomic replacement grants only its two lineage columns", async () => {
    const migration = await readFile(
        atomicReplacementGrantMigrationUrl,
        "utf8"
    );

    assert.match(
        migration,
        /grant update \(superseded_at, superseded_reason\)/
    );
    assert.match(migration, /on public\.qualitative_case_reports/);
    assert.match(migration, /to service_role/);
    assert.doesNotMatch(migration, /grant update on/);
    assert.doesNotMatch(migration, /to anon|to authenticated/);
});

test("new automatic reports use English while preserving original keyword evidence", async () => {
    const core = await readFile(
        new URL("../server/analysisCore.js", import.meta.url),
        "utf8"
    );

    assert.match(core, /entire analytical report must be written in English/);
    assert.match(core, /exact_text keyword evidence remains verbatim/);
});

test("formal completion automatically translates before case analysis", async () => {
    const migration = await readFile(automaticTranslationMigrationUrl, "utf8");
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const chat = await readFile(
        new URL("../api/chat.js", import.meta.url),
        "utf8"
    );
    const translation = await readFile(
        new URL("../server/messageTranslation.js", import.meta.url),
        "utf8"
    );

    assert.match(worker, /ensureEnglishTranslations/);
    assert.match(worker, /failOnError: true/);
    assert.ok(
        worker.indexOf("await ensureEnglishTranslations")
        < worker.indexOf("const analysis = await generateAutomaticCaseAnalysis")
    );
    assert.match(migration, /job\.archived_at is null/);
    assert.match(migration, /session\.completed = true/);
    assert.match(migration, /message\."Language"/);
    assert.match(migration, /message\."EnglishTranslation"/);
    assert.doesNotMatch(migration, /qualitative_case_reports/);
    assert.match(chat, /scheduleCompletedTranscriptTranslation/);
    assert.ok(
        chat.indexOf("scheduleCompletedTranscriptTranslation")
        < chat.indexOf("scheduleAutomaticCaseAnalysis(req)")
    );
    assert.match(translation, /\/api\/automatic-analysis/);
    assert.match(translation, /worker: "translation"/);
    assert.match(translation, /waitUntil\(fetch\(url/);
    assert.match(translation, /RESEARCHER_DASHBOARD_TOKEN/);
});

test("historical translations run from a durable queue independent of analysis", async () => {
    const migration = await readFile(
        independentTranslationQueueMigrationUrl,
        "utf8"
    );
    const worker = await readFile(
        new URL("../server/transcriptTranslationQueue.js", import.meta.url),
        "utf8"
    );
    const endpoint = await readFile(
        new URL("../api/automatic-analysis.js", import.meta.url),
        "utf8"
    );
    const loadDesign = await readFile(
        new URL("../api/loadDesign.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /automatic_transcript_translation_jobs/);
    assert.match(migration, /claim_next_transcript_translation/);
    assert.match(migration, /claim_transcript_translation_session/);
    assert.match(migration, /finish_transcript_translation/);
    assert.match(migration, /session\.completed = true/);
    assert.match(migration, /analysis_job\.archived_at is null/);
    assert.match(migration, /enable row level security/);
    assert.match(worker, /TRANSLATION_CHUNK_SIZE = 12/);
    assert.match(worker, /ensureEnglishTranslations/);
    assert.match(endpoint, /translation_independent_from_case_analysis/);
    assert.match(endpoint, /req\.body\?\.worker === "translation"/);
    assert.match(loadDesign, /scheduleTranscriptTranslationBackfill/);
});

test("new English demographics replace old display values without losing provenance", async () => {
    const migration = await readFile(englishDemographicMigrationUrl, "utf8");

    assert.match(
        migration,
        /current_country = coalesce\(\s*excluded\.current_country,\s*descriptor\.current_country/
    );
    assert.match(
        migration,
        /additional_descriptors =\s*descriptor\.additional_descriptors\s*\|\| excluded\.additional_descriptors/
    );
    assert.match(
        migration,
        /descriptor_sources =\s*descriptor\.descriptor_sources\s*\|\| excluded\.descriptor_sources/
    );
    assert.match(migration, /job\.archived_at is null/);
    assert.match(migration, /job\.status = 'completed'/);
    assert.match(migration, /lower\(coalesce\(session\.language, ''\)\) <> 'en'/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.match(migration, /report\.demographics::text/);
    assert.doesNotMatch(migration, /delete from public\.qualitative_case_reports/);
});

test("automatic dashboard exposes every transcript independently of analysis completion", async () => {
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const script = await readFile(
        new URL("../researcher-automatic-analysis.js", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /session_id, participant_id, language/);
    assert.match(dashboard, /loadParticipantCodeMap/);
    assert.match(dashboard, /transcriptIdentity/);
    assert.doesNotMatch(dashboard, /\.select\([^)]*TranslationState/);
    assert.doesNotMatch(dashboard, /\.from\("interview_messages"\)/);
    assert.match(script, /button\.disabled = !caseRecord\.transcriptIdentity\?\.sessionId/);
    assert.match(script, /\/api\/messages\?session=/);
    assert.match(script, /Verified match/);
});

test("Cases and keywords loads every case and every stored highlight", async () => {
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const script = await readFile(
        new URL("../researcher-automatic-analysis.js", import.meta.url),
        "utf8"
    );
    const html = await readFile(
        new URL("../researcher.html", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /async function requireAllData/);
    assert.match(dashboard, /DATABASE_PAGE_SIZE = 1000/);
    assert.match(
        dashboard,
        /current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors/
    );
    assert.match(
        dashboard,
        /qualitative_case_keyword_highlights[\s\S]*\.order\("report_id"[\s\S]*\.order\("keyword_number"/
    );
    assert.match(script, /async function fetchDashboardPage/);
    assert.match(script, /const remainingPages = await Promise\.all/);
    assert.match(script, /casesWithMarkedKeywords/);
    assert.match(script, /reports currently have marked keywords/);
    assert.match(html, /researcher-automatic-analysis\.js\?version=20260827-direct-archive-v6/);
    assert.match(html, /automaticAnalysisGateStatus/);
    assert.match(script, /cache: "no-store"/);
    assert.match(script, /searchParams\.set\("fresh"/);
    assert.match(script, /unlockButton\.disabled = true/);
    assert.match(dashboard, /private, no-store, no-cache/);
    assert.match(dashboard, /generatedAt: new Date\(\)\.toISOString\(\)/);
});

test("researcher analysis assets cannot be held on a stale cached version", async () => {
    const config = JSON.parse(await readFile(
        new URL("../vercel.json", import.meta.url),
        "utf8"
    ));
    const bySource = new Map(config.headers.map(rule => [rule.source, rule.headers]));

    ["/researcher.html", "/researcher-automatic-analysis.js"].forEach(source => {
        const cacheHeader = bySource.get(source)?.find(
            header => header.key.toLowerCase() === "cache-control"
        );
        assert.match(cacheHeader?.value || "", /no-store/);
    });
});
