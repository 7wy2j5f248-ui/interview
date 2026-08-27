alter table public.qualitative_case_reports
add column superseded_at timestamptz,
add column superseded_reason text;

comment on column public.qualitative_case_reports.superseded_at is
    'When present, this derived AI report is retained for lineage but is no longer the active researcher-facing report.';

alter table public.qualitative_case_reports
drop constraint qualitative_case_reports_session_id_key,
drop constraint qualitative_case_reports_case_number_key;

create unique index qualitative_case_reports_active_session_idx
on public.qualitative_case_reports(session_id)
where superseded_at is null;

create unique index qualitative_case_reports_active_case_idx
on public.qualitative_case_reports(case_number)
where superseded_at is null;

update public.qualitative_case_reports
set
    superseded_at = now(),
    superseded_reason =
        'Replaced by v2: separate demographic columns and exclusion of conversational courtesies from keyword evidence.'
where superseded_at is null;

alter table public.automatic_case_analysis_jobs
alter column analysis_version
set default 'case-analysis-v2-no-conversational-courtesies';

update public.automatic_case_analysis_jobs
set
    analysis_version = 'case-analysis-v2-no-conversational-courtesies',
    status = 'pending',
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = null,
    last_error = null,
    updated_at = now();
