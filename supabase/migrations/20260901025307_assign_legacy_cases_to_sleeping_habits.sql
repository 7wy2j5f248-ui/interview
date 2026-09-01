alter table public.invalid_analysis_deletion_events
add column if not exists researcher_assigned_legacy_job_count integer
    not null default 0
    check (researcher_assigned_legacy_job_count >= 0);

comment on column public.invalid_analysis_deletion_events.researcher_assigned_legacy_job_count is
    'Legacy cases assigned after the researcher confirmed they used the same protocol and topic as the project-bound testing interviews.';

do $assign$
declare
    target_project_id uuid;
    target_design_id uuid;
    target_framework_id uuid;
    quarantined_case_count integer;
    assigned_case_count integer;
begin
    select candidate.project_id, candidate.design_id
    into target_project_id, target_design_id
    from (
        select
            project.id as project_id,
            design.id as design_id,
            count(session.session_id) as completed_session_count,
            design.created_at
        from public.research_projects as project
        join public.research_designs as design
          on design.project_id = project.id
        left join public.interview_sessions as session
          on session.research_design_id = design.id
         and session.completed = true
        where project.project_code = 'SLEEPING-HABITS'
        group by project.id, design.id, design.created_at
        order by completed_session_count desc, design.created_at desc
        limit 1
    ) as candidate;

    select active.framework_id
    into target_framework_id
    from public.active_analysis_frameworks as active
    where active.project_id = target_project_id;

    if target_project_id is null
       or target_design_id is null
       or target_framework_id is null then
        raise exception 'Sleeping Habits project, protocol, or active framework is unavailable.';
    end if;

    select count(*) into quarantined_case_count
    from public.automatic_case_analysis_jobs
    where analysis_version = 'case-analysis-quarantined-missing-project';

    if quarantined_case_count <> 6 then
        raise exception 'Expected exactly six researcher-confirmed legacy cases; found %.',
            quarantined_case_count;
    end if;

    update public.interview_sessions as session
    set
        research_design_id = target_design_id,
        updated_at = now()
    where session.research_design_id is null
      and exists (
          select 1
          from public.automatic_case_analysis_jobs as job
          where job.session_id = session.session_id
            and job.analysis_version =
                'case-analysis-quarantined-missing-project'
      );

    update public.automatic_case_analysis_jobs as job
    set
        project_id = target_project_id,
        analysis_framework_id = target_framework_id,
        analysis_version = 'case-analysis-v6-overlapping-hierarchy',
        status = 'pending',
        attempt_count = 0,
        queued_at = now(),
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = null,
        last_error = null,
        updated_at = now()
    where job.analysis_version = 'case-analysis-quarantined-missing-project';

    get diagnostics assigned_case_count = row_count;

    update public.invalid_analysis_deletion_events
    set researcher_assigned_legacy_job_count = assigned_case_count
    where id = (
        select id
        from public.invalid_analysis_deletion_events
        order by created_at desc
        limit 1
    );
end;
$assign$;
