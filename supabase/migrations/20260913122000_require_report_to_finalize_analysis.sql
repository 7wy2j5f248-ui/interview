create or replace function public.record_stage1_v2_provider_response(
    p_attempt_id uuid,
    p_outcome text,
    p_provider_response_id text,
    p_provider_status text,
    p_provider_response_json jsonb,
    p_raw_model_output_text text,
    p_incomplete_details jsonb default null,
    p_technical_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_case_id uuid;
begin
    if p_outcome not in (
        'provider_pending', 'completed', 'technically_incomplete', 'failed'
    ) then
        raise exception 'Invalid objective provider outcome';
    end if;
    select case_id into selected_case_id
    from public.stage1_attempts_v2
    where id = p_attempt_id
      and status in ('processing', 'provider_pending')
    for update;
    if selected_case_id is null then
        raise exception 'Stage 1 attempt is not active';
    end if;
    if p_outcome = 'provider_pending' then
        update public.stage1_attempts_v2
        set status = 'provider_pending',
            provider_response_id = p_provider_response_id,
            provider_status = p_provider_status,
            next_poll_at = now() + interval '15 seconds'
        where id = p_attempt_id;
        update public.analysis_cases_v2
        set stage1_status = 'provider_pending'
        where id = selected_case_id;
        return true;
    end if;
    update public.stage1_attempts_v2
    set status = p_outcome,
        provider_response_id = p_provider_response_id,
        provider_status = p_provider_status,
        provider_response_json = p_provider_response_json,
        raw_model_output_text = p_raw_model_output_text,
        incomplete_details = p_incomplete_details,
        technical_error = p_technical_error,
        next_poll_at = null,
        terminal_at = now()
    where id = p_attempt_id;
    if p_outcome = 'completed' then
        update public.analysis_cases_v2
        set stage1_status = 'report_pending', completed_at = null,
            unresolved_at = null
        where id = selected_case_id;
    else
        update public.analysis_cases_v2
        set stage1_status = 'unresolved', unresolved_at = now(),
            completed_at = null
        where id = selected_case_id;
    end if;
    return true;
end;
$function$;

create or replace function public.save_stage1_v2_presentation(
    p_attempt_id uuid,
    p_presentation_json jsonb,
    p_materialization_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_case_id uuid;
    selected_provider text;
    selected_model text;
    selected_reasoning_effort text;
    complete_report boolean;
    report_hash text;
    response_hash text;
begin
    select attempt.case_id, configuration.provider, configuration.model,
        configuration.reasoning_effort
    into selected_case_id, selected_provider, selected_model,
        selected_reasoning_effort
    from public.stage1_attempts_v2 as attempt
    join public.analysis_cases_v2 as analysis_case
      on analysis_case.id = attempt.case_id
    join public.analysis_project_configurations_v2 as configuration
      on configuration.id = coalesce(
          attempt.configuration_id, analysis_case.configuration_id
      )
    where attempt.id = p_attempt_id and attempt.status = 'completed';
    if selected_case_id is null then
        raise exception 'Only an objectively completed Stage 1 response can be presented';
    end if;
    insert into public.stage1_presentations_v2 (
        attempt_id, presentation_json, materialization_error
    ) values (
        p_attempt_id, p_presentation_json, p_materialization_error
    );
    complete_report := public.stage1_readable_report_complete_v2(
        p_presentation_json
    );
    if not complete_report then
        update public.analysis_cases_v2
        set stage1_status = 'unresolved', unresolved_at = now(),
            completed_at = null
        where id = selected_case_id;
        return true;
    end if;
    report_hash := encode(extensions.digest(
        convert_to(p_presentation_json::text, 'UTF8'), 'sha256'
    ), 'hex');
    select encode(extensions.digest(
        convert_to(attempt.raw_model_output_text, 'UTF8'), 'sha256'
    ), 'hex') into response_hash
    from public.stage1_attempts_v2 as attempt
    where attempt.id = p_attempt_id;
    insert into public.stage1_readable_reports_v2 (
        attempt_id, report_json, report_sha256, source_response_sha256,
        source_kind, provider, model, reasoning_effort, provider_status
    ) values (
        p_attempt_id, p_presentation_json, report_hash, response_hash,
        'provider_completed_response', selected_provider, selected_model,
        selected_reasoning_effort,
        (select provider_status from public.stage1_attempts_v2
         where id = p_attempt_id)
    );
    update public.analysis_cases_v2
    set stage1_status = 'completed', completed_at = now(),
        unresolved_at = null
    where id = selected_case_id;
    perform public.advance_closed_cohorts_v2(selected_case_id);
    return true;
end;
$function$;

create function public.require_stage1_report_for_completion_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.stage1_status = 'completed'
       and not exists (
           select 1
           from public.stage1_attempts_v2 as attempt
           join public.stage1_readable_reports_v2 as report
             on report.attempt_id = attempt.id
           where attempt.case_id = new.id
             and attempt.status = 'completed'
       ) then
        raise exception 'Stage 1 cannot complete before its readable report is submitted';
    end if;
    return new;
end;
$function$;

create trigger analysis_cases_v2_require_stage1_report
before insert or update of stage1_status on public.analysis_cases_v2
for each row execute function public.require_stage1_report_for_completion_v2();

create function public.require_all_stage1_reports_for_stage2_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.status in ('stage2_queued', 'stage2_processing', 'completed')
       and exists (
           select 1
           from public.analysis_cohort_cases_v2 as member
           join public.analysis_cases_v2 as analysis_case
             on analysis_case.id = member.case_id
           where member.cohort_id = new.id
             and (
                 analysis_case.stage1_status <> 'completed'
                 or not exists (
                     select 1
                     from public.stage1_attempts_v2 as attempt
                     join public.stage1_readable_reports_v2 as report
                       on report.attempt_id = attempt.id
                     where attempt.case_id = analysis_case.id
                       and attempt.status = 'completed'
                 )
             )
       ) then
        raise exception 'Stage 2 cannot progress until every member has a submitted Stage 1 report';
    end if;
    return new;
end;
$function$;

create trigger analysis_cohorts_v2_require_stage1_reports
before update of status on public.analysis_cohorts_v2
for each row execute function public.require_all_stage1_reports_for_stage2_v2();

create function public.stage2_readable_report_complete_v2(
    p_layer text,
    p_report jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
    collection jsonb;
    item jsonb;
    text_field text;
    source_field text;
begin
    if p_layer = '2a' then
        collection := p_report -> 'harmonized_codes';
        text_field := 'label';
        source_field := 'source_codes';
    elsif p_layer = '2b' then
        collection := p_report -> 'harmonized_categories';
        text_field := 'label';
        source_field := 'source_categories';
    elsif p_layer = '2c' then
        collection := p_report -> 'harmonized_themes';
        text_field := 'statement';
        source_field := 'source_themes';
    else
        return false;
    end if;
    if jsonb_typeof(p_report) <> 'object'
       or jsonb_typeof(collection) <> 'array'
       or jsonb_array_length(collection) = 0 then
        return false;
    end if;
    for item in select value from jsonb_array_elements(collection)
    loop
        if nullif(btrim(item ->> 'id'), '') is null
           or nullif(btrim(item ->> text_field), '') is null
           or jsonb_typeof(item -> source_field) <> 'array'
           or jsonb_array_length(item -> source_field) = 0
           or exists (
               select 1 from jsonb_array_elements_text(item -> source_field)
                   as reference(value)
               where nullif(btrim(reference.value), '') is null
           ) then
            return false;
        end if;
    end loop;
    return true;
end;
$function$;

do $verify_existing_stage2_reports$
begin
    if exists (
        select 1
        from public.stage2_runs_v2 as run
        left join public.stage2_presentations_v2 as report
          on report.run_id = run.id
        where run.status = 'completed'
          and not public.stage2_readable_report_complete_v2(
              run.analysis_layer, report.presentation_json
          )
    ) then
        raise exception 'A completed Stage 2 operation has no complete report';
    end if;
end;
$verify_existing_stage2_reports$;

create or replace function public.record_stage2_v2_provider_response(
    p_run_id uuid,
    p_outcome text,
    p_provider_response_id text,
    p_provider_status text,
    p_provider_response_json jsonb,
    p_raw_model_output_text text,
    p_incomplete_details jsonb default null,
    p_technical_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
    stored_status text;
begin
    if p_outcome not in (
        'provider_pending', 'completed', 'technically_incomplete', 'failed'
    ) then raise exception 'Invalid objective provider outcome'; end if;
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status in ('processing', 'provider_pending')
    for update;
    if selected_cohort_id is null then
        raise exception 'Stage 2 run is not active';
    end if;
    if p_outcome = 'provider_pending' then
        update public.stage2_runs_v2
        set status = 'provider_pending',
            provider_response_id = p_provider_response_id,
            provider_status = p_provider_status,
            next_poll_at = now() + interval '15 seconds'
        where id = p_run_id;
        return true;
    end if;
    stored_status := case when p_outcome = 'completed'
        then 'report_pending' else p_outcome end;
    update public.stage2_runs_v2
    set status = stored_status,
        provider_response_id = p_provider_response_id,
        provider_status = p_provider_status,
        provider_response_json = p_provider_response_json,
        raw_model_output_text = p_raw_model_output_text,
        incomplete_details = p_incomplete_details,
        technical_error = p_technical_error,
        next_poll_at = null,
        terminal_at = now()
    where id = p_run_id;
    perform public.refresh_parallel_stage2_cohort_status_v2(selected_cohort_id);
    return true;
end;
$function$;

create or replace function public.save_stage2_v2_presentation(
    p_run_id uuid,
    p_presentation_json jsonb,
    p_materialization_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
    selected_layer text;
    complete_report boolean;
begin
    select cohort_id, analysis_layer
    into selected_cohort_id, selected_layer
    from public.stage2_runs_v2
    where id = p_run_id and status = 'report_pending';
    if selected_cohort_id is null then
        raise exception 'Only an objectively completed Stage 2 response can submit its report';
    end if;
    insert into public.stage2_presentations_v2 (
        run_id, presentation_json, materialization_error
    ) values (p_run_id, p_presentation_json, p_materialization_error);
    complete_report := public.stage2_readable_report_complete_v2(
        selected_layer, p_presentation_json
    );
    if complete_report then
        update public.stage2_runs_v2
        set status = 'completed'
        where id = p_run_id;
    else
        update public.stage2_runs_v2
        set status = 'technically_incomplete',
            technical_error = coalesce(
                nullif(btrim(p_materialization_error), ''),
                'The provider response did not yield a complete readable Stage 2 report.'
            )
        where id = p_run_id;
    end if;
    perform public.refresh_parallel_stage2_cohort_status_v2(selected_cohort_id);
    return complete_report;
end;
$function$;

create function public.require_stage2_report_for_completion_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.status = 'completed'
       and not exists (
           select 1
           from public.stage2_presentations_v2 as report
           where report.run_id = new.id
             and public.stage2_readable_report_complete_v2(
                 new.analysis_layer, report.presentation_json
             )
       ) then
        raise exception 'A Stage 2 operation cannot complete before its report is submitted';
    end if;
    return new;
end;
$function$;

create trigger stage2_runs_v2_require_report
before insert or update of status on public.stage2_runs_v2
for each row execute function public.require_stage2_report_for_completion_v2();

revoke all on function public.record_stage1_v2_provider_response(
    uuid, text, text, text, jsonb, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.save_stage1_v2_presentation(
    uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_v2_provider_response(
    uuid, text, text, text, jsonb, text, jsonb, text
) to service_role;
grant execute on function public.save_stage1_v2_presentation(
    uuid, jsonb, text
) to service_role;

revoke all on function public.require_stage1_report_for_completion_v2()
from public, anon, authenticated, service_role;
revoke all on function public.require_all_stage1_reports_for_stage2_v2()
from public, anon, authenticated, service_role;
revoke all on function public.stage1_readable_report_complete_v2(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.require_stage1_report_for_completion_v2()
to service_role;
grant execute on function public.require_all_stage1_reports_for_stage2_v2()
to service_role;
grant execute on function public.stage1_readable_report_complete_v2(jsonb)
to service_role;
revoke all on function public.stage2_readable_report_complete_v2(text, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.require_stage2_report_for_completion_v2()
from public, anon, authenticated, service_role;
grant execute on function public.stage2_readable_report_complete_v2(text, jsonb)
to service_role;
grant execute on function public.require_stage2_report_for_completion_v2()
to service_role;

