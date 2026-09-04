-- Codex has no authority to decide whether the researcher may run analysis.
-- Keep immutable historical records and technical lineage, but remove status
-- approval and justification requirements from new Stage 1 and Stage 2 attempts.

alter table public.stage2_runs_v2
    drop constraint if exists stage2_runs_v2_replacement_lineage_consistent;

alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_attempt_lineage_consistent check (
        (attempt_number = 1 and prior_run_id is null)
        or (attempt_number > 1 and prior_run_id is not null)
    );

create function public.check_stage2_v2_attempt_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.attempt_number > 1 and not exists (
        select 1 from public.stage2_runs_v2 as source
        where source.id = new.prior_run_id
          and source.cohort_id = new.cohort_id
          and source.analysis_layer = new.analysis_layer
          and source.attempt_number < new.attempt_number
    ) then
        raise exception 'Stage 2 attempt lineage must reference an earlier attempt in the same cohort and layer';
    end if;
    return new;
end;
$function$;

create trigger stage2_runs_v2_attempt_lineage
before insert or update of cohort_id, analysis_layer, attempt_number, prior_run_id
on public.stage2_runs_v2
for each row execute function public.check_stage2_v2_attempt_lineage();

drop function if exists public.authorize_stage2_v2_replacement(uuid, text);

drop function if exists public.authorize_stage1_v2_new_attempt(uuid, text);

create function public.create_stage1_v2_attempt(p_case_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    next_number integer;
    new_attempt_id uuid;
begin
    perform 1 from public.analysis_cases_v2
    where id = p_case_id
    for update;
    if not found then raise exception 'The Stage 1 case does not exist'; end if;

    select coalesce(max(attempt_number), 0) + 1 into next_number
    from public.stage1_attempts_v2 where case_id = p_case_id;
    insert into public.stage1_attempts_v2 (case_id, attempt_number)
    values (p_case_id, next_number)
    returning id into new_attempt_id;

    update public.analysis_cases_v2
    set stage1_status = 'pending', unresolved_at = null
    where id = p_case_id and stage1_status <> 'completed';
    return new_attempt_id;
end;
$function$;

create or replace function public.claim_next_stage1_v2_attempt()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_attempt public.stage1_attempts_v2%rowtype;
    selected_case public.analysis_cases_v2%rowtype;
    selected_source public.stage1_source_snapshots_v2%rowtype;
    selected_configuration public.analysis_project_configurations_v2%rowtype;
    selected_request public.stage1_requests_v2%rowtype;
    selected_action text;
begin
    perform pg_advisory_xact_lock(hashtextextended('case_bound_stage1_v2_claim', 0));
    select attempt.* into selected_attempt
    from public.stage1_attempts_v2 as attempt
    where attempt.status = 'pending'
       or (attempt.status = 'provider_pending'
           and coalesce(attempt.next_poll_at, now()) <= now())
    order by case when attempt.status = 'pending' then 0 else 1 end,
        attempt.queued_at, attempt.id
    for update skip locked limit 1;
    if not found then return null; end if;

    selected_action := case when selected_attempt.status = 'pending'
        then 'submit' else 'retrieve' end;
    select * into selected_case from public.analysis_cases_v2
    where id = selected_attempt.case_id for update;

    if selected_action = 'submit' then
        update public.stage1_attempts_v2
        set status = 'processing', claimed_at = now()
        where id = selected_attempt.id;
        update public.analysis_cases_v2
        set stage1_status = 'processing'
        where id = selected_case.id and stage1_status <> 'completed';
    else
        update public.stage1_attempts_v2
        set claimed_at = now(), next_poll_at = now() + interval '15 seconds'
        where id = selected_attempt.id;
    end if;

    select * into selected_source from public.stage1_source_snapshots_v2
    where case_id = selected_case.id;
    select * into selected_configuration from public.analysis_project_configurations_v2
    where id = selected_case.configuration_id;
    select * into selected_request from public.stage1_requests_v2
    where attempt_id = selected_attempt.id;
    return jsonb_build_object(
        'action', selected_action,
        'attemptId', selected_attempt.id,
        'caseId', selected_case.id,
        'caseNumber', selected_case.case_number,
        'sourceJson', selected_source.source_json,
        'sourceSha256', selected_source.source_sha256,
        'configurationJson', selected_configuration.configuration_json,
        'provider', selected_configuration.provider,
        'providerResponseId', selected_attempt.provider_response_id,
        'frozenRequest', selected_request.request_json
    );
end;
$function$;

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
    ) then raise exception 'Invalid objective provider outcome'; end if;

    select case_id into selected_case_id
    from public.stage1_attempts_v2
    where id = p_attempt_id and status in ('processing', 'provider_pending')
    for update;
    if selected_case_id is null then raise exception 'Stage 1 attempt is not active'; end if;

    if p_outcome = 'provider_pending' then
        update public.stage1_attempts_v2
        set status = 'provider_pending', provider_response_id = p_provider_response_id,
            provider_status = p_provider_status,
            next_poll_at = now() + interval '15 seconds'
        where id = p_attempt_id;
        update public.analysis_cases_v2 set stage1_status = 'provider_pending'
        where id = selected_case_id and stage1_status <> 'completed';
        return true;
    end if;

    update public.stage1_attempts_v2
    set status = p_outcome, provider_response_id = p_provider_response_id,
        provider_status = p_provider_status,
        provider_response_json = p_provider_response_json,
        raw_model_output_text = p_raw_model_output_text,
        incomplete_details = p_incomplete_details,
        technical_error = p_technical_error, next_poll_at = null,
        terminal_at = now()
    where id = p_attempt_id;

    if p_outcome = 'completed' then
        update public.analysis_cases_v2
        set stage1_status = 'completed', completed_at = coalesce(completed_at, now()),
            unresolved_at = null
        where id = selected_case_id;
    else
        update public.analysis_cases_v2
        set stage1_status = 'unresolved', unresolved_at = now()
        where id = selected_case_id and stage1_status <> 'completed';
    end if;
    return true;
end;
$function$;

create or replace function public.fail_stage1_v2_attempt(
    p_attempt_id uuid,
    p_technical_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_case_id uuid;
begin
    select case_id into selected_case_id
    from public.stage1_attempts_v2
    where id = p_attempt_id and status in ('processing', 'provider_pending')
    for update;
    if selected_case_id is null then return false; end if;

    update public.stage1_attempts_v2
    set status = 'failed', technical_error = p_technical_error,
        terminal_at = now(), next_poll_at = null
    where id = p_attempt_id;
    update public.analysis_cases_v2
    set stage1_status = 'unresolved', unresolved_at = now()
    where id = selected_case_id and stage1_status <> 'completed';
    return true;
end;
$function$;

create function public.create_stage2_v2_attempt(p_source_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    source_run public.stage2_runs_v2%rowtype;
    next_attempt integer;
    new_run_id uuid;
begin
    select * into source_run
    from public.stage2_runs_v2
    where id = p_source_run_id
    for update;
    if not found then raise exception 'The Stage 2 source run does not exist'; end if;

    select coalesce(max(run.attempt_number), 0) + 1 into next_attempt
    from public.stage2_runs_v2 as run
    where run.cohort_id = source_run.cohort_id
      and run.analysis_layer = source_run.analysis_layer;

    insert into public.stage2_runs_v2 (
        cohort_id, analysis_layer, attempt_number, prior_run_id,
        provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        source_run.cohort_id, source_run.analysis_layer, next_attempt,
        source_run.id, source_run.provider, source_run.model,
        source_run.reasoning_effort, null, source_run.corpus_snapshot_json,
        source_run.corpus_snapshot_sha256
    ) returning id into new_run_id;

    if source_run.analysis_layer = '2a' then
        insert into public.stage2_source_code_lineage_v2 (
            run_id, source_ref, case_id, local_code_id
        )
        select new_run_id, source_ref, case_id, local_code_id
        from public.stage2_source_code_lineage_v2
        where run_id = source_run.id;
    else
        insert into public.stage2_source_item_lineage_v2 (
            run_id, source_ref, case_id, local_source_id
        )
        select new_run_id, source_ref, case_id, local_source_id
        from public.stage2_source_item_lineage_v2
        where run_id = source_run.id;
    end if;

    update public.analysis_cohorts_v2
    set status = 'stage2_processing', blocked_reason = null
    where id = source_run.cohort_id;
    return new_run_id;
end;
$function$;

revoke all on function public.create_stage1_v2_attempt(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.create_stage1_v2_attempt(uuid) to service_role;

revoke all on function public.create_stage2_v2_attempt(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.create_stage2_v2_attempt(uuid) to service_role;

comment on function public.create_stage1_v2_attempt(uuid) is
    'Creates a researcher-requested Stage 1 attempt from the immutable case source without a status approval or justification gate.';
comment on function public.create_stage2_v2_attempt(uuid) is
    'Creates a researcher-requested Stage 2 attempt from an immutable source run without a status approval or justification gate.';
