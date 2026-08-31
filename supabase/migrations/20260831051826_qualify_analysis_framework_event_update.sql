create or replace function public.save_analysis_framework_version(
    p_project_id uuid,
    p_project_name text,
    p_research_topic text,
    p_study_scope text,
    p_theme_requirements text,
    p_code_derivation_rules text,
    p_theme_code_fit_rules text,
    p_inclusion_rules text,
    p_exclusion_rules text,
    p_provenance_expectations text,
    p_application_scope text,
    p_version_notes text default null
)
returns table (
    framework_id uuid,
    project_id uuid,
    version_number integer,
    historical_requests_queued integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    selected_project public.research_projects%rowtype;
    prior_framework_id uuid;
    next_version integer;
    stored_framework_id uuid;
    queued_count integer := 0;
begin
    if btrim(coalesce(p_project_name, '')) = ''
       or btrim(coalesce(p_research_topic, '')) = '' then
        raise exception 'Project name and research topic are required.';
    end if;

    if p_application_scope not in ('future_only', 'include_completed') then
        raise exception 'Choose future analysis only or include completed interviews.';
    end if;

    if p_project_id is null then
        insert into public.research_projects (
            project_code, project_name, research_topic
        ) values (
            'PROJECT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
            btrim(p_project_name),
            btrim(p_research_topic)
        ) returning * into selected_project;
    else
        select * into selected_project
        from public.research_projects
        where id = p_project_id
        for update;

        if not found then
            raise exception 'The selected research project was not found.';
        end if;

        if selected_project.project_name <> btrim(p_project_name)
           or selected_project.research_topic <> btrim(p_research_topic) then
            raise exception 'Project name/topic identity is immutable. Start a new project for a different research topic.';
        end if;
    end if;

    select active.framework_id
    into prior_framework_id
    from public.active_analysis_frameworks as active
    where active.project_id = selected_project.id;

    select coalesce(max(framework.version_number), 0) + 1
    into next_version
    from public.analysis_frameworks as framework
    where framework.project_id = selected_project.id;

    insert into public.analysis_frameworks (
        project_id,
        version_number,
        predecessor_id,
        study_scope,
        theme_requirements,
        code_derivation_rules,
        theme_code_fit_rules,
        inclusion_rules,
        exclusion_rules,
        provenance_expectations,
        application_scope,
        version_notes
    ) values (
        selected_project.id,
        next_version,
        prior_framework_id,
        btrim(p_study_scope),
        btrim(p_theme_requirements),
        btrim(p_code_derivation_rules),
        btrim(p_theme_code_fit_rules),
        btrim(p_inclusion_rules),
        btrim(p_exclusion_rules),
        btrim(p_provenance_expectations),
        p_application_scope,
        nullif(btrim(p_version_notes), '')
    ) returning id into stored_framework_id;

    insert into public.active_analysis_frameworks (
        project_id, framework_id
    ) values (
        selected_project.id, stored_framework_id
    )
    on conflict on constraint active_analysis_frameworks_pkey do update
    set framework_id = excluded.framework_id,
        activated_at = now(),
        activated_by = 'researcher';

    insert into public.analysis_framework_events (
        framework_id, event_type, actor, details
    ) values (
        stored_framework_id,
        'activated',
        'researcher',
        jsonb_build_object(
            'projectId', selected_project.id,
            'projectName', selected_project.project_name,
            'researchTopic', selected_project.research_topic,
            'versionNumber', next_version,
            'predecessorId', prior_framework_id,
            'applicationScope', p_application_scope
        )
    );

    if p_application_scope = 'include_completed' then
        with eligible as (
            select
                report.session_id,
                report.id as source_report_id,
                coalesce(max(existing.request_number), 0) + 1
                    as request_number
            from public.qualitative_case_reports as report
            join public.automatic_case_analysis_jobs as job
              on job.session_id = report.session_id
             and job.status = 'completed'
             and job.archived_at is null
            join public.interview_sessions as session
              on session.session_id = report.session_id
             and session.completed = true
             and session.completed_at is not null
            join public.research_designs as design
              on design.id = session.research_design_id
             and design.project_id = selected_project.id
            left join public.automatic_case_reanalysis_requests as existing
              on existing.session_id = report.session_id
            where report.superseded_at is null
              and not exists (
                  select 1
                  from public.automatic_case_reanalysis_requests as open_request
                  where open_request.session_id = report.session_id
                    and open_request.status in (
                        'queued', 'processing', 'proposal_ready'
                    )
              )
            group by report.session_id, report.id
        ), inserted as (
            insert into public.automatic_case_reanalysis_requests (
                session_id,
                source_report_id,
                request_number,
                reason_code,
                researcher_notes,
                requested_by,
                analysis_version,
                project_id,
                analysis_framework_id
            )
            select
                eligible.session_id,
                eligible.source_report_id,
                eligible.request_number,
                'analysis_framework_changed',
                'Generate a versioned proposal under analysis framework v'
                    || next_version::text || ' for project '
                    || selected_project.project_name
                    || '. Preserve the current report until researcher approval.',
                'analysis_framework_scope',
                'case-reanalysis-v2-framework-governed',
                selected_project.id,
                stored_framework_id
            from eligible
            returning id, source_report_id
        ), events as (
            insert into public.automatic_case_reanalysis_events (
                request_id, event_type, actor, details
            )
            select
                inserted.id,
                'requested',
                'analysis_framework_scope',
                jsonb_build_object(
                    'sourceReportId', inserted.source_report_id,
                    'projectId', selected_project.id,
                    'analysisFrameworkId', stored_framework_id,
                    'analysisFrameworkVersion', next_version,
                    'currentReportPreserved', true,
                    'researcherApprovalRequired', true
                )
            from inserted
        )
        select count(*) into queued_count from inserted;
    end if;

    update public.analysis_framework_events as framework_event
    set details = framework_event.details || jsonb_build_object(
        'historicalRequestsQueued', queued_count
    )
    where framework_event.framework_id = stored_framework_id
      and framework_event.event_type = 'activated';

    return query select
        stored_framework_id,
        selected_project.id,
        next_version,
        queued_count;
end;
$function$;
