alter table public.advanced_preliminary_analysis_runs
    drop constraint if exists advanced_preliminary_analysis_runs_stop_layer_check;

alter table public.advanced_preliminary_analysis_runs
    add constraint advanced_preliminary_analysis_runs_stop_layer_check
    check (stop_layer in ('meaning_units', 'preliminary_categories'));

alter table public.advanced_preliminary_analysis_runs
    drop constraint if exists advanced_preliminary_analysis_runs_source_scope_check;

alter table public.advanced_preliminary_analysis_runs
    add constraint advanced_preliminary_analysis_runs_source_scope_check
    check (source_scope in (
        'all_formally_completed_transcripts',
        'single_project_formally_completed_transcripts'
    ));

comment on table public.advanced_preliminary_analysis_runs is
    'Versioned staged qualitative-analysis runs generated from preserved transcripts. The stop_layer records the only analytical layer a run may generate.';

comment on table public.advanced_preliminary_case_reports is
    'Versioned staged case proposals. Stage 1 reports contain exact Meaning Units only and never replace or promote prior reports.';

create or replace function public.create_stage1_meaning_unit_run(
    p_project_id uuid,
    p_provider text,
    p_model text,
    p_resolved_model text,
    p_reasoning_effort text,
    p_analysis_version text,
    p_prompt_version text,
    p_requested_by text default 'researcher'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_run_id uuid;
    selected_project public.research_projects%rowtype;
    eligible_count integer;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_run'));

    if exists (
        select 1 from public.advanced_preliminary_analysis_runs
        where status in ('queued', 'processing')
    ) then
        raise exception 'A staged analysis run is already active.';
    end if;

    select * into selected_project
    from public.research_projects
    where id = p_project_id;

    if selected_project.id is null then
        raise exception 'The selected research project does not exist.';
    end if;

    if selected_project.project_code <> 'SLEEPING-HABITS'
       or lower(btrim(selected_project.research_topic)) <> 'sleeping habits' then
        raise exception 'Stage 1 is currently limited to the Sleeping habits project and topic.';
    end if;

    if btrim(coalesce(p_provider, '')) = ''
       or btrim(coalesce(p_model, '')) = ''
       or btrim(coalesce(p_resolved_model, '')) = ''
       or btrim(coalesce(p_analysis_version, '')) = ''
       or btrim(coalesce(p_prompt_version, '')) = '' then
        raise exception 'Model and version provenance are required.';
    end if;

    insert into public.advanced_preliminary_analysis_runs (
        source_scope, provider, model, resolved_model, reasoning_effort,
        analysis_version, prompt_version, prior_analysis_role, stop_layer,
        requested_by, model_verified_at, project_snapshot
    ) values (
        'single_project_formally_completed_transcripts',
        btrim(p_provider), btrim(p_model), btrim(p_resolved_model),
        p_reasoning_effort, btrim(p_analysis_version), btrim(p_prompt_version),
        'transcript_only_no_prior_analysis', 'meaning_units',
        coalesce(nullif(btrim(p_requested_by), ''), 'researcher'), now(),
        jsonb_build_array(jsonb_build_object(
            'project_id', selected_project.id,
            'project_code', selected_project.project_code,
            'project_name', selected_project.project_name,
            'research_topic', selected_project.research_topic
        ))
    ) returning id into new_run_id;

    insert into public.advanced_preliminary_analysis_jobs (
        run_id, session_id, participant_id, case_number,
        source_completed_at, project_id, analysis_framework_id,
        source_report_id, project_binding_status
    )
    select
        new_run_id,
        session.session_id,
        session.participant_id,
        job.case_number,
        session.completed_at,
        design.project_id,
        job.analysis_framework_id,
        null,
        'project_bound'
    from public.interview_sessions as session
    join public.research_designs as design
      on design.id = session.research_design_id
     and design.project_id = selected_project.id
    join public.automatic_case_analysis_jobs as job
      on job.session_id = session.session_id
    where session.completed = true
      and session.completed_at is not null
    order by session.completed_at, session.session_id;

    select count(*)::integer into eligible_count
    from public.advanced_preliminary_analysis_jobs
    where run_id = new_run_id;

    if eligible_count = 0 then
        raise exception 'The selected project has no formally completed transcripts.';
    end if;

    update public.advanced_preliminary_analysis_runs
    set source_case_count = eligible_count,
        pending_count = eligible_count,
        updated_at = now()
    where id = new_run_id;

    return new_run_id;
end;
$$;

revoke all on function public.create_stage1_meaning_unit_run(
    uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.create_stage1_meaning_unit_run(
    uuid, text, text, text, text, text, text, text
) to service_role;
