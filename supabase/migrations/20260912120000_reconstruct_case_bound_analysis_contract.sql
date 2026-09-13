-- Reconstruct the case-bound analysis system around the researcher-approved
-- contract. Historical evidence remains immutable. Codex-era analytical
-- ceilings, completed-case reruns, individual Stage 2 reruns, and legacy
-- analytical workers are not part of the operative system.

alter table public.analysis_project_configurations_v2
    alter column max_output_tokens drop not null;

alter table public.analysis_project_configurations_v2
    drop constraint if exists analysis_project_configurations_v2_output_positive;

alter table public.analysis_project_configurations_v2
    add constraint analysis_project_configurations_v2_output_optional_positive
    check (max_output_tokens is null or max_output_tokens > 0);

alter table public.stage1_attempts_v2
    add column configuration_id uuid
        references public.analysis_project_configurations_v2(id) on delete restrict;

create index stage1_attempts_v2_configuration_idx
on public.stage1_attempts_v2(configuration_id);

alter table public.stage2_runs_v2
    add column execution_set_id uuid;

create index stage2_runs_v2_execution_set_idx
on public.stage2_runs_v2(execution_set_id, analysis_layer);

create index if not exists stage2_runs_v2_prior_run_idx
on public.stage2_runs_v2(prior_run_id);

create index if not exists stage2_source_item_lineage_v2_case_idx
on public.stage2_source_item_lineage_v2(case_id);

create or replace function public.prepare_stage1_v2_attempt()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.configuration_id is null then
        select analysis_case.configuration_id into new.configuration_id
        from public.analysis_cases_v2 as analysis_case
        where analysis_case.id = new.case_id;
    end if;
    if new.configuration_id is null then
        raise exception 'A Stage 1 attempt requires an immutable researcher configuration';
    end if;
    return new;
end;
$function$;

create or replace function public.advance_analysis_cohort_v2(
    p_cohort_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort public.analysis_cohorts_v2%rowtype;
    selected_configuration public.analysis_project_configurations_v2%rowtype;
    member_count integer;
    complete_count integer;
    present_count integer;
    corpus_codes jsonb;
    corpus_categories jsonb;
    corpus_themes jsonb;
    snapshot_2a jsonb;
    snapshot_2b jsonb;
    snapshot_2c jsonb;
    execution_set uuid := gen_random_uuid();
    run_2a uuid;
    run_2b uuid;
    run_2c uuid;
begin
    select * into selected_cohort
    from public.analysis_cohorts_v2
    where id = p_cohort_id
    for update;

    if not found or selected_cohort.status = 'open' then return null; end if;

    select count(*),
        count(*) filter (where analysis_case.stage1_status = 'completed'),
        count(*) filter (where exists (
            select 1
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
             and presentation.presentation_json is not null
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
        ))
    into member_count, complete_count, present_count
    from public.analysis_cohort_cases_v2 as member
    join public.analysis_cases_v2 as analysis_case
      on analysis_case.id = member.case_id
    where member.cohort_id = p_cohort_id;

    if member_count = 0 or complete_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'closed',
            blocked_reason = case when member_count = 0
                then 'The closed cohort contains no cases.'
                else 'Every cohort member must objectively complete Stage 1 before the cohort can advance.'
            end
        where id = p_cohort_id
          and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if present_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'blocked',
            blocked_reason = 'Every completed case must expose its exact Stage 1 structure before the full cohort can advance.'
        where id = p_cohort_id
          and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if exists (
        select 1 from public.stage2_runs_v2 where cohort_id = p_cohort_id
    ) then
        select id into run_2a
        from public.stage2_runs_v2
        where cohort_id = p_cohort_id and analysis_layer = '2a'
        order by attempt_number desc
        limit 1;
        return run_2a;
    end if;

    with source_items as (
        select analysis_case.id as case_id,
            code.value ->> 'id' as local_source_id,
            code.value ->> 'label' as source_text,
            row_number() over (
                order by analysis_case.case_number, code.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_codes'
        ) with ordinality as code(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    select jsonb_agg(jsonb_build_object(
        'source_ref', 'PC' || lpad(source_number::text, 6, '0'),
        'label', source_text
    ) order by source_number)
    into corpus_codes
    from source_items;

    with source_items as (
        select analysis_case.id as case_id,
            category.value ->> 'id' as local_source_id,
            category.value ->> 'label' as source_text,
            row_number() over (
                order by analysis_case.case_number, category.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_categories'
        ) with ordinality as category(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    select jsonb_agg(jsonb_build_object(
        'source_ref', 'PCA' || lpad(source_number::text, 6, '0'),
        'label', source_text
    ) order by source_number)
    into corpus_categories
    from source_items;

    with source_items as (
        select analysis_case.id as case_id,
            theme.value ->> 'id' as local_source_id,
            theme.value ->> 'statement' as source_text,
            row_number() over (
                order by analysis_case.case_number, theme.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_tentative_themes'
        ) with ordinality as theme(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    select jsonb_agg(jsonb_build_object(
        'source_ref', 'PTH' || lpad(source_number::text, 6, '0'),
        'statement', source_text
    ) order by source_number)
    into corpus_themes
    from source_items;

    if corpus_codes is null or corpus_categories is null or corpus_themes is null then
        update public.analysis_cohorts_v2
        set status = 'blocked',
            blocked_reason = 'The closed cohort must contain at least one preliminary Code, Category, and Theme for the three Stage 2 operations.'
        where id = p_cohort_id;
        return null;
    end if;

    snapshot_2a := jsonb_build_object(
        'cohortId', p_cohort_id,
        'preliminary_codes', corpus_codes
    );
    snapshot_2b := jsonb_build_object(
        'cohortId', p_cohort_id,
        'preliminary_categories', corpus_categories
    );
    snapshot_2c := jsonb_build_object(
        'cohortId', p_cohort_id,
        'preliminary_themes', corpus_themes
    );

    select * into selected_configuration
    from public.analysis_project_configurations_v2
    where id = selected_cohort.configuration_id;

    insert into public.stage2_runs_v2 (
        cohort_id, analysis_layer, attempt_number, execution_set_id,
        provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        p_cohort_id, '2a', 1, execution_set,
        selected_configuration.provider, selected_configuration.model,
        selected_configuration.reasoning_effort, null, snapshot_2a,
        encode(extensions.digest(convert_to(snapshot_2a::text, 'UTF8'), 'sha256'), 'hex')
    ) returning id into run_2a;

    insert into public.stage2_runs_v2 (
        cohort_id, analysis_layer, attempt_number, execution_set_id,
        provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        p_cohort_id, '2b', 1, execution_set,
        selected_configuration.provider, selected_configuration.model,
        selected_configuration.reasoning_effort, null, snapshot_2b,
        encode(extensions.digest(convert_to(snapshot_2b::text, 'UTF8'), 'sha256'), 'hex')
    ) returning id into run_2b;

    insert into public.stage2_runs_v2 (
        cohort_id, analysis_layer, attempt_number, execution_set_id,
        provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        p_cohort_id, '2c', 1, execution_set,
        selected_configuration.provider, selected_configuration.model,
        selected_configuration.reasoning_effort, null, snapshot_2c,
        encode(extensions.digest(convert_to(snapshot_2c::text, 'UTF8'), 'sha256'), 'hex')
    ) returning id into run_2c;

    with source_items as (
        select analysis_case.id as case_id,
            code.value ->> 'id' as local_source_id,
            row_number() over (
                order by analysis_case.case_number, code.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_codes'
        ) with ordinality as code(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    insert into public.stage2_source_code_lineage_v2 (
        run_id, source_ref, case_id, local_code_id
    )
    select run_2a,
        'PC' || lpad(source_number::text, 6, '0'),
        case_id, local_source_id
    from source_items
    order by source_number;

    with source_items as (
        select analysis_case.id as case_id,
            category.value ->> 'id' as local_source_id,
            row_number() over (
                order by analysis_case.case_number, category.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_categories'
        ) with ordinality as category(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    insert into public.stage2_source_item_lineage_v2 (
        run_id, source_ref, case_id, local_source_id
    )
    select run_2b,
        'PCA' || lpad(source_number::text, 6, '0'),
        case_id, local_source_id
    from source_items
    order by source_number;

    with source_items as (
        select analysis_case.id as case_id,
            theme.value ->> 'id' as local_source_id,
            row_number() over (
                order by analysis_case.case_number, theme.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join lateral (
            select presentation.presentation_json
            from public.stage1_attempts_v2 as attempt
            join public.stage1_presentations_v2 as presentation
              on presentation.attempt_id = attempt.id
            where attempt.case_id = analysis_case.id
              and attempt.status = 'completed'
            order by attempt.attempt_number desc
            limit 1
        ) as completed on true
        cross join lateral jsonb_array_elements(
            completed.presentation_json -> 'preliminary_tentative_themes'
        ) with ordinality as theme(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    insert into public.stage2_source_item_lineage_v2 (
        run_id, source_ref, case_id, local_source_id
    )
    select run_2c,
        'PTH' || lpad(source_number::text, 6, '0'),
        case_id, local_source_id
    from source_items
    order by source_number;

    update public.analysis_cohorts_v2
    set status = 'stage2_queued', blocked_reason = null
    where id = p_cohort_id;

    return run_2a;
end;
$function$;

drop function if exists public.create_stage2_v2_attempt(uuid);

create function public.create_stage2_v2_attempt_set(p_cohort_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort public.analysis_cohorts_v2%rowtype;
    source_run public.stage2_runs_v2%rowtype;
    execution_set uuid := gen_random_uuid();
    layer_count integer;
    terminal_count integer;
    next_attempt integer;
    new_run_id uuid;
    new_runs jsonb := '{}'::jsonb;
begin
    perform pg_advisory_xact_lock(
        hashtextextended('case_bound_stage2_v2_attempt_set_' || p_cohort_id::text, 0)
    );
    select * into selected_cohort
    from public.analysis_cohorts_v2
    where id = p_cohort_id
    for update;
    if not found or selected_cohort.status = 'open' then
        raise exception 'Stage 2 requires a closed researcher-defined cohort';
    end if;

    with latest as (
        select distinct on (analysis_layer) analysis_layer, status
        from public.stage2_runs_v2
        where cohort_id = p_cohort_id
        order by analysis_layer, attempt_number desc
    )
    select count(*),
        count(*) filter (where status in (
            'completed', 'technically_incomplete', 'failed'
        ))
    into layer_count, terminal_count
    from latest;

    if layer_count <> 3 then
        raise exception 'The cohort does not have all three frozen Stage 2 sources';
    end if;
    if terminal_count <> 3 then
        raise exception 'The current Stage 2 execution set must reach objective terminal status before another set starts';
    end if;

    for source_run in
        select distinct on (analysis_layer) *
        from public.stage2_runs_v2
        where cohort_id = p_cohort_id
        order by analysis_layer, attempt_number desc
    loop
        select coalesce(max(attempt_number), 0) + 1
        into next_attempt
        from public.stage2_runs_v2
        where cohort_id = p_cohort_id
          and analysis_layer = source_run.analysis_layer;

        insert into public.stage2_runs_v2 (
            cohort_id, analysis_layer, attempt_number, prior_run_id,
            execution_set_id, provider, model, reasoning_effort,
            max_output_tokens, corpus_snapshot_json, corpus_snapshot_sha256
        ) values (
            source_run.cohort_id, source_run.analysis_layer, next_attempt,
            source_run.id, execution_set, source_run.provider,
            source_run.model, source_run.reasoning_effort, null,
            source_run.corpus_snapshot_json, source_run.corpus_snapshot_sha256
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

        new_runs := new_runs || jsonb_build_object(
            source_run.analysis_layer, new_run_id
        );
    end loop;

    update public.analysis_cohorts_v2
    set status = 'stage2_processing', blocked_reason = null
    where id = p_cohort_id;

    return jsonb_build_object(
        'executionSetId', execution_set,
        'runs', new_runs
    );
end;
$function$;

revoke all on function public.create_stage2_v2_attempt_set(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.create_stage2_v2_attempt_set(uuid) to service_role;

do $retire_codex_workers$
declare
    routine record;
begin
    for routine in
        select procedure.oid::regprocedure as identity
        from pg_proc as procedure
        join pg_namespace as namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = any(array[
              'create_advanced_preliminary_analysis_run',
              'create_fresh_independent_analysis_run',
              'resume_advanced_preliminary_analysis_run',
              'cancel_advanced_preliminary_analysis_run',
              'claim_next_advanced_preliminary_analysis',
              'claim_available_advanced_preliminary_analysis',
              'save_advanced_preliminary_provider_response',
              'save_advanced_preliminary_model_output',
              'complete_advanced_preliminary_analysis',
              'fail_advanced_preliminary_analysis',
              'resolve_stalled_advanced_preliminary_response',
              'replace_researcher_authorized_advanced_preliminary_response',
              'restore_advanced_preliminary_existing_report_output',
              'consume_authorized_analysis_initial_wake',
              'consume_authorized_analysis_server_tick',
              'complete_stage2a_code_harmonization'
          ])
    loop
        execute format(
            'revoke all on function %s from service_role',
            routine.identity
        );
    end loop;
end;
$retire_codex_workers$;

comment on function public.create_stage2_v2_attempt_set(uuid) is
    'Atomically creates one immutable no-application-ceiling execution set containing Stage 2A, Stage 2B, and Stage 2C from their latest frozen sources.';
comment on column public.stage2_runs_v2.execution_set_id is
    'Shared immutable identity for Stage 2A, Stage 2B, and Stage 2C attempts created and started together.';

create trigger stage1_attempts_v2_prepare_configuration
before insert on public.stage1_attempts_v2
for each row execute function public.prepare_stage1_v2_attempt();

create or replace function public.enrich_stage1_source_with_design_context_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    frozen_project_context jsonb;
begin
    select jsonb_strip_nulls(jsonb_build_object(
        'project_title', design.research_title,
        'research_topic', coalesce(design.interview_topic, project.research_topic),
        'research_purpose', design.research_purpose,
        'research_objectives', design.research_goal,
        'research_questions', design.interview_questions,
        'research_design_id', design.id,
        'research_design_version', design.protocol_version,
        'research_design_version_notes', design.version_notes
    )) into frozen_project_context
    from public.research_designs as design
    join public.research_projects as project on project.id = design.project_id
    where design.id = (new.source_json ->> 'researchDesignId')::uuid
      and project.id = (new.source_json ->> 'projectId')::uuid;

    if frozen_project_context is null then
        raise exception 'The completed case has no authoritative research-design context';
    end if;

    new.source_json := jsonb_set(
        new.source_json,
        '{projectContext}',
        frozen_project_context,
        true
    );
    new.source_sha256 := encode(
        extensions.digest(convert_to(new.source_json::text, 'UTF8'), 'sha256'),
        'hex'
    );
    return new;
end;
$function$;

create trigger stage1_source_snapshots_v2_design_context
before insert on public.stage1_source_snapshots_v2
for each row execute function public.enrich_stage1_source_with_design_context_v2();

create or replace function public.enforce_stage2_v2_no_application_ceiling()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    new.max_output_tokens := null;
    return new;
end;
$function$;

create trigger stage2_runs_v2_no_application_ceiling
before insert or update of max_output_tokens on public.stage2_runs_v2
for each row execute function public.enforce_stage2_v2_no_application_ceiling();

create or replace function public.save_analysis_project_configuration_v2(
    p_project_id uuid,
    p_provider text,
    p_model text,
    p_reasoning_effort text,
    p_max_output_tokens integer,
    p_contract_version text,
    p_prompt_version text,
    p_configuration_json jsonb,
    p_configuration_sha256 text,
    p_actor text default 'researcher'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_id uuid;
begin
    insert into public.analysis_project_configurations_v2 (
        project_id, provider, model, reasoning_effort, max_output_tokens,
        contract_version, prompt_version, configuration_json,
        configuration_sha256, created_by
    ) values (
        p_project_id, btrim(p_provider), btrim(p_model), btrim(p_reasoning_effort),
        p_max_output_tokens, btrim(p_contract_version), btrim(p_prompt_version),
        p_configuration_json, p_configuration_sha256,
        coalesce(nullif(btrim(p_actor), ''), 'researcher')
    )
    on conflict (project_id, configuration_sha256) do nothing
    returning id into selected_id;

    if selected_id is null then
        select configuration.id into selected_id
        from public.analysis_project_configurations_v2 as configuration
        where configuration.project_id = p_project_id
          and configuration.configuration_sha256 = p_configuration_sha256;
    end if;

    insert into public.active_analysis_project_configurations_v2 (
        project_id, configuration_id, activated_at, activated_by
    ) values (
        p_project_id, selected_id, now(),
        coalesce(nullif(btrim(p_actor), ''), 'researcher')
    )
    on conflict (project_id) do update
    set configuration_id = excluded.configuration_id,
        activated_at = excluded.activated_at,
        activated_by = excluded.activated_by;

    return selected_id;
end;
$function$;

drop function if exists public.create_stage1_v2_attempt(uuid);

create function public.create_stage1_v2_attempt(p_case_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_case public.analysis_cases_v2%rowtype;
    selected_configuration_id uuid;
    next_number integer;
    new_attempt_id uuid;
begin
    select * into selected_case
    from public.analysis_cases_v2
    where id = p_case_id and stage1_status = 'unresolved'
    for update;
    if not found then
        raise exception 'Only an unresolved Stage 1 case can receive a separate researcher-started attempt';
    end if;

    select active.configuration_id into selected_configuration_id
    from public.active_analysis_project_configurations_v2 as active
    join public.analysis_project_configurations_v2 as configuration
      on configuration.id = active.configuration_id
    where active.project_id = selected_case.project_id
      and configuration.project_id = selected_case.project_id;
    if selected_configuration_id is null then
        raise exception 'Activate the researcher-selected configuration before resolving this case';
    end if;

    select coalesce(max(attempt_number), 0) + 1 into next_number
    from public.stage1_attempts_v2 where case_id = p_case_id;

    insert into public.stage1_attempts_v2 (
        case_id, attempt_number, configuration_id
    ) values (
        p_case_id, next_number, selected_configuration_id
    ) returning id into new_attempt_id;

    update public.analysis_cases_v2
    set stage1_status = 'pending', unresolved_at = null
    where id = p_case_id;

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
    join public.analysis_cases_v2 as analysis_case
      on analysis_case.id = attempt.case_id
    where analysis_case.stage1_status <> 'completed'
      and (
        attempt.status = 'pending'
        or (attempt.status = 'provider_pending'
            and coalesce(attempt.next_poll_at, now()) <= now())
      )
    order by case when attempt.status = 'pending' then 0 else 1 end,
        attempt.queued_at, attempt.id
    for update of attempt skip locked limit 1;
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
    select * into selected_configuration
    from public.analysis_project_configurations_v2
    where id = coalesce(
        selected_attempt.configuration_id,
        selected_case.configuration_id
    );
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

revoke all on function public.create_stage1_v2_attempt(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.create_stage1_v2_attempt(uuid) to service_role;

comment on function public.create_stage1_v2_attempt(uuid) is
    'Creates a separate researcher-started attempt only for an unresolved case, using the active immutable researcher configuration. Completed Stage 1 cases cannot be revisited.';
