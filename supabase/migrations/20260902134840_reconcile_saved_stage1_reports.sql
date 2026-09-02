-- A saved report is authoritative evidence that Stage 1 completed. Repair
-- stale job-state failures without changing any transcript or report content.
with repaired as (
    update public.advanced_preliminary_analysis_jobs as job
    set provider_response_history = coalesce(job.provider_response_history, '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                'event', 'saved_report_job_status_reconciled',
                'previousStatus', job.status,
                'previousError', job.last_error,
                'reason', 'A duplicate or delayed worker marked the job failed after its report had already been saved.',
                'reconciledAt', now()
            )),
        status = 'completed',
        completed_at = report.completed_at,
        lease_expires_at = null,
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    from public.advanced_preliminary_case_reports as report
    where report.job_id = job.id
      and report.run_id = job.run_id
      and job.status <> 'completed'
      and job.run_id = (
          select run.id
          from public.advanced_preliminary_analysis_runs as run
          where run.operation_type = 'fresh_independent_analysis'
            and run.authoritative_source = 'original_completed_transcripts'
            and run.legacy_analysis_input = 'excluded'
            and run.model = 'gpt-5.6-sol'
          order by run.requested_at desc
          limit 1
      )
    returning job.run_id
)
select public.refresh_advanced_preliminary_analysis_run(run_id)
from repaired
group by run_id;
