alter table public.invalid_analysis_deletion_events
add column if not exists framework_bound_job_count integer not null default 0
    check (framework_bound_job_count >= 0),
add column if not exists quarantined_unbound_job_count integer not null default 0
    check (quarantined_unbound_job_count >= 0);

comment on column public.invalid_analysis_deletion_events.framework_bound_job_count is
    'Case jobs safely bound to the active framework of their already-recorded research project after invalid output deletion.';

comment on column public.invalid_analysis_deletion_events.quarantined_unbound_job_count is
    'Legacy case jobs withheld from analysis because no research project or design lineage exists; no project was inferred.';

do $repair$
declare
    framework_bound_count integer;
    quarantined_unbound_count integer;
begin
    update public.automatic_case_analysis_jobs as job
    set
        analysis_framework_id = active.framework_id,
        status = 'pending',
        attempt_count = 0,
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = null,
        last_error = null,
        updated_at = now()
    from public.active_analysis_frameworks as active
    where active.project_id = job.project_id
      and job.analysis_version = 'case-analysis-v6-overlapping-hierarchy';

    get diagnostics framework_bound_count = row_count;

    update public.automatic_case_analysis_jobs as job
    set
        status = 'failed',
        attempt_count = greatest(job.attempt_count, 3),
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = null,
        last_error = 'Clean analysis withheld: this legacy transcript has no research project or research-design lineage. A researcher must assign its project before analysis.',
        updated_at = now()
    where job.analysis_version = 'case-analysis-v6-overlapping-hierarchy'
      and (
          job.project_id is null
          or job.analysis_framework_id is null
      );

    get diagnostics quarantined_unbound_count = row_count;

    update public.invalid_analysis_deletion_events
    set
        framework_bound_job_count = framework_bound_count,
        quarantined_unbound_job_count = quarantined_unbound_count
    where id = (
        select id
        from public.invalid_analysis_deletion_events
        order by created_at desc
        limit 1
    );
end;
$repair$;
