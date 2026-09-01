alter table public.advanced_preliminary_analysis_runs
    drop constraint if exists advanced_preliminary_analysis_runs_stop_layer_check;

alter table public.advanced_preliminary_analysis_runs
    add constraint advanced_preliminary_analysis_runs_stop_layer_check
    check (stop_layer in (
        'meaning_units', 'preliminary_categories',
        'preliminary_tentative_themes'
    ));

alter table public.advanced_preliminary_case_reports
    add column if not exists unassigned_category_numbers jsonb
    not null default '[]'::jsonb;

alter table public.advanced_preliminary_categories
    drop constraint if exists advanced_preliminary_categories_code_count_check;

alter table public.advanced_preliminary_categories
    add constraint advanced_preliminary_categories_code_count_check
    check (code_count >= 1);

alter table public.advanced_preliminary_category_codes
    drop constraint if exists advanced_preliminary_category_codes_report_id_code_id_key;

create table if not exists public.advanced_preliminary_themes (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.advanced_preliminary_case_reports(id) on delete restrict,
    theme_number integer not null check (theme_number > 0),
    theme_label text not null check (btrim(theme_label) <> ''),
    rationale text not null check (btrim(rationale) <> ''),
    category_count integer not null check (category_count >= 1),
    created_at timestamptz not null default now(),
    unique (report_id, theme_number)
);

create table if not exists public.advanced_preliminary_theme_categories (
    report_id uuid not null
        references public.advanced_preliminary_case_reports(id) on delete restrict,
    theme_id uuid not null
        references public.advanced_preliminary_themes(id) on delete restrict,
    category_id uuid not null
        references public.advanced_preliminary_categories(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (theme_id, category_id)
);

create index if not exists advanced_preliminary_theme_category_report_idx
on public.advanced_preliminary_theme_categories(report_id);

alter table public.advanced_preliminary_themes enable row level security;
alter table public.advanced_preliminary_theme_categories enable row level security;

revoke all on table
    public.advanced_preliminary_themes,
    public.advanced_preliminary_theme_categories
from public, anon, authenticated;

grant select on table
    public.advanced_preliminary_themes,
    public.advanced_preliminary_theme_categories
to service_role;

comment on table public.advanced_preliminary_case_reports is
    'Independent complete preliminary case analyses generated in one model call from preserved source transcripts without prior-model analysis input or AI audit.';

comment on table public.advanced_preliminary_themes is
    'Case-specific preliminary tentative themes. They are not cross-case final themes.';

comment on table public.advanced_preliminary_theme_categories is
    'Many-to-many traceability from case-specific tentative themes to preliminary categories.';

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
        raise exception 'A preliminary case-analysis run is already active.';
    end if;

    select * into selected_project
    from public.research_projects
    where id = p_project_id;
    if selected_project.id is null then
        raise exception 'The selected research project does not exist.';
    end if;
    if selected_project.project_code <> 'SLEEPING-HABITS'
       or lower(btrim(selected_project.research_topic)) <> 'sleeping habits' then
        raise exception 'Preliminary case analysis is currently limited to the Sleeping habits project and topic.';
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
        'transcript_only_no_prior_analysis', 'preliminary_tentative_themes',
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
        new_run_id, session.session_id, session.participant_id,
        job.case_number, session.completed_at, design.project_id,
        job.analysis_framework_id, null, 'project_bound'
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

create or replace function public.complete_advanced_preliminary_analysis(
    p_job_id uuid,
    p_participant_code text,
    p_language text,
    p_input_token_count integer,
    p_output_token_count integer,
    p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    new_report_id uuid;
    item jsonb;
    item_number integer;
    new_code_id uuid;
    new_category_id uuid;
    new_theme_id uuid;
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id for update;
    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The preliminary case-analysis job is not processing.';
    end if;
    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = selected_job.run_id;

    insert into public.advanced_preliminary_case_reports (
        run_id, job_id, session_id, case_number, participant_id,
        participant_code, language, project_id, analysis_framework_id,
        source_report_id, provider, model, resolved_model, reasoning_effort,
        analysis_version, prompt_version, case_summary,
        unassigned_code_numbers, unassigned_category_numbers,
        analytical_audit, input_token_count, output_token_count
    ) values (
        selected_job.run_id, selected_job.id, selected_job.session_id,
        selected_job.case_number, selected_job.participant_id,
        nullif(btrim(p_participant_code), ''), nullif(btrim(p_language), ''),
        selected_job.project_id, selected_job.analysis_framework_id,
        selected_job.source_report_id, selected_run.provider,
        selected_run.model, selected_run.resolved_model,
        selected_run.reasoning_effort, selected_run.analysis_version,
        selected_run.prompt_version, p_payload->>'caseSummary',
        coalesce(p_payload->'unassignedCodeNumbers', '[]'::jsonb),
        coalesce(p_payload->'unassignedCategoryNumbers', '[]'::jsonb),
        coalesce(p_payload->'audit', '{}'::jsonb),
        p_input_token_count, p_output_token_count
    ) returning id into new_report_id;

    for item, item_number in
        select value, ordinality::integer
        from jsonb_array_elements(p_payload->'meaningUnits') with ordinality
    loop
        insert into public.advanced_preliminary_meaning_units (
            report_id, unit_number, message_id, exact_source_text,
            source_language, start_offset, end_offset, occurrence_index,
            context_note
        ) values (
            new_report_id, item_number, (item->>'messageId')::uuid,
            item->>'exactSourceText', item->>'sourceLanguage',
            (item->>'startOffset')::integer, (item->>'endOffset')::integer,
            (item->>'occurrenceIndex')::integer, item->>'contextNote'
        );
    end loop;

    for item, item_number in
        select value, ordinality::integer
        from jsonb_array_elements(p_payload->'codes') with ordinality
    loop
        insert into public.advanced_preliminary_codes (
            report_id, code_number, code_label, definition, rationale,
            meaning_unit_count, occurrence_count
        ) values (
            new_report_id, item_number, item->>'label', item->>'definition',
            item->>'rationale', jsonb_array_length(item->'meaningUnitNumbers'),
            jsonb_array_length(item->'meaningUnitNumbers')
        ) returning id into new_code_id;
        insert into public.advanced_preliminary_code_meaning_units (
            report_id, code_id, meaning_unit_id
        )
        select new_report_id, new_code_id, meaning_unit.id
        from jsonb_array_elements_text(item->'meaningUnitNumbers') as number(value)
        join public.advanced_preliminary_meaning_units as meaning_unit
          on meaning_unit.report_id = new_report_id
         and meaning_unit.unit_number = number.value::integer;
    end loop;

    for item, item_number in
        select value, ordinality::integer
        from jsonb_array_elements(p_payload->'categories') with ordinality
    loop
        insert into public.advanced_preliminary_categories (
            report_id, category_number, category_label, definition,
            rationale, code_count
        ) values (
            new_report_id, item_number, item->>'label', item->>'definition',
            item->>'rationale', jsonb_array_length(item->'codeNumbers')
        ) returning id into new_category_id;
        insert into public.advanced_preliminary_category_codes (
            report_id, category_id, code_id
        )
        select new_report_id, new_category_id, code.id
        from jsonb_array_elements_text(item->'codeNumbers') as number(value)
        join public.advanced_preliminary_codes as code
          on code.report_id = new_report_id
         and code.code_number = number.value::integer;
    end loop;

    for item, item_number in
        select value, ordinality::integer
        from jsonb_array_elements(p_payload->'tentativeThemes') with ordinality
    loop
        insert into public.advanced_preliminary_themes (
            report_id, theme_number, theme_label, rationale, category_count
        ) values (
            new_report_id, item_number, item->>'label', item->>'rationale',
            jsonb_array_length(item->'categoryNumbers')
        ) returning id into new_theme_id;
        insert into public.advanced_preliminary_theme_categories (
            report_id, theme_id, category_id
        )
        select new_report_id, new_theme_id, category.id
        from jsonb_array_elements_text(item->'categoryNumbers') as number(value)
        join public.advanced_preliminary_categories as category
          on category.report_id = new_report_id
         and category.category_number = number.value::integer;
    end loop;

    update public.advanced_preliminary_analysis_jobs
    set status = 'completed', completed_at = now(), lease_expires_at = null,
        next_retry_at = null, last_error = null, updated_at = now()
    where id = selected_job.id;
    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
    return new_report_id;
end;
$$;

revoke all on function public.create_stage1_meaning_unit_run(
    uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_stage1_meaning_unit_run(
    uuid, text, text, text, text, text, text, text
) to service_role;

revoke all on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) to service_role;
