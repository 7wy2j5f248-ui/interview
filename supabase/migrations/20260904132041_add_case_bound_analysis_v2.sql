-- Case-bound qualitative analysis v2 is intentionally isolated from every
-- historical analysis table. This migration does not backfill or reinterpret
-- an earlier report.

create sequence public.analysis_case_number_v2_seq;

create table public.analysis_project_configurations_v2 (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.research_projects(id) on delete restrict,
    provider text not null,
    model text not null,
    reasoning_effort text not null,
    max_output_tokens integer not null,
    contract_version text not null,
    prompt_version text not null,
    configuration_json jsonb not null,
    configuration_sha256 text not null,
    created_at timestamptz not null default now(),
    created_by text not null default 'researcher',
    constraint analysis_project_configurations_v2_provider_valid
        check (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    constraint analysis_project_configurations_v2_model_valid
        check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    constraint analysis_project_configurations_v2_reasoning_valid
        check (reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
    constraint analysis_project_configurations_v2_output_positive
        check (max_output_tokens > 0),
    constraint analysis_project_configurations_v2_json_object
        check (jsonb_typeof(configuration_json) = 'object'),
    constraint analysis_project_configurations_v2_hash_valid
        check (configuration_sha256 ~ '^[0-9a-f]{64}$'),
    constraint analysis_project_configurations_v2_unique
        unique (project_id, configuration_sha256)
);

create table public.active_analysis_project_configurations_v2 (
    project_id uuid primary key references public.research_projects(id) on delete restrict,
    configuration_id uuid not null unique
        references public.analysis_project_configurations_v2(id) on delete restrict,
    activated_at timestamptz not null default now(),
    activated_by text not null default 'researcher'
);

create table public.analysis_cases_v2 (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.research_projects(id) on delete restrict,
    configuration_id uuid not null
        references public.analysis_project_configurations_v2(id) on delete restrict,
    participant_id text not null,
    case_number text not null default (
        'P' || lpad(nextval('public.analysis_case_number_v2_seq')::text, 5, '0')
    ),
    source_completed_at timestamptz not null,
    stage1_status text not null default 'pending',
    frozen_at timestamptz not null default now(),
    completed_at timestamptz,
    unresolved_at timestamptz,
    constraint analysis_cases_v2_participant_not_blank check (btrim(participant_id) <> ''),
    constraint analysis_cases_v2_case_number_valid check (case_number ~ '^P[0-9]{5,}$'),
    constraint analysis_cases_v2_status_valid check (
        stage1_status in ('pending', 'processing', 'provider_pending', 'completed', 'unresolved')
    ),
    constraint analysis_cases_v2_project_participant_unique unique (project_id, participant_id),
    constraint analysis_cases_v2_case_number_unique unique (case_number),
    constraint analysis_cases_v2_completion_consistent check (
        (stage1_status = 'completed' and completed_at is not null and unresolved_at is null)
        or (stage1_status = 'unresolved' and completed_at is null and unresolved_at is not null)
        or (stage1_status not in ('completed', 'unresolved')
            and completed_at is null and unresolved_at is null)
    )
);

create table public.analysis_case_sessions_v2 (
    case_id uuid not null references public.analysis_cases_v2(id) on delete restrict,
    session_id text not null references public.interview_sessions(session_id) on delete restrict,
    session_order integer not null,
    primary key (case_id, session_id),
    constraint analysis_case_sessions_v2_order_positive check (session_order > 0),
    constraint analysis_case_sessions_v2_order_unique unique (case_id, session_order)
);

create table public.stage1_source_snapshots_v2 (
    case_id uuid primary key references public.analysis_cases_v2(id) on delete restrict,
    source_json jsonb not null,
    source_sha256 text not null unique,
    message_count integer not null,
    frozen_at timestamptz not null default now(),
    constraint stage1_source_snapshots_v2_object check (jsonb_typeof(source_json) = 'object'),
    constraint stage1_source_snapshots_v2_hash_valid check (source_sha256 ~ '^[0-9a-f]{64}$'),
    constraint stage1_source_snapshots_v2_count_positive check (message_count > 0)
);

create table public.stage1_attempts_v2 (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.analysis_cases_v2(id) on delete restrict,
    attempt_number integer not null,
    status text not null default 'pending',
    researcher_reason text,
    queued_at timestamptz not null default now(),
    claimed_at timestamptz,
    provider_response_id text,
    provider_status text,
    next_poll_at timestamptz,
    provider_response_json jsonb,
    raw_model_output_text text,
    incomplete_details jsonb,
    technical_error text,
    terminal_at timestamptz,
    constraint stage1_attempts_v2_number_positive check (attempt_number > 0),
    constraint stage1_attempts_v2_status_valid check (
        status in ('pending', 'processing', 'provider_pending', 'completed', 'technically_incomplete', 'failed')
    ),
    constraint stage1_attempts_v2_case_number_unique unique (case_id, attempt_number),
    constraint stage1_attempts_v2_terminal_consistent check (
        (status in ('completed', 'technically_incomplete', 'failed') and terminal_at is not null)
        or (status not in ('completed', 'technically_incomplete', 'failed') and terminal_at is null)
    )
);

create unique index stage1_attempts_v2_one_active_per_case
on public.stage1_attempts_v2(case_id)
where status in ('pending', 'processing', 'provider_pending');

create table public.stage1_requests_v2 (
    attempt_id uuid primary key references public.stage1_attempts_v2(id) on delete restrict,
    provider_request_id text not null unique,
    request_json jsonb not null,
    request_sha256 text not null,
    frozen_at timestamptz not null default now(),
    constraint stage1_requests_v2_object check (jsonb_typeof(request_json) = 'object'),
    constraint stage1_requests_v2_hash_valid check (request_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.stage1_presentations_v2 (
    attempt_id uuid primary key references public.stage1_attempts_v2(id) on delete restrict,
    presentation_json jsonb,
    materialization_error text,
    created_at timestamptz not null default now(),
    constraint stage1_presentations_v2_exactly_one_result check (
        (presentation_json is not null and materialization_error is null)
        or (presentation_json is null and materialization_error is not null)
    ),
    constraint stage1_presentations_v2_object check (
        presentation_json is null or jsonb_typeof(presentation_json) = 'object'
    )
);

create table public.analysis_cohorts_v2 (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.research_projects(id) on delete restrict,
    configuration_id uuid not null
        references public.analysis_project_configurations_v2(id) on delete restrict,
    name text not null,
    status text not null default 'open',
    created_at timestamptz not null default now(),
    created_by text not null default 'researcher',
    closed_at timestamptz,
    blocked_reason text,
    constraint analysis_cohorts_v2_name_not_blank check (btrim(name) <> ''),
    constraint analysis_cohorts_v2_status_valid check (
        status in ('open', 'closed', 'stage2_queued', 'stage2_processing', 'completed', 'blocked')
    ),
    constraint analysis_cohorts_v2_closed_consistent check (
        (status = 'open' and closed_at is null)
        or (status <> 'open' and closed_at is not null)
    )
);

create table public.analysis_cohort_cases_v2 (
    cohort_id uuid not null references public.analysis_cohorts_v2(id) on delete restrict,
    case_id uuid not null references public.analysis_cases_v2(id) on delete restrict,
    enrolled_at timestamptz not null default now(),
    primary key (cohort_id, case_id)
);

create table public.stage2_runs_v2 (
    id uuid primary key default gen_random_uuid(),
    cohort_id uuid not null unique references public.analysis_cohorts_v2(id) on delete restrict,
    provider text not null,
    model text not null,
    reasoning_effort text not null,
    max_output_tokens integer not null,
    status text not null default 'queued',
    corpus_snapshot_json jsonb not null,
    corpus_snapshot_sha256 text not null,
    queued_at timestamptz not null default now(),
    claimed_at timestamptz,
    provider_response_id text,
    provider_status text,
    next_poll_at timestamptz,
    provider_response_json jsonb,
    raw_model_output_text text,
    incomplete_details jsonb,
    technical_error text,
    terminal_at timestamptz,
    constraint stage2_runs_v2_status_valid check (
        status in ('queued', 'processing', 'provider_pending', 'completed', 'technically_incomplete', 'failed')
    ),
    constraint stage2_runs_v2_snapshot_object check (jsonb_typeof(corpus_snapshot_json) = 'object'),
    constraint stage2_runs_v2_hash_valid check (corpus_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    constraint stage2_runs_v2_terminal_consistent check (
        (status in ('completed', 'technically_incomplete', 'failed') and terminal_at is not null)
        or (status not in ('completed', 'technically_incomplete', 'failed') and terminal_at is null)
    )
);

create table public.stage2_requests_v2 (
    run_id uuid primary key references public.stage2_runs_v2(id) on delete restrict,
    provider_request_id text not null unique,
    request_json jsonb not null,
    request_sha256 text not null,
    frozen_at timestamptz not null default now(),
    constraint stage2_requests_v2_object check (jsonb_typeof(request_json) = 'object'),
    constraint stage2_requests_v2_hash_valid check (request_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.stage2_presentations_v2 (
    run_id uuid primary key references public.stage2_runs_v2(id) on delete restrict,
    presentation_json jsonb,
    materialization_error text,
    created_at timestamptz not null default now(),
    constraint stage2_presentations_v2_exactly_one_result check (
        (presentation_json is not null and materialization_error is null)
        or (presentation_json is null and materialization_error is not null)
    ),
    constraint stage2_presentations_v2_object check (
        presentation_json is null or jsonb_typeof(presentation_json) = 'object'
    )
);

create index analysis_cases_v2_project_status_idx
on public.analysis_cases_v2(project_id, stage1_status, source_completed_at);
create index stage1_attempts_v2_queue_idx
on public.stage1_attempts_v2(status, queued_at);
create index analysis_cohort_cases_v2_case_idx
on public.analysis_cohort_cases_v2(case_id);
create index stage2_runs_v2_queue_idx
on public.stage2_runs_v2(status, queued_at);

comment on table public.stage1_source_snapshots_v2 is
    'Immutable one-case interviewer-plus-participant source. Original and English text are retained; only English is analytical input.';
comment on table public.stage1_requests_v2 is
    'Literal immutable provider request frozen before submission.';
comment on table public.stage1_attempts_v2 is
    'One explicitly authorized submission. Terminal incomplete or failed attempts never retry themselves.';
comment on table public.stage2_runs_v2 is
    'One whole-cohort Stage 2A HCO run sourced only from case ID plus preliminary CO.';

create or replace function public.reject_analysis_v2_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    raise exception '% is immutable', tg_table_name;
end;
$function$;

create trigger analysis_project_configurations_v2_immutable
before update or delete on public.analysis_project_configurations_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger stage1_source_snapshots_v2_immutable
before update or delete on public.stage1_source_snapshots_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger stage1_requests_v2_immutable
before update or delete on public.stage1_requests_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger stage1_presentations_v2_immutable
before update or delete on public.stage1_presentations_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger analysis_case_sessions_v2_immutable
before update or delete on public.analysis_case_sessions_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger analysis_cohort_cases_v2_immutable
before update or delete on public.analysis_cohort_cases_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger stage2_requests_v2_immutable
before update or delete on public.stage2_requests_v2
for each row execute function public.reject_analysis_v2_mutation();
create trigger stage2_presentations_v2_immutable
before update or delete on public.stage2_presentations_v2
for each row execute function public.reject_analysis_v2_mutation();

create or replace function public.protect_terminal_stage1_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if old.status in ('completed', 'technically_incomplete', 'failed') then
        raise exception 'A terminal Stage 1 attempt is immutable';
    end if;
    return new;
end;
$function$;

create trigger stage1_attempts_v2_terminal_immutable
before update or delete on public.stage1_attempts_v2
for each row execute function public.protect_terminal_stage1_v2();

create or replace function public.protect_terminal_stage2_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if old.status in ('completed', 'technically_incomplete', 'failed') then
        raise exception 'A terminal Stage 2 run is immutable';
    end if;
    return new;
end;
$function$;

create trigger stage2_runs_v2_terminal_immutable
before update or delete on public.stage2_runs_v2
for each row execute function public.protect_terminal_stage2_v2();

create or replace function public.protect_completed_analysis_case_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if old.stage1_status = 'completed' then
        raise exception 'A completed Stage 1 case is permanently closed';
    end if;
    return new;
end;
$function$;

create trigger analysis_cases_v2_completed_immutable
before update or delete on public.analysis_cases_v2
for each row execute function public.protect_completed_analysis_case_v2();

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

create or replace function public.try_freeze_analysis_case_v2(
    p_session_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    terminal_session public.interview_sessions%rowtype;
    selected_project_id uuid;
    selected_configuration_id uuid;
    selected_activation_time timestamptz;
    selected_case_id uuid;
    selected_case_number text;
    selected_source jsonb;
    selected_source_hash text;
    selected_message_count integer;
begin
    select session.* into terminal_session
    from public.interview_sessions as session
    where session.session_id = p_session_id
      and session.completed = true
      and session.completed_at is not null
      and session.end_reason = 'final_question_answered'
    for update;

    if not found or terminal_session.research_design_id is null then
        return null;
    end if;

    select design.project_id into selected_project_id
    from public.research_designs as design
    where design.id = terminal_session.research_design_id;

    if selected_project_id is null then
        return null;
    end if;

    select active.configuration_id, active.activated_at
    into selected_configuration_id, selected_activation_time
    from public.active_analysis_project_configurations_v2 as active
    where active.project_id = selected_project_id;

    -- Activation arms future completions. It does not backfill older cases.
    if selected_configuration_id is null
       or terminal_session.completed_at < selected_activation_time then
        return null;
    end if;

    -- Do not freeze until every message in the whole resumed-session chain has
    -- English analytical text. Original text remains in the same snapshot.
    if exists (
        with recursive session_chain as (
            select session.session_id, session.continuation_of_session_id
            from public.interview_sessions as session
            where session.session_id = terminal_session.session_id
            union all
            select parent.session_id, parent.continuation_of_session_id
            from public.interview_sessions as parent
            join session_chain as child
              on parent.session_id = child.continuation_of_session_id
        )
        select 1
        from public.interview_messages as message
        join session_chain on session_chain.session_id = message."Session"
        where lower(coalesce(message."Speaker", '')) in (
            'user', 'participant', 'ai', 'assistant', 'interviewer'
        )
          and (
              nullif(btrim(message."Message"), '') is null
              or (
                  lower(coalesce(message."Language", '')) <> 'en'
                  and nullif(btrim(message."EnglishTranslation"), '') is null
              )
          )
    ) then
        return null;
    end if;

    insert into public.analysis_cases_v2 (
        project_id, configuration_id, participant_id, source_completed_at
    ) values (
        selected_project_id, selected_configuration_id,
        terminal_session.participant_id, terminal_session.completed_at
    )
    on conflict (project_id, participant_id) do nothing
    returning id, case_number into selected_case_id, selected_case_number;

    if selected_case_id is null then
        select analysis_case.id, analysis_case.case_number
        into selected_case_id, selected_case_number
        from public.analysis_cases_v2 as analysis_case
        where analysis_case.project_id = selected_project_id
          and analysis_case.participant_id = terminal_session.participant_id;

        -- Existing frozen or completed cases are never rebuilt from live rows.
        if exists (
            select 1 from public.stage1_source_snapshots_v2 as snapshot
            where snapshot.case_id = selected_case_id
        ) then
            return selected_case_id;
        end if;
    end if;

    with recursive session_chain as (
        select session.session_id, session.continuation_of_session_id,
            session.created_at, 1 as reverse_order
        from public.interview_sessions as session
        where session.session_id = terminal_session.session_id
        union all
        select parent.session_id, parent.continuation_of_session_id,
            parent.created_at, child.reverse_order + 1
        from public.interview_sessions as parent
        join session_chain as child
          on parent.session_id = child.continuation_of_session_id
    ), ordered_sessions as (
        select session_id,
            row_number() over (order by reverse_order desc)::integer as session_order
        from session_chain
    )
    insert into public.analysis_case_sessions_v2 (case_id, session_id, session_order)
    select selected_case_id, session_id, session_order
    from ordered_sessions
    order by session_order
    on conflict (case_id, session_id) do nothing;

    with ordered_messages as (
        select
            row_number() over (
                order by linked.session_order, message."Timestamp", message.id
            ) as turn_number,
            linked.session_id,
            message.id::text as message_id,
            case
                when lower(message."Speaker") in ('user', 'participant')
                    then 'participant'
                else 'interviewer'
            end as speaker,
            lower(coalesce(message."Language", terminal_session.language)) as language,
            btrim(message."Message") as original_text,
            case
                when lower(coalesce(message."Language", terminal_session.language)) = 'en'
                    then btrim(message."Message")
                else btrim(message."EnglishTranslation")
            end as english_text
        from public.analysis_case_sessions_v2 as linked
        join public.interview_messages as message
          on message."Session" = linked.session_id
        where linked.case_id = selected_case_id
          and lower(coalesce(message."Speaker", '')) in (
              'user', 'participant', 'ai', 'assistant', 'interviewer'
          )
          and nullif(btrim(message."Message"), '') is not null
    ), source_parts as (
        select
            count(*)::integer as message_count,
            jsonb_agg(
                jsonb_build_object(
                    'turn_id', 'T' || lpad(turn_number::text, 3, '0'),
                    'message_id', message_id,
                    'session_id', session_id,
                    'speaker', speaker,
                    'language', language,
                    'original_text', original_text,
                    'english_text', english_text
                ) order by turn_number
            ) as transcript
        from ordered_messages
    )
    select
        jsonb_build_object(
            'caseNumber', selected_case_number,
            'participantId', terminal_session.participant_id,
            'projectId', selected_project_id,
            'configurationId', selected_configuration_id,
            'terminalSessionId', terminal_session.session_id,
            'sourceCompletedAt', terminal_session.completed_at,
            'researchDesignId', terminal_session.research_design_id,
            'analyticalTranscript', source_parts.transcript
        ),
        source_parts.message_count
    into selected_source, selected_message_count
    from source_parts;

    if selected_message_count < 1 then
        raise exception 'A completed case cannot freeze without a transcript';
    end if;

    selected_source_hash := encode(
        extensions.digest(convert_to(selected_source::text, 'UTF8'), 'sha256'),
        'hex'
    );

    insert into public.stage1_source_snapshots_v2 (
        case_id, source_json, source_sha256, message_count
    ) values (
        selected_case_id, selected_source, selected_source_hash,
        selected_message_count
    ) on conflict (case_id) do nothing;

    insert into public.stage1_attempts_v2 (case_id, attempt_number)
    values (selected_case_id, 1)
    on conflict (case_id, attempt_number) do nothing;

    insert into public.analysis_cohort_cases_v2 (cohort_id, case_id)
    select cohort.id, selected_case_id
    from public.analysis_cohorts_v2 as cohort
    where cohort.project_id = selected_project_id
      and cohort.configuration_id = selected_configuration_id
      and cohort.status = 'open'
    on conflict (cohort_id, case_id) do nothing;

    return selected_case_id;
end;
$function$;

create or replace function public.freeze_analysis_case_after_completion_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if new.completed is true and new.completed_at is not null then
        perform public.try_freeze_analysis_case_v2(new.session_id);
    end if;
    return new;
end;
$function$;

create trigger interview_sessions_freeze_analysis_case_v2
after insert or update of completed, completed_at
on public.interview_sessions
for each row
when (new.completed = true)
execute function public.freeze_analysis_case_after_completion_v2();

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
    order by
        case when attempt.status = 'pending' then 0 else 1 end,
        attempt.queued_at,
        attempt.id
    for update skip locked
    limit 1;

    if not found then return null; end if;

    selected_action := case
        when selected_attempt.status = 'pending' then 'submit'
        else 'retrieve'
    end;

    select * into selected_case from public.analysis_cases_v2
    where id = selected_attempt.case_id for update;

    if selected_case.stage1_status = 'completed' then
        raise exception 'A completed Stage 1 case cannot be claimed';
    end if;

    if selected_action = 'submit' then
        update public.stage1_attempts_v2
        set status = 'processing', claimed_at = now()
        where id = selected_attempt.id;
        update public.analysis_cases_v2
        set stage1_status = 'processing'
        where id = selected_case.id;
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

create or replace function public.freeze_stage1_v2_request(
    p_attempt_id uuid,
    p_provider_request_id text,
    p_request_json jsonb,
    p_request_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if not exists (
        select 1 from public.stage1_attempts_v2
        where id = p_attempt_id and status = 'processing'
    ) then
        raise exception 'Only a processing Stage 1 attempt can freeze its request';
    end if;

    insert into public.stage1_requests_v2 (
        attempt_id, provider_request_id, request_json, request_sha256
    ) values (
        p_attempt_id, p_provider_request_id, p_request_json, p_request_sha256
    );
    return true;
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
        set stage1_status = 'completed', completed_at = now(), unresolved_at = null
        where id = selected_case_id;
    else
        update public.analysis_cases_v2
        set stage1_status = 'unresolved', unresolved_at = now(), completed_at = null
        where id = selected_case_id;
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
    where id = p_attempt_id
      and status in ('processing', 'provider_pending')
    for update;
    if selected_case_id is null then return false; end if;

    update public.stage1_attempts_v2
    set status = 'failed', technical_error = p_technical_error,
        terminal_at = now(), next_poll_at = null
    where id = p_attempt_id;
    update public.analysis_cases_v2
    set stage1_status = 'unresolved', unresolved_at = now(), completed_at = null
    where id = selected_case_id;
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
begin
    select case_id into selected_case_id
    from public.stage1_attempts_v2
    where id = p_attempt_id and status = 'completed';
    if selected_case_id is null then
        raise exception 'Only an objectively completed Stage 1 response can be presented';
    end if;

    insert into public.stage1_presentations_v2 (
        attempt_id, presentation_json, materialization_error
    ) values (
        p_attempt_id, p_presentation_json, p_materialization_error
    );

    perform public.advance_closed_cohorts_v2(selected_case_id);
    return true;
end;
$function$;

create or replace function public.authorize_stage1_v2_new_attempt(
    p_case_id uuid,
    p_reason text
)
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
    where id = p_case_id and stage1_status = 'unresolved'
    for update;
    if not found then
        raise exception 'Only the researcher can start a separate attempt for an unresolved case';
    end if;
    if nullif(btrim(p_reason), '') is null then
        raise exception 'The separate attempt requires a researcher reason';
    end if;

    select coalesce(max(attempt_number), 0) + 1 into next_number
    from public.stage1_attempts_v2 where case_id = p_case_id;
    insert into public.stage1_attempts_v2 (
        case_id, attempt_number, researcher_reason
    ) values (p_case_id, next_number, btrim(p_reason))
    returning id into new_attempt_id;
    update public.analysis_cases_v2
    set stage1_status = 'pending', unresolved_at = null
    where id = p_case_id;
    return new_attempt_id;
end;
$function$;

create or replace function public.create_analysis_cohort_v2(
    p_project_id uuid,
    p_name text,
    p_actor text default 'researcher'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_configuration_id uuid;
    new_cohort_id uuid;
begin
    select configuration_id into selected_configuration_id
    from public.active_analysis_project_configurations_v2
    where project_id = p_project_id;
    if selected_configuration_id is null then
        raise exception 'An active case-bound analysis configuration is required';
    end if;
    if nullif(btrim(p_name), '') is null then
        raise exception 'A researcher-defined cohort name is required';
    end if;

    insert into public.analysis_cohorts_v2 (
        project_id, configuration_id, name, created_by
    ) values (
        p_project_id, selected_configuration_id, btrim(p_name),
        coalesce(nullif(btrim(p_actor), ''), 'researcher')
    ) returning id into new_cohort_id;

    -- The cohort begins with every already-frozen case under the same
    -- configuration, then receives future cases only while it remains open.
    insert into public.analysis_cohort_cases_v2 (cohort_id, case_id)
    select new_cohort_id, analysis_case.id
    from public.analysis_cases_v2 as analysis_case
    where analysis_case.project_id = p_project_id
      and analysis_case.configuration_id = selected_configuration_id
    order by analysis_case.source_completed_at, analysis_case.case_number;

    return new_cohort_id;
end;
$function$;

create or replace function public.guard_analysis_cohort_membership_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if not exists (
        select 1 from public.analysis_cohorts_v2
        where id = new.cohort_id and status = 'open'
    ) then
        raise exception 'Closed cohort membership is immutable';
    end if;
    if not exists (
        select 1
        from public.analysis_cohorts_v2 as cohort
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = new.case_id
        where cohort.id = new.cohort_id
          and cohort.project_id = analysis_case.project_id
          and cohort.configuration_id = analysis_case.configuration_id
    ) then
        raise exception 'The case is outside the cohort project/configuration';
    end if;
    return new;
end;
$function$;

create trigger analysis_cohort_cases_v2_guard_insert
before insert on public.analysis_cohort_cases_v2
for each row execute function public.guard_analysis_cohort_membership_v2();

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
    corpus_cases jsonb;
    corpus_snapshot jsonb;
    corpus_hash text;
    new_run_id uuid;
begin
    select * into selected_cohort
    from public.analysis_cohorts_v2
    where id = p_cohort_id
    for update;

    if not found or selected_cohort.status = 'open' then return null; end if;

    select count(*),
        count(*) filter (where analysis_case.stage1_status = 'completed'),
        count(*) filter (where presentation.presentation_json is not null)
    into member_count, complete_count, present_count
    from public.analysis_cohort_cases_v2 as member
    join public.analysis_cases_v2 as analysis_case on analysis_case.id = member.case_id
    left join public.stage1_attempts_v2 as attempt
      on attempt.case_id = analysis_case.id and attempt.status = 'completed'
    left join public.stage1_presentations_v2 as presentation
      on presentation.attempt_id = attempt.id
    where member.cohort_id = p_cohort_id;

    if member_count = 0 or complete_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'closed', blocked_reason = null
        where id = p_cohort_id and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if present_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'blocked',
            blocked_reason = 'A completed provider response could not be projected into its explicit Stage 1 structure.'
        where id = p_cohort_id and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if exists (select 1 from public.stage2_runs_v2 where cohort_id = p_cohort_id) then
        select id into new_run_id from public.stage2_runs_v2
        where cohort_id = p_cohort_id;
        return new_run_id;
    end if;

    -- Zero-CO cases remain cohort members but contribute an empty array.
    select jsonb_agg(
        jsonb_build_object(
            'case_id', analysis_case.case_number,
            'preliminary_codes', coalesce(case_codes.preliminary_codes, '[]'::jsonb)
        ) order by analysis_case.case_number
    ) into corpus_cases
    from public.analysis_cohort_cases_v2 as member
    join public.analysis_cases_v2 as analysis_case on analysis_case.id = member.case_id
    left join (
        select inner_case.id as case_id,
            jsonb_agg(
                jsonb_build_object(
                    'code_id', code.value ->> 'id',
                    'label', code.value ->> 'label'
                ) order by code.ordinality
            ) filter (where code.value is not null) as preliminary_codes
        from public.analysis_cases_v2 as inner_case
        join public.stage1_attempts_v2 as inner_attempt
          on inner_attempt.case_id = inner_case.id and inner_attempt.status = 'completed'
        join public.stage1_presentations_v2 as inner_presentation
          on inner_presentation.attempt_id = inner_attempt.id
        left join lateral jsonb_array_elements(
            inner_presentation.presentation_json -> 'preliminary_codes'
        ) with ordinality as code(value, ordinality) on true
        group by inner_case.id
    ) as case_codes on case_codes.case_id = analysis_case.id
    where member.cohort_id = p_cohort_id;

    corpus_snapshot := jsonb_build_object(
        'cohortId', p_cohort_id,
        'cases', corpus_cases
    );
    corpus_hash := encode(
        extensions.digest(convert_to(corpus_snapshot::text, 'UTF8'), 'sha256'),
        'hex'
    );

    select * into selected_configuration
    from public.analysis_project_configurations_v2
    where id = selected_cohort.configuration_id;

    insert into public.stage2_runs_v2 (
        cohort_id, provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        p_cohort_id, selected_configuration.provider, selected_configuration.model,
        selected_configuration.reasoning_effort,
        selected_configuration.max_output_tokens,
        corpus_snapshot, corpus_hash
    ) returning id into new_run_id;

    update public.analysis_cohorts_v2
    set status = 'stage2_queued', blocked_reason = null
    where id = p_cohort_id;
    return new_run_id;
end;
$function$;

create or replace function public.advance_closed_cohorts_v2(
    p_case_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
begin
    for selected_cohort_id in
        select cohort_id from public.analysis_cohort_cases_v2
        where case_id = p_case_id
    loop
        perform public.advance_analysis_cohort_v2(selected_cohort_id);
    end loop;
end;
$function$;

create or replace function public.close_analysis_cohort_v2(
    p_cohort_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    queued_run_id uuid;
begin
    update public.analysis_cohorts_v2
    set status = 'closed', closed_at = now(), blocked_reason = null
    where id = p_cohort_id and status = 'open';
    if not found then
        raise exception 'Only an open researcher-defined cohort can be closed';
    end if;
    queued_run_id := public.advance_analysis_cohort_v2(p_cohort_id);
    return queued_run_id;
end;
$function$;

create or replace function public.claim_next_stage2_v2_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.stage2_runs_v2%rowtype;
    selected_action text;
    selected_request public.stage2_requests_v2%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended('case_bound_stage2_v2_claim', 0));
    select run.* into selected_run
    from public.stage2_runs_v2 as run
    where run.status = 'queued'
       or (run.status = 'provider_pending'
           and coalesce(run.next_poll_at, now()) <= now())
    order by case when run.status = 'queued' then 0 else 1 end,
        run.queued_at, run.id
    for update skip locked limit 1;
    if not found then return null; end if;

    selected_action := case when selected_run.status = 'queued'
        then 'submit' else 'retrieve' end;
    if selected_action = 'submit' then
        update public.stage2_runs_v2
        set status = 'processing', claimed_at = now()
        where id = selected_run.id;
        update public.analysis_cohorts_v2
        set status = 'stage2_processing'
        where id = selected_run.cohort_id;
    else
        update public.stage2_runs_v2
        set claimed_at = now(), next_poll_at = now() + interval '15 seconds'
        where id = selected_run.id;
    end if;

    select * into selected_request from public.stage2_requests_v2
    where run_id = selected_run.id;
    return jsonb_build_object(
        'action', selected_action,
        'runId', selected_run.id,
        'cohortId', selected_run.cohort_id,
        'provider', selected_run.provider,
        'model', selected_run.model,
        'reasoningEffort', selected_run.reasoning_effort,
        'maxOutputTokens', selected_run.max_output_tokens,
        'corpusSnapshotJson', selected_run.corpus_snapshot_json,
        'corpusSnapshotSha256', selected_run.corpus_snapshot_sha256,
        'providerResponseId', selected_run.provider_response_id,
        'frozenRequest', selected_request.request_json
    );
end;
$function$;

create or replace function public.freeze_stage2_v2_request(
    p_run_id uuid,
    p_provider_request_id text,
    p_request_json jsonb,
    p_request_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if not exists (
        select 1 from public.stage2_runs_v2
        where id = p_run_id and status = 'processing'
    ) then
        raise exception 'Only a processing Stage 2 run can freeze its request';
    end if;
    insert into public.stage2_requests_v2 (
        run_id, provider_request_id, request_json, request_sha256
    ) values (p_run_id, p_provider_request_id, p_request_json, p_request_sha256);
    return true;
end;
$function$;

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
begin
    if p_outcome not in (
        'provider_pending', 'completed', 'technically_incomplete', 'failed'
    ) then raise exception 'Invalid objective provider outcome'; end if;
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status in ('processing', 'provider_pending')
    for update;
    if selected_cohort_id is null then raise exception 'Stage 2 run is not active'; end if;

    if p_outcome = 'provider_pending' then
        update public.stage2_runs_v2
        set status = 'provider_pending', provider_response_id = p_provider_response_id,
            provider_status = p_provider_status,
            next_poll_at = now() + interval '15 seconds'
        where id = p_run_id;
        return true;
    end if;

    update public.stage2_runs_v2
    set status = p_outcome, provider_response_id = p_provider_response_id,
        provider_status = p_provider_status,
        provider_response_json = p_provider_response_json,
        raw_model_output_text = p_raw_model_output_text,
        incomplete_details = p_incomplete_details,
        technical_error = p_technical_error,
        next_poll_at = null, terminal_at = now()
    where id = p_run_id;

    if p_outcome <> 'completed' then
        update public.analysis_cohorts_v2
        set status = 'blocked', blocked_reason = 'Stage 2A did not technically complete.'
        where id = selected_cohort_id;
    end if;
    return true;
end;
$function$;

create or replace function public.fail_stage2_v2_run(
    p_run_id uuid,
    p_technical_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
begin
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status in ('processing', 'provider_pending')
    for update;
    if selected_cohort_id is null then return false; end if;
    update public.stage2_runs_v2
    set status = 'failed', technical_error = p_technical_error,
        terminal_at = now(), next_poll_at = null
    where id = p_run_id;
    update public.analysis_cohorts_v2
    set status = 'blocked', blocked_reason = 'Stage 2A failed technically.'
    where id = selected_cohort_id;
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
begin
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status = 'completed';
    if selected_cohort_id is null then
        raise exception 'Only an objectively completed Stage 2 response can be presented';
    end if;
    insert into public.stage2_presentations_v2 (
        run_id, presentation_json, materialization_error
    ) values (p_run_id, p_presentation_json, p_materialization_error);
    update public.analysis_cohorts_v2
    set status = case when p_presentation_json is not null then 'completed' else 'blocked' end,
        blocked_reason = case when p_presentation_json is null
            then 'The completed Stage 2A response could not be projected.' else null end
    where id = selected_cohort_id;
    return true;
end;
$function$;

-- New public-schema objects are server-only. RLS plus explicit grants prevent
-- browser roles from reading participant source or provider records.
alter table public.analysis_project_configurations_v2 enable row level security;
alter table public.active_analysis_project_configurations_v2 enable row level security;
alter table public.analysis_cases_v2 enable row level security;
alter table public.analysis_case_sessions_v2 enable row level security;
alter table public.stage1_source_snapshots_v2 enable row level security;
alter table public.stage1_attempts_v2 enable row level security;
alter table public.stage1_requests_v2 enable row level security;
alter table public.stage1_presentations_v2 enable row level security;
alter table public.analysis_cohorts_v2 enable row level security;
alter table public.analysis_cohort_cases_v2 enable row level security;
alter table public.stage2_runs_v2 enable row level security;
alter table public.stage2_requests_v2 enable row level security;
alter table public.stage2_presentations_v2 enable row level security;

revoke all on table
    public.analysis_project_configurations_v2,
    public.active_analysis_project_configurations_v2,
    public.analysis_cases_v2,
    public.analysis_case_sessions_v2,
    public.stage1_source_snapshots_v2,
    public.stage1_attempts_v2,
    public.stage1_requests_v2,
    public.stage1_presentations_v2,
    public.analysis_cohorts_v2,
    public.analysis_cohort_cases_v2,
    public.stage2_runs_v2,
    public.stage2_requests_v2,
    public.stage2_presentations_v2
from public, anon, authenticated;

grant select, insert, update, delete on table
    public.analysis_project_configurations_v2,
    public.active_analysis_project_configurations_v2,
    public.analysis_cases_v2,
    public.analysis_case_sessions_v2,
    public.stage1_source_snapshots_v2,
    public.stage1_attempts_v2,
    public.stage1_requests_v2,
    public.stage1_presentations_v2,
    public.analysis_cohorts_v2,
    public.analysis_cohort_cases_v2,
    public.stage2_runs_v2,
    public.stage2_requests_v2,
    public.stage2_presentations_v2
to service_role;

revoke all on sequence public.analysis_case_number_v2_seq
from public, anon, authenticated;
grant usage, select on sequence public.analysis_case_number_v2_seq to service_role;

revoke all on function public.reject_analysis_v2_mutation() from public, anon, authenticated, service_role;
revoke all on function public.protect_terminal_stage1_v2() from public, anon, authenticated, service_role;
revoke all on function public.protect_terminal_stage2_v2() from public, anon, authenticated, service_role;
revoke all on function public.protect_completed_analysis_case_v2() from public, anon, authenticated, service_role;
revoke all on function public.guard_analysis_cohort_membership_v2() from public, anon, authenticated, service_role;
revoke all on function public.freeze_analysis_case_after_completion_v2() from public, anon, authenticated, service_role;
revoke all on function public.save_analysis_project_configuration_v2(uuid,text,text,text,integer,text,text,jsonb,text,text) from public, anon, authenticated, service_role;
revoke all on function public.try_freeze_analysis_case_v2(text) from public, anon, authenticated, service_role;
revoke all on function public.claim_next_stage1_v2_attempt() from public, anon, authenticated, service_role;
revoke all on function public.freeze_stage1_v2_request(uuid,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.record_stage1_v2_provider_response(uuid,text,text,text,jsonb,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.fail_stage1_v2_attempt(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.save_stage1_v2_presentation(uuid,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.authorize_stage1_v2_new_attempt(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.create_analysis_cohort_v2(uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.advance_analysis_cohort_v2(uuid) from public, anon, authenticated, service_role;
revoke all on function public.advance_closed_cohorts_v2(uuid) from public, anon, authenticated, service_role;
revoke all on function public.close_analysis_cohort_v2(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_next_stage2_v2_run() from public, anon, authenticated, service_role;
revoke all on function public.freeze_stage2_v2_request(uuid,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.record_stage2_v2_provider_response(uuid,text,text,text,jsonb,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.fail_stage2_v2_run(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.save_stage2_v2_presentation(uuid,jsonb,text) from public, anon, authenticated, service_role;

grant execute on function public.save_analysis_project_configuration_v2(uuid,text,text,text,integer,text,text,jsonb,text,text) to service_role;
grant execute on function public.try_freeze_analysis_case_v2(text) to service_role;
grant execute on function public.claim_next_stage1_v2_attempt() to service_role;
grant execute on function public.freeze_stage1_v2_request(uuid,text,jsonb,text) to service_role;
grant execute on function public.record_stage1_v2_provider_response(uuid,text,text,text,jsonb,text,jsonb,text) to service_role;
grant execute on function public.fail_stage1_v2_attempt(uuid,text) to service_role;
grant execute on function public.save_stage1_v2_presentation(uuid,jsonb,text) to service_role;
grant execute on function public.authorize_stage1_v2_new_attempt(uuid,text) to service_role;
grant execute on function public.create_analysis_cohort_v2(uuid,text,text) to service_role;
grant execute on function public.close_analysis_cohort_v2(uuid) to service_role;
grant execute on function public.claim_next_stage2_v2_run() to service_role;
grant execute on function public.freeze_stage2_v2_request(uuid,text,jsonb,text) to service_role;
grant execute on function public.record_stage2_v2_provider_response(uuid,text,text,text,jsonb,text,jsonb,text) to service_role;
grant execute on function public.fail_stage2_v2_run(uuid,text) to service_role;
grant execute on function public.save_stage2_v2_presentation(uuid,jsonb,text) to service_role;

-- A completed case may span resumed sessions, so translation readiness must
-- cover that same complete chain before Stage 1 can freeze.
create or replace function public.finish_transcript_translation(
    p_session_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    translation_complete boolean;
begin
    select not exists (
        with recursive session_chain as (
            select session.session_id, session.continuation_of_session_id
            from public.interview_sessions as session
            where session.session_id = p_session_id
            union all
            select parent.session_id, parent.continuation_of_session_id
            from public.interview_sessions as parent
            join session_chain as child
              on parent.session_id = child.continuation_of_session_id
        )
        select 1
        from public.interview_messages as message
        join session_chain on session_chain.session_id = message."Session"
        where lower(coalesce(message."Language", '')) <> 'en'
          and nullif(btrim(message."EnglishTranslation"), '') is null
    ) into translation_complete;

    update public.automatic_transcript_translation_jobs
    set status = case when translation_complete then 'completed' else 'pending' end,
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = case when translation_complete then now() else null end,
        last_error = null,
        updated_at = now()
    where session_id = p_session_id;
    return translation_complete;
end;
$function$;
