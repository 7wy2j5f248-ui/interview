import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    AUTOMATIC_CASE_ANALYSIS_VERSION,
    AUTOMATIC_CASE_REANALYSIS_VERSION,
    QUALITATIVE_ANALYSIS_VERSION
} from "../server/analysisCore.js";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("invalid analysis reset has new versions that cannot claim old jobs", () => {
    assert.equal(
        AUTOMATIC_CASE_ANALYSIS_VERSION,
        "case-analysis-v6-overlapping-hierarchy"
    );
    assert.equal(
        AUTOMATIC_CASE_REANALYSIS_VERSION,
        "case-reanalysis-v6-overlapping-hierarchy-proposed"
    );
    assert.equal(
        QUALITATIVE_ANALYSIS_VERSION,
        "task-014-v8-invalid-analysis-reset"
    );
});

test("reset permanently deletes derived output but never source interviews", async () => {
    const migration = await source(
        "supabase/migrations/20260901022929_discard_invalid_analysis_outputs.sql"
    );

    assert.match(migration, /invalid_analysis_deletion_events/);
    assert.match(migration, /No deleted report text, labels, evidence, IDs, prompts, or model output are retained/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /grant select on table public\.invalid_analysis_deletion_events to service_role/);

    assert.match(migration, /truncate table\s+public\.advanced_preliminary_analysis_runs,/);
    assert.match(migration, /public\.qualitative_analysis_runs,/);
    assert.match(migration, /public\.qualitative_case_reports,/);
    assert.match(migration, /public\.analysis_framework_reanalysis_batches,/);
    assert.match(migration, /public\.automatic_analysis_review_messages,/);
    assert.match(migration, /public\.automatic_case_analysis_archive_events/);
    assert.match(migration, /cross_case_code_refinement_runs/);
    assert.match(migration, /restart identity cascade/);

    assert.doesNotMatch(migration, /truncate table\s+public\.interview_sessions/i);
    assert.doesNotMatch(migration, /truncate table\s+public\.interview_messages/i);
    assert.doesNotMatch(migration, /delete from public\.interview_sessions/i);
    assert.doesNotMatch(migration, /delete from public\.interview_messages/i);
    assert.match(migration, /count\(\*\) into source_session_count\s+from public\.interview_sessions/);
    assert.match(migration, /count\(\*\) into source_message_count\s+from public\.interview_messages/);
    assert.match(migration, /"EnglishTranslation"/);
    assert.match(migration, /transcripts_preserved/);
    assert.match(migration, /translations_preserved/);
});

test("reset removes only AI-derived descriptors and queues clean analysis", async () => {
    const migration = await source(
        "supabase/migrations/20260901022929_discard_invalid_analysis_outputs.sql"
    );

    assert.match(migration, /\^case-\(analysis\|reanalysis\)-/);
    assert.match(migration, /descriptor\.descriptor_sources/);
    assert.match(migration, /additional_descriptors = \(/);
    assert.match(migration, /descriptor_sources = \(/);
    assert.doesNotMatch(migration, /truncate table\s+public\.participant_descriptors/i);
    assert.doesNotMatch(migration, /delete from public\.participant_descriptors/i);

    assert.match(migration, /analysis_version = 'case-analysis-v6-overlapping-hierarchy'/);
    assert.match(migration, /status = 'pending'/);
    assert.match(migration, /attempt_count = 0/);
    assert.match(migration, /archived_at = null/);
    assert.match(migration, /last_error = null/);
});

test("new advanced runs cannot retain discarded report links", async () => {
    const migration = await source(
        "supabase/migrations/20260901022929_discard_invalid_analysis_outputs.sql"
    );
    const dashboard = await source("server/advancedPreliminaryDashboard.js");
    const researcherUi = await source("researcher-advanced-preliminary.js");

    assert.match(migration, /'transcript_only_no_prior_analysis'/);
    assert.match(migration, /source_report_id, project_binding_status[\s\S]*?null,/);
    assert.doesNotMatch(
        migration,
        /from public\.qualitative_case_reports as candidate/
    );
    assert.doesNotMatch(dashboard, /\.from\("qualitative_case_reports"\)/);
    assert.doesNotMatch(researcherUi, /preserves every existing report/);
    assert.doesNotMatch(researcherUi, /preserved comparison/);
    assert.match(researcherUi, /transcripts and stored translations only/);
});
