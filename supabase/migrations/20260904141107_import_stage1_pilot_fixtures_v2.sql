-- Researcher-authorized pilot bridge.
--
-- This does not rerun Stage 1 and does not adopt the historical prompt,
-- validation, repair, calculation, or analytical decision process. It treats
-- the stored preliminary Codes as fixtures solely to exercise the new cohort
-- barrier and Stage 2A function. Analytical quality is explicitly not accepted.

alter table public.stage1_attempts_v2
    add column completion_authority text not null default 'provider',
    add column completion_record jsonb;

alter table public.stage1_attempts_v2
    add constraint stage1_attempts_v2_completion_authority_valid check (
        completion_authority in ('provider', 'researcher_pilot_assumption')
    ),
    add constraint stage1_attempts_v2_completion_record_consistent check (
        (completion_authority = 'provider' and completion_record is null)
        or (completion_authority = 'researcher_pilot_assumption'
            and jsonb_typeof(completion_record) = 'object')
    );

create table public.pilot_stage1_assumptions_v2 (
    case_id uuid primary key references public.analysis_cases_v2(id) on delete restrict,
    source_run_id uuid not null,
    source_materialization_run_id uuid not null,
    source_job_id uuid not null,
    source_report_id uuid,
    prior_process_inherited boolean not null default false,
    analytical_quality_accepted boolean not null default false,
    purpose text not null,
    preliminary_code_count integer not null,
    authorized_by text not null default 'researcher',
    authorized_at timestamptz not null default now(),
    constraint pilot_stage1_assumptions_v2_no_process_inheritance
        check (prior_process_inherited = false),
    constraint pilot_stage1_assumptions_v2_no_quality_acceptance
        check (analytical_quality_accepted = false),
    constraint pilot_stage1_assumptions_v2_purpose_not_blank
        check (btrim(purpose) <> ''),
    constraint pilot_stage1_assumptions_v2_code_count_positive
        check (preliminary_code_count > 0)
);

comment on table public.pilot_stage1_assumptions_v2 is
    'Explicit pilot-only assumption: historical outputs are fixtures, not inherited analytical process or accepted analytical quality.';

create trigger pilot_stage1_assumptions_v2_immutable
before update or delete on public.pilot_stage1_assumptions_v2
for each row execute function public.reject_analysis_v2_mutation();

alter table public.pilot_stage1_assumptions_v2 enable row level security;
revoke all on table public.pilot_stage1_assumptions_v2 from public, anon, authenticated;
grant select on table public.pilot_stage1_assumptions_v2 to service_role;

create or replace function private.extract_complete_json_array_v2(
    p_source text,
    p_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    key_position integer;
    array_position integer;
    i integer;
    depth integer := 0;
    in_string boolean := false;
    escaped boolean := false;
    character text;
begin
    key_position := strpos(p_source, '"' || p_key || '"');
    if key_position = 0 then
        raise exception 'Pilot source does not contain %', p_key;
    end if;
    array_position := strpos(substr(p_source, key_position), '[') + key_position - 1;
    if array_position < key_position then
        raise exception 'Pilot source has no array for %', p_key;
    end if;

    for i in array_position..length(p_source) loop
        character := substr(p_source, i, 1);
        if in_string then
            if escaped then
                escaped := false;
            elsif character = E'\\' then
                escaped := true;
            elsif character = '"' then
                in_string := false;
            end if;
        elsif character = '"' then
            in_string := true;
        elsif character = '[' then
            depth := depth + 1;
        elsif character = ']' then
            depth := depth - 1;
            if depth = 0 then
                return substr(p_source, array_position, i - array_position + 1)::jsonb;
            end if;
        end if;
    end loop;
    raise exception 'Pilot source contains an incomplete % array', p_key;
end;
$function$;

create temporary table pilot_stage1_codes_v2 (
    source_job_id uuid not null,
    code_number integer not null,
    code_label text not null,
    source_kind text not null,
    primary key (source_job_id, code_number)
) on commit drop;

insert into pilot_stage1_codes_v2 (
    source_job_id, code_number, code_label, source_kind
)
select code.source_job_id, code.position, code.code_label,
    'stored_stage1_materialization'
from public.stage1_preliminary_codes as code
where code.materialization_run_id = 'db1885f2-2359-4d95-b324-1b41615fadfa'::uuid;

insert into pilot_stage1_codes_v2 (
    source_job_id, code_number, code_label, source_kind
)
select job.id,
    (code.value ->> 'code_number')::integer,
    code.value ->> 'code',
    'manual_recovery_from_explicit_frozen_response'
from public.advanced_preliminary_analysis_jobs as job
cross join lateral jsonb_array_elements(
    private.extract_complete_json_array_v2(
        job.raw_model_output_text,
        'preliminary_codes'
    )
) as code(value)
where job.id in (
    'be166c71-bbe6-4f82-8e3c-20f420e58573'::uuid,
    'b373a377-3171-4a6d-bcee-2621fc259ba1'::uuid
);

do $pilot_import$
declare
    selected_project_id uuid := '32490785-6cd2-433f-8218-f9b4bb42f880'::uuid;
    selected_source_run_id uuid := '9cba2707-bb77-491e-bd10-9518509a6981'::uuid;
    selected_materialization_id uuid := 'db1885f2-2359-4d95-b324-1b41615fadfa'::uuid;
    selected_configuration_id uuid;
    selected_cohort_id uuid;
    selected_configuration jsonb;
    selected_hash text;
    actual_count integer;
begin
    if exists (select 1 from public.analysis_cases_v2)
       or exists (select 1 from public.analysis_cohorts_v2)
       or exists (select 1 from public.stage2_runs_v2) then
        raise exception 'Pilot import requires an empty case-bound v2 workspace';
    end if;

    if (select count(*) from public.stage1_preliminary_case_forms
        where materialization_run_id = selected_materialization_id) <> 275 then
        raise exception 'Pilot import expected exactly 275 Stage 1 case fixtures';
    end if;
    if (select count(*) from pilot_stage1_codes_v2) <> 10211 then
        raise exception 'Pilot import expected exactly 10,211 preliminary Code fixtures';
    end if;
    if (select count(*) from pilot_stage1_codes_v2
        where source_job_id = 'be166c71-bbe6-4f82-8e3c-20f420e58573'::uuid) <> 46 then
        raise exception 'P0171 explicit preliminary Codes did not resolve to 46';
    end if;
    if (select count(*) from pilot_stage1_codes_v2
        where source_job_id = 'b373a377-3171-4a6d-bcee-2621fc259ba1'::uuid) <> 50 then
        raise exception 'P0175 explicit preliminary Codes did not resolve to 50';
    end if;

    selected_configuration := jsonb_build_object(
        'pilotBridge', true,
        'stage1ExecutedByV2', false,
        'priorProcessInherited', false,
        'analyticalQualityAccepted', false,
        'purpose', 'exercise_new_stage1_to_stage2_transition',
        'stage2Input', 'compact_preliminary_codes_only_no_participant_number'
    );
    selected_hash := encode(
        extensions.digest(convert_to(selected_configuration::text, 'UTF8'), 'sha256'),
        'hex'
    );

    insert into public.analysis_project_configurations_v2 (
        project_id, provider, model, reasoning_effort, max_output_tokens,
        contract_version, prompt_version, configuration_json,
        configuration_sha256, created_by
    ) values (
        selected_project_id, 'openai', 'gpt-5.6-sol', 'high', 30000,
        'pli-case-bound-analysis-v1-pilot-bridge',
        'pilot-stage1-not-executed', selected_configuration,
        selected_hash, 'researcher-pilot-authorization'
    ) returning id into selected_configuration_id;

    insert into public.analysis_cases_v2 (
        project_id, configuration_id, participant_id, case_number,
        source_completed_at, stage1_status, frozen_at, completed_at
    )
    select selected_project_id,
        selected_configuration_id,
        form.participant_id,
        'P' || lpad(regexp_replace(form.participant_code, '[^0-9]', '', 'g'), 5, '0'),
        job.source_completed_at,
        'completed', now(), now()
    from public.stage1_preliminary_case_forms as form
    join public.advanced_preliminary_analysis_jobs as job
      on job.id = form.source_job_id
    where form.materialization_run_id = selected_materialization_id
    order by form.participant_code;

    get diagnostics actual_count = row_count;
    if actual_count <> 275 then
        raise exception 'Pilot import created % cases instead of 275', actual_count;
    end if;

    insert into public.analysis_case_sessions_v2 (
        case_id, session_id, session_order
    )
    select analysis_case.id, form.session_id, 1
    from public.analysis_cases_v2 as analysis_case
    join public.stage1_preliminary_case_forms as form
      on form.participant_id = analysis_case.participant_id
     and form.materialization_run_id = selected_materialization_id
    where analysis_case.configuration_id = selected_configuration_id;

    insert into public.stage1_attempts_v2 (
        case_id, attempt_number, status, researcher_reason, claimed_at,
        provider_response_id, provider_status, raw_model_output_text,
        incomplete_details, terminal_at, completion_authority,
        completion_record
    )
    select analysis_case.id, 1, 'completed',
        'Researcher-authorized pilot assumption; Stage 1 was not rerun.',
        now(), job.provider_response_id, job.provider_response_status,
        job.raw_model_output_text,
        jsonb_build_object(
            'historical_provider_status', job.provider_response_status,
            'pilot_override', true
        ),
        now(), 'researcher_pilot_assumption',
        jsonb_build_object(
            'prior_process_inherited', false,
            'analytical_quality_accepted', false,
            'stage1_rerun', false,
            'purpose', 'stage2_function_test'
        )
    from public.analysis_cases_v2 as analysis_case
    join public.stage1_preliminary_case_forms as form
      on form.participant_id = analysis_case.participant_id
     and form.materialization_run_id = selected_materialization_id
    join public.advanced_preliminary_analysis_jobs as job
      on job.id = form.source_job_id
    where analysis_case.configuration_id = selected_configuration_id;

    insert into public.stage1_presentations_v2 (
        attempt_id, presentation_json
    )
    select attempt.id,
        jsonb_build_object(
            'meaning_units', '[]'::jsonb,
            'preliminary_codes', code_set.codes,
            'preliminary_categories', '[]'::jsonb,
            'preliminary_tentative_themes', '[]'::jsonb,
            'pilot_assumption', jsonb_build_object(
                'prior_process_inherited', false,
                'analytical_quality_accepted', false,
                'minimum_fixture_only', 'preliminary_codes'
            )
        )
    from public.stage1_attempts_v2 as attempt
    join public.analysis_cases_v2 as analysis_case on analysis_case.id = attempt.case_id
    join public.stage1_preliminary_case_forms as form
      on form.participant_id = analysis_case.participant_id
     and form.materialization_run_id = selected_materialization_id
    join lateral (
        select jsonb_agg(
            jsonb_build_object(
                'id', 'CO' || lpad(code.code_number::text, 3, '0'),
                'label', code.code_label
            ) order by code.code_number
        ) as codes
        from pilot_stage1_codes_v2 as code
        where code.source_job_id = form.source_job_id
    ) as code_set on true
    where analysis_case.configuration_id = selected_configuration_id;

    insert into public.pilot_stage1_assumptions_v2 (
        case_id, source_run_id, source_materialization_run_id,
        source_job_id, source_report_id, prior_process_inherited,
        analytical_quality_accepted, purpose, preliminary_code_count,
        authorized_by
    )
    select analysis_case.id, selected_source_run_id,
        selected_materialization_id, form.source_job_id,
        report.id, false, false,
        'Treat stored preliminary Codes as fixtures solely to test the new Stage 2 function.',
        (select count(*) from pilot_stage1_codes_v2 code
         where code.source_job_id = form.source_job_id),
        'researcher'
    from public.analysis_cases_v2 as analysis_case
    join public.stage1_preliminary_case_forms as form
      on form.participant_id = analysis_case.participant_id
     and form.materialization_run_id = selected_materialization_id
    left join public.advanced_preliminary_case_reports as report
      on report.job_id = form.source_job_id
    where analysis_case.configuration_id = selected_configuration_id;

    insert into public.analysis_cohorts_v2 (
        project_id, configuration_id, name, created_by
    ) values (
        selected_project_id, selected_configuration_id,
        'Pilot cohort - Stage 1 outputs assumed only for Stage 2 function testing',
        'researcher'
    ) returning id into selected_cohort_id;

    insert into public.analysis_cohort_cases_v2 (cohort_id, case_id)
    select selected_cohort_id, id
    from public.analysis_cases_v2
    where configuration_id = selected_configuration_id
    order by case_number;

    if (select count(*) from public.analysis_cohort_cases_v2
        where cohort_id = selected_cohort_id) <> 275 then
        raise exception 'Pilot cohort membership did not freeze all 275 cases';
    end if;
    if exists (
        select 1
        from public.analysis_cohort_cases_v2 member
        join public.analysis_cases_v2 analysis_case on analysis_case.id = member.case_id
        left join public.stage1_attempts_v2 attempt
          on attempt.case_id = analysis_case.id and attempt.status = 'completed'
        left join public.stage1_presentations_v2 presentation
          on presentation.attempt_id = attempt.id
        where member.cohort_id = selected_cohort_id
          and (analysis_case.stage1_status <> 'completed'
               or presentation.presentation_json is null)
    ) then
        raise exception 'Pilot cohort contains a case that cannot pass the Stage 1 barrier';
    end if;
end;
$pilot_import$;

drop function private.extract_complete_json_array_v2(text, text);
