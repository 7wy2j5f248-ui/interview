import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/20260904132041_add_case_bound_analysis_v2.sql", import.meta.url);

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
