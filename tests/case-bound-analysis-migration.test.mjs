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
const parallelStage2MigrationUrl = new URL(
    "../supabase/migrations/20260904162000_add_parallel_stage2_harmonization.sql",
    import.meta.url
);
const reconstructedContractMigrationUrl = new URL(
    "../supabase/migrations/20260912120000_reconstruct_case_bound_analysis_contract.sql",
    import.meta.url
);
const requiredReportMigrationUrls = [
    "../supabase/migrations/20260913120000_create_analysis_report_store.sql",
    "../supabase/migrations/20260913120500_create_gpt56_report_backfill.sql",
    "../supabase/migrations/20260913121000_backfill_gpt56_reports_001_050.sql",
    "../supabase/migrations/20260913121100_backfill_gpt56_reports_051_100.sql",
    "../supabase/migrations/20260913121150_optimize_gpt56_report_backfill.sql",
    "../supabase/migrations/20260913121175_bound_raw_gpt56_report_backfill.sql",
    "../supabase/migrations/20260913121200_backfill_gpt56_reports_101_125.sql",
    "../supabase/migrations/20260913121250_backfill_gpt56_reports_126_150.sql",
    "../supabase/migrations/20260913121300_backfill_gpt56_reports_151_175.sql",
    "../supabase/migrations/20260913121350_backfill_gpt56_reports_176_200.sql",
    "../supabase/migrations/20260913121400_backfill_gpt56_reports_201_225.sql",
    "../supabase/migrations/20260913121450_backfill_gpt56_reports_226_250.sql",
    "../supabase/migrations/20260913121500_backfill_gpt56_reports_251_275.sql",
    "../supabase/migrations/20260913121550_backfill_gpt56_reports_276_300.sql",
    "../supabase/migrations/20260913121600_backfill_gpt56_reports_301_350.sql",
    "../supabase/migrations/20260913121650_backfill_gpt56_reports_351_400.sql",
    "../supabase/migrations/20260913121700_backfill_gpt56_reports_401_450.sql",
    "../supabase/migrations/20260913121750_backfill_gpt56_reports_701_750.sql",
    "../supabase/migrations/20260913121800_backfill_gpt56_reports_751_775.sql",
    "../supabase/migrations/20260913121850_backfill_gpt56_reports_776_800.sql",
    "../supabase/migrations/20260913121900_backfill_gpt56_reports_801_850.sql",
    "../supabase/migrations/20260913121950_verify_gpt56_report_backfill.sql",
    "../supabase/migrations/20260913122000_require_report_to_finalize_analysis.sql",
    "../supabase/migrations/20260913123000_require_future_stage1_participant_information.sql"
].map(path => new URL(path, import.meta.url));
const dashboardUrl = new URL("../server/caseBoundAnalysisDashboard.js", import.meta.url);
const researcherScriptUrl = new URL("../researcher-case-bound-analysis.js", import.meta.url);
const pilotParticipantWorksheetMigrationUrl = new URL(
    "../supabase/migrations/20260913141434_import_gpt51_pilot_participant_worksheet.sql",
    import.meta.url
);
const pilotParticipantWorksheetRestrictionMigrationUrl = new URL(
    "../supabase/migrations/20260913143000_restrict_pilot_participant_worksheet.sql",
    import.meta.url
);
const correctedPilotDemographicsMigrationUrl = new URL(
    "../supabase/migrations/20260913161812_correct_gpt51_pilot_demographics.sql",
    import.meta.url
);
const correctedPilotDemographicsRestrictionMigrationUrl = new URL(
    "../supabase/migrations/20260913162458_restrict_corrected_gpt51_pilot_demographics.sql",
    import.meta.url
);

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

test("pilot participant worksheet import is isolated from GPT-5.1 analysis", async () => {
    const [sql, restriction] = await Promise.all([
        readFile(pilotParticipantWorksheetMigrationUrl, "utf8"),
        readFile(pilotParticipantWorksheetRestrictionMigrationUrl, "utf8")
    ]);
    assert.match(sql, /participant_information_only/);
    assert.match(sql, /analytical_content_imported boolean not null default false/);
    assert.match(sql, /prior_analytical_process_inherited boolean not null default false/);
    assert.match(sql, /analytical_content_imported = false/);
    assert.match(sql, /prior_analytical_process_inherited = false/);
    assert.match(sql, /source_sheet_name/);
    assert.match(sql, /1 Participant & case/);
    assert.match(sql, /private worksheet rows are imported directly/);
    assert.match(sql, /intentionally never committed to Git/);
    assert.doesNotMatch(sql, /insert into public\.pilot_stage1_participant_information_v2/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /from public, anon, authenticated/);
    assert.match(restriction, /revoke all[\s\S]*from service_role/);
    assert.match(restriction, /grant select[\s\S]*to service_role/);
    assert.doesNotMatch(sql, /meaning_units|preliminary_codes|preliminary_categories|preliminary_themes/);
});

test("corrected pilot demographics come only from A:O of the actual GPT-5.1 report", async () => {
    const [sql, restriction, workbookCode] = await Promise.all([
        readFile(correctedPilotDemographicsMigrationUrl, "utf8"),
        readFile(correctedPilotDemographicsRestrictionMigrationUrl, "utf8"),
        readFile(new URL("../server/caseBoundStage1Workbook.js", import.meta.url), "utf8")
    ]);
    assert.match(sql, /pilot_stage1_participant_information_v3/);
    assert.match(sql, /source_range text not null default 'A:O'/);
    assert.match(sql, /source_row_present boolean not null/);
    assert.match(sql, /three absent cases/);
    assert.match(sql, /No historical analytical content is stored or inherited/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /from public, anon, authenticated/);
    assert.match(sql, /grant select, insert[\s\S]*to service_role/);
    assert.match(restriction, /revoke all[\s\S]*from service_role/);
    assert.match(restriction, /grant select[\s\S]*to service_role/);
    assert.doesNotMatch(sql, /meaning_units|preliminary_codes|preliminary_categories|preliminary_themes/);
    assert.match(workbookCode, /from\("pilot_stage1_participant_information_v3"\)/);
    assert.doesNotMatch(workbookCode, /pilot-gpt51-participant-sheet\.xlsx/);
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

test("researcher can inspect every exact frozen Stage 2 request and provider record", async () => {
    const [dashboard, researcherScript, html] = await Promise.all([
        readFile(dashboardUrl, "utf8"),
        readFile(researcherScriptUrl, "utf8"),
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8")
    ]);
    assert.match(dashboard, /stage2_requests_v2/);
    assert.match(dashboard, /stage2_presentations_v2/);
    assert.match(dashboard, /frozenRequest:\s*requests\[0\]/);
    assert.match(researcherScript, /showStage2Report\(record\)/);
    assert.match(researcherScript, /View.*Stage.*report/);
    assert.match(researcherScript, /runId=/);
    assert.match(html, /CO → HCO, CA → HCA, and TH → HTH/);
    assert.match(html, /P# is not sent to the model/);
    assert.doesNotMatch(html, /receives only P# \+ preliminary CO/);
});

test("every completed analysis stage requires a stored readable report", async () => {
    const [migrationParts, dashboard, researcherScript, html] = await Promise.all([
        Promise.all(requiredReportMigrationUrls.map(url => readFile(url, "utf8"))),
        readFile(dashboardUrl, "utf8"),
        readFile(researcherScriptUrl, "utf8"),
        readFile(new URL("../case-bound-analysis.html", import.meta.url), "utf8")
    ]);
    const sql = migrationParts.join("\n");
    assert.match(sql, /create table public\.stage1_readable_reports_v2/);
    assert.match(sql, /Stage 1 cannot complete before its readable report is submitted/);
    assert.match(sql, /A Stage 2 operation cannot complete before its report is submitted/);
    assert.match(sql, /stage1_readable_report_complete_v2/);
    assert.match(sql, /stage2_readable_report_complete_v2/);
    assert.match(sql, /stage1_participant_information_complete_v2/);
    assert.match(sql, /Future provider-completed Stage 1 reports include transcript-supported participant information/);
    assert.match(sql, /frozen_gpt56_response_projection/);
    assert.match(sql, /source_report\.raw_model_output_text = attempt\.raw_model_output_text/);
    assert.match(sql, /source_report\.reasoning_effort = 'high'/);
    assert.match(sql, /configuration\.model = 'gpt-5\.6-sol'/);
    assert.match(sql, /P00171 and P00175/);
    assert.doesNotMatch(sql, /GPT-5\.1 production output is not a source[\s\S]{0,80}select.*GPT-5\.1/);
    assert.match(dashboard, /stage1_readable_reports_v2/);
    assert.match(researcherScript, /Download one complete Stage 1 workbook/);
    assert.match(researcherScript, /View supporting annotated transcript/);
    assert.match(researcherScript, /No GPT-5\.1 analytical content/);
    assert.doesNotMatch(html, /id="v2RecordText"/);
    assert.match(html, /id="v2RecordContent"/);
    assert.match(html, /Researcher viewing is optional/);
});

test("parallel Stage 2 migration freezes isolated CA and TH corpora with private lineage", async () => {
    const sql = await readFile(parallelStage2MigrationUrl, "utf8");
    assert.match(sql, /analysis_layer in \('2a', '2b', '2c'\)/);
    assert.match(sql, /PCA.*PTH/);
    assert.match(sql, /expected exactly 1,927 preliminary CA fixtures/);
    assert.match(sql, /expected exactly 970 preliminary TH fixtures/);
    assert.match(sql, /stage2_source_item_lineage_v2_immutable/);
    assert.match(sql, /claim_next_parallel_stage2_v2_run/);
    assert.match(sql, /unique \(cohort_id, analysis_layer\)/);
    assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]{0,200}'case_id'/);
});

test("completed Stage 1 is closed and Stage 2 attempts are one concurrent set", async () => {
    const [sql, dashboard, researcherScript] = await Promise.all([
        readFile(reconstructedContractMigrationUrl, "utf8"),
        readFile(dashboardUrl, "utf8"),
        readFile(researcherScriptUrl, "utf8")
    ]);
    assert.match(sql, /where id = p_case_id and stage1_status = 'unresolved'/);
    assert.match(sql, /analysis_case\.stage1_status <> 'completed'/);
    assert.match(sql, /create function public\.create_stage1_v2_attempt/);
    assert.match(sql, /create function public\.create_stage2_v2_attempt_set/);
    assert.match(sql, /execution_set_id/);
    assert.match(sql, /source_run\.analysis_layer/);
    assert.match(sql, /max_output_tokens, corpus_snapshot_json[\s\S]*null,/);
    assert.match(dashboard, /run_unresolved_stage1/);
    assert.match(dashboard, /run_stage2_set/);
    assert.doesNotMatch(dashboard, /run_stage1_again|run_stage2_again/);
    assert.match(researcherScript, /item\.stage1_status === "unresolved"/);
    assert.match(researcherScript, /Run 2A, 2B, and 2C concurrently/);
    assert.doesNotMatch(researcherScript, /Run Stage 1 again from this frozen source/);
});

test("reconstructed migration builds all three future corpora without P#", async () => {
    const sql = await readFile(reconstructedContractMigrationUrl, "utf8");
    assert.match(sql, /'preliminary_codes', corpus_codes/);
    assert.match(sql, /'preliminary_categories', corpus_categories/);
    assert.match(sql, /'preliminary_themes', corpus_themes/);
    assert.match(sql, /'PC' \|\| lpad/);
    assert.match(sql, /'PCA' \|\| lpad/);
    assert.match(sql, /'PTH' \|\| lpad/);
    assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]{0,100}'case_id', analysis_case\.case_number/);
    assert.match(sql, /stage2_runs_v2_no_application_ceiling/);
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
    assert.match(html, /stage1-workbook-v12/);
    assert.match(html, /The Stage 1 report is one six-sheet Excel workbook containing every case/);
    assert.match(html, /Participant Information is never combined with Meaning Units/);
    assert.match(html, /first worksheet uses demographic columns A:O from the actual saved GPT-5\.1 complete-case report/);
    assert.match(html, /No GPT-5\.1 Meaning Unit, Code, Category, Theme, case report, calculation, or analytical process is included/);
    assert.doesNotMatch(javascript, /setInterval|refreshTimer/);
    assert.match(javascript, /confirmedConfigurationSha256/);
    assert.match(javascript, /Full transcript with inline MU highlights/);
    assert.match(javascript, /inline-mu-annotation/);
    assert.match(javascript, /English analytical text/);
    assert.match(javascript, /MU mention reconciliation/);
    assert.match(javascript, /MU mention \$\{mappedPosition\} of \$\{reportTotal\}/);
    assert.match(javascript, /Inline MU markers/);
    assert.match(javascript, /Workbook content preview · MU → CO → CA → TH/);
    assert.match(javascript, /stage1AnalyticalReport/);
    assert.match(javascript, /Meaning Units without a Code link/);
    assert.match(javascript, /The report-facing language is English/);
    assert.match(javascript, /stored translation of this MU's source message/);
    assert.match(javascript, /Exact original-language GPT-5.6 MU evidence/);
    assert.match(javascript, /download=stage1-report-xlsx/);
    assert.match(javascript, /The Excel workbook is the Stage 1 report/);
});
