update public.automatic_case_analysis_jobs as job
set
    analysis_version = 'case-analysis-quarantined-missing-project',
    status = 'failed',
    attempt_count = greatest(job.attempt_count, 3),
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = null,
    last_error = 'Clean analysis withheld: this legacy transcript has no research project or research-design lineage. A researcher must assign its project before analysis.',
    updated_at = now()
where job.project_id is null
   or job.analysis_framework_id is null;

comment on column public.automatic_case_analysis_jobs.analysis_version is
    'Exact worker/report version. case-analysis-quarantined-missing-project is deliberately unclaimable until a researcher supplies missing project lineage.';
