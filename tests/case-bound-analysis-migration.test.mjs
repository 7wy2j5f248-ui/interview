import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/20260904132041_add_case_bound_analysis_v2.sql", import.meta.url);
const noParticipantNumberMigrationUrl = new URL(
    "../supabase/migrations/20260904140646_remove_participant_number_from_stage2_v2.sql",
    import.meta.url
);
const pilotImportMigrationUrl = new URL(
    "../supabase/migrations/20260904141107_import_stage1_pilot_fixtures_v2.sql",
    import.meta.url
);
const sourceLineageIndexMigrationUrl = new URL(
    "../supabase/migrations/20260904141251_index_stage2_source_lineage_case.sql",
    import.meta.url
);
const dashboardUrl = new URL("../server/caseBoundAnalysisDashboard.js", import.meta.url);
const researcherScriptUrl = new URL("../researcher-case-bound-analysis.js", import.meta.url);

test("migration isolates immutable Stage 1 request, source, response, and presentation", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (const table of [
        "analysis_cases_v2", "stage1_source_snapshots_v2", "stage1_attempts_v2",
        "stage1_requests_v2", "stage1_presentations_v2"
    ]) assert.match(sql, new RegExp(`create table public\\.${table}`));
    assert.match(sql, /stage1_source_snapshots_v2_immutable/);
    assert.match(sql, /stage1_requests_v2_immutable/);
    assert.match(sql, /stage1_attempts_v2_terminal_immutable/);
    assert.match(sql, /A completed Stage 1 case is permanently closed/);
    assert.match(sql, /provider_response_json jsonb/);
    assert.doesNotMatch(sql, /insert into public\.analysis_cases_v2[\s\S]{0,120}select[\s\S]{0,120}interview_sessions/i);
});

test("migration has automatic case freeze but no retry claim", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    assert.match(sql, /interview_sessions_freeze_analysis_case_v2/);
    assert.match(sql, /try_freeze_analysis_case_v2\(new\.session_id\)/);
    assert.match(sql, /attempt\.status = 'pending'/);
    assert.match(sql, /authorize_stage1_v2_new_attempt/);
    assert.doesNotMatch(sql, /attempt_count/);
    assert.doesNotMatch(sql, /max_attempts/);
});

test("closed cohorts block on unresolved cases and queue one whole-cohort Stage 2A", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    assert.match(sql, /Closed cohort membership is immutable/);
    assert.match(sql, /complete_count <> member_count/);
    assert.match(sql, /unique references public\.analysis_cohorts_v2/);
    assert.match(sql, /'case_id', analysis_case\.case_number/);
    assert.match(sql, /'preliminary_codes'/);
    assert.match(sql, /set status = 'stage2_queued'/);
});

test("corrective Stage 2 migration keeps P# outside the model corpus", async () => {
    const sql = await readFile(noParticipantNumberMigrationUrl, "utf8");
    assert.match(sql, /create table public\.stage2_source_code_lineage_v2/);
    assert.match(sql, /'source_ref', 'PC' \|\| lpad\(source_number::text, 6, '0'\)/);
    assert.match(sql, /'preliminary_codes', corpus_codes/);
    assert.doesNotMatch(sql, /'case_id', analysis_case\.case_number/);
    assert.match(sql, /stage2_source_code_lineage_v2_immutable/);
    assert.match(sql, /revoke all on table public\.stage2_source_code_lineage_v2 from public, anon, authenticated/);
});

test("pilot import assumes outputs without inheriting the historical process", async () => {
    const sql = await readFile(pilotImportMigrationUrl, "utf8");
    assert.match(sql, /researcher_pilot_assumption/);
    assert.match(sql, /prior_process_inherited boolean not null default false/);
    assert.match(sql, /analytical_quality_accepted boolean not null default false/);
    assert.match(sql, /Stage 1 was not rerun/);
    assert.match(sql, /P0171 explicit preliminary Codes did not resolve to 46/);
    assert.match(sql, /P0175 explicit preliminary Codes did not resolve to 50/);
    assert.match(sql, /expected exactly 10,211 preliminary Code fixtures/);
    assert.doesNotMatch(sql, /insert into public\.stage2_runs_v2/);
    assert.doesNotMatch(sql, /responses\.create|OPENAI_API_KEY/);
});

test("Stage 2 private lineage has a covering case index", async () => {
    const sql = await readFile(sourceLineageIndexMigrationUrl, "utf8");
    assert.match(sql, /stage2_source_code_lineage_v2_case_idx/);
    assert.match(sql, /stage2_source_code_lineage_v2\(case_id\)/);
});

test("researcher resolution is separate from immutable provider status", async () => {
    const [dashboard, researcherScript] = await Promise.all([
        readFile(dashboardUrl, "utf8"),
        readFile(researcherScriptUrl, "utf8")
    ]);
    assert.match(dashboard, /historical_provider_status_preserved:\s*true/);
    assert.match(dashboard, /stage2_readiness/);
    assert.match(dashboard, /researcherResolution/);
    assert.match(researcherScript, /researcher-resolved for Stage 2 pilot/);
    assert.doesNotMatch(dashboard, /provider_status:\s*["']completed["']/);
});

test("researcher can inspect the exact frozen Stage 2A request and provider record", async () => {
    const [dashboard, researcherScript, html] = await Promise.all([
        readFile(dashboardUrl, "utf8"),
        readFile(researcherScriptUrl, "utf8"),
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8")
    ]);
    assert.match(dashboard, /stage2_requests_v2/);
    assert.match(dashboard, /stage2_presentations_v2/);
    assert.match(dashboard, /frozenRequest:\s*requests\[0\]/);
    assert.match(researcherScript, /Inspect frozen Stage 2A record/);
    assert.match(researcherScript, /runId=/);
    assert.match(html, /P# is not sent to the model/);
    assert.doesNotMatch(html, /receives only P# \+ preliminary CO/);
});

test("all new analysis tables are RLS-enabled and browser roles receive no grants", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const enabled = [...sql.matchAll(/alter table public\.([a-z0-9_]+) enable row level security/g)]
        .map(match => match[1]);
    assert.equal(enabled.length, 13);
    assert.match(sql, /from public, anon, authenticated/);
    assert.match(sql, /to service_role/);
});

test("the v2 researcher UI never starts an automatic status monitor", async () => {
    const [html, javascript] = await Promise.all([
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8"),
        readFile(new URL("../researcher-case-bound-analysis.js", import.meta.url), "utf8")
    ]);
    assert.match(html, /dashboard does not monitor or poll/);
    assert.doesNotMatch(javascript, /setInterval|refreshTimer/);
    assert.match(javascript, /confirmedConfigurationSha256/);
});
