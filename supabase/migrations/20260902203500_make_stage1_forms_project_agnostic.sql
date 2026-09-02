alter table public.stage1_preliminary_materialization_runs
add column project_id uuid references public.research_projects(id) on delete restrict;

alter table public.stage1_preliminary_case_forms
add column demographics jsonb not null default '{}'::jsonb;

comment on column public.stage1_preliminary_case_forms.demographics is
    'Complete project-specific demographic display object derived dynamically from participant_descriptors, including additional_descriptors. Internal identifiers and provenance fields remain in their dedicated columns.';

create or replace function private.populate_stage1_case_demographics(
    p_materialization_run_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    affected_rows integer;
begin
    update public.stage1_preliminary_case_forms as form
    set demographics = coalesce(
        (
            pg_catalog.to_jsonb(descriptor)
            - 'id'
            - 'session_id'
            - 'participant_id'
            - 'created_at'
            - 'updated_at'
            - 'additional_descriptors'
            - 'descriptor_sources'
        ) || coalesce(descriptor.additional_descriptors, '{}'::jsonb),
        '{}'::jsonb
    )
    from public.participant_descriptors as descriptor
    where form.materialization_run_id = p_materialization_run_id
      and descriptor.session_id = form.session_id;

    get diagnostics affected_rows = row_count;
    return affected_rows;
end;
$$;

alter function private.materialize_stage1_preliminary_forms(uuid)
rename to materialize_stage1_preliminary_forms_without_dynamic_demographics;

create or replace function private.materialize_stage1_preliminary_forms(
    p_source_run_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    materialization_id uuid;
    source_project_id uuid;
    source_project_count integer;
begin
    select count(distinct job.project_id),
        (pg_catalog.array_agg(distinct job.project_id))[1]
    into source_project_count, source_project_id
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = p_source_run_id;

    if source_project_count <> 1 or source_project_id is null then
        raise exception 'A Stage 1 forms run must resolve to exactly one research project.';
    end if;

    materialization_id :=
        private.materialize_stage1_preliminary_forms_without_dynamic_demographics(
            p_source_run_id
        );
    perform private.populate_stage1_case_demographics(materialization_id);

    update public.stage1_preliminary_materialization_runs
    set project_id = source_project_id
    where id = materialization_id;

    return materialization_id;
end;
$$;

create or replace function public.materialize_stage1_preliminary_forms(
    p_source_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    materialization_id uuid;
    result jsonb;
begin
    if not exists (
        select 1
        from public.advanced_preliminary_analysis_runs as source_run
        where source_run.id = p_source_run_id
    ) then
        raise exception 'The requested Stage 1 run does not exist.';
    end if;

    materialization_id := private.materialize_stage1_preliminary_forms(
        p_source_run_id
    );

    select pg_catalog.jsonb_build_object(
        'materialization_run_id', materialized.id,
        'source_run_id', materialized.source_run_id,
        'project_id', materialized.project_id,
        'status', materialized.status,
        'source_case_count', materialized.source_case_count,
        'participant_form_case_count', materialized.participant_form_case_count,
        'meaning_unit_form_case_count', materialized.meaning_unit_form_case_count,
        'code_form_case_count', materialized.code_form_case_count,
        'category_form_case_count', materialized.category_form_case_count,
        'implied_theme_form_case_count', materialized.implied_theme_form_case_count,
        'exception_case_count', materialized.exception_case_count,
        'new_ai_api_call_count', materialized.new_ai_api_call_count,
        'meaning_unit_record_count', (
            select count(*)
            from public.stage1_preliminary_meaning_units as unit
            where unit.materialization_run_id = materialized.id
        ),
        'code_record_count', (
            select count(*)
            from public.stage1_preliminary_codes as code
            where code.materialization_run_id = materialized.id
        ),
        'category_record_count', (
            select count(*)
            from public.stage1_preliminary_categories as category
            where category.materialization_run_id = materialized.id
        ),
        'implied_theme_record_count', (
            select count(*)
            from public.stage1_preliminary_implied_themes as theme
            where theme.materialization_run_id = materialized.id
        ),
        'english_meaning_unit_count', (
            select count(*)
            from public.stage1_preliminary_meaning_units as unit
            where unit.materialization_run_id = materialized.id
              and nullif(pg_catalog.btrim(unit.english_text), '') is not null
        ),
        'completed_at', materialized.completed_at
    )
    into result
    from public.stage1_preliminary_materialization_runs as materialized
    where materialized.id = materialization_id;

    return result;
end;
$$;

create or replace view public.stage1_preliminary_form_1_participant_information
with (security_invoker = true)
as
select participant_code as "P#", session_sequence as "S#", language,
    current_country, current_region, country_of_origin, diaspora_status,
    gender, age, birth_year, birth_cohort, youth_status,
    education_level, social_identity, additional_descriptors,
    source_run_id, source_job_id, source_report_id, session_id, participant_id,
    demographics
from public.stage1_preliminary_case_forms;

revoke all on function private.populate_stage1_case_demographics(uuid) from public;
revoke all on function private.materialize_stage1_preliminary_forms_without_dynamic_demographics(uuid) from public;
revoke all on function private.materialize_stage1_preliminary_forms(uuid) from public;
revoke all on function public.materialize_stage1_preliminary_forms(uuid) from public, anon, authenticated;
grant execute on function private.populate_stage1_case_demographics(uuid) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms_without_dynamic_demographics(uuid) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms(uuid) to service_role;
grant execute on function public.materialize_stage1_preliminary_forms(uuid) to service_role;
revoke all on table public.stage1_preliminary_form_1_participant_information from anon, authenticated;
grant select on table public.stage1_preliminary_form_1_participant_information to service_role;
