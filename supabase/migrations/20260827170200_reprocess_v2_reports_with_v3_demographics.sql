create or replace function public.supersede_active_case_report_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    update public.qualitative_case_reports
    set
        superseded_at = now(),
        superseded_reason =
            'Atomically replaced by ' || new.analysis_version
            || ' after transcript-evidenced demographic extraction.'
    where session_id = new.session_id
      and superseded_at is null;

    return new;
end;
$function$;

revoke all on function public.supersede_active_case_report_before_insert()
from public, anon, authenticated;

drop trigger if exists qualitative_case_reports_supersede_active
on public.qualitative_case_reports;

create trigger qualitative_case_reports_supersede_active
before insert on public.qualitative_case_reports
for each row
execute function public.supersede_active_case_report_before_insert();

update public.automatic_case_analysis_jobs as job
set
    analysis_version = 'case-analysis-v3-evidence-backed-demographics',
    status = 'pending',
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = null,
    last_error = null,
    updated_at = now()
where job.archived_at is null
  and exists (
      select 1
      from public.qualitative_case_reports as report
      where report.session_id = job.session_id
        and report.superseded_at is null
        and report.analysis_version =
            'case-analysis-v2-no-conversational-courtesies'
  );
