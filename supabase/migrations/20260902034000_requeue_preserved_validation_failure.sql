-- A historical validator failure is a system state, not participant
-- ineligibility. Reprocess the already-preserved completed provider response
-- under the no-validator Stage 1 path without buying another model call.
update public.advanced_preliminary_analysis_jobs as job
set status = 'pending',
    lease_expires_at = null,
    next_retry_at = now(),
    updated_at = now()
where job.status = 'failed'
  and job.provider_response_id is not null
  and job.provider_response_status = 'completed'
  and job.last_error ~* '(validat|rejected|meaning unit|code|category|theme|evidence|source span|duplicate|overlap)'
  and not exists (
      select 1
      from public.advanced_preliminary_case_reports as report
      where report.job_id = job.id
  );

select public.refresh_advanced_preliminary_analysis_run(run.id)
from public.advanced_preliminary_analysis_runs as run
where run.status in ('queued', 'processing');
