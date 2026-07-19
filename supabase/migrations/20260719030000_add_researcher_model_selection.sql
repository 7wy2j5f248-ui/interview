alter table public.research_designs
add column if not exists interview_model text;

update public.research_designs
set interview_model = 'gpt-5.1'
where interview_model is null or btrim(interview_model) = '';

alter table public.research_designs
alter column interview_model set default 'gpt-5.1';

alter table public.research_designs
alter column interview_model set not null;

alter table public.research_designs
add constraint research_designs_interview_model_valid
check (interview_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

comment on column public.research_designs.interview_model is
    'Exact OpenAI model identifier selected by the researcher for interviews using this design.';

alter table public.interview_sessions
add column if not exists interview_model text;

update public.interview_sessions
set interview_model = 'gpt-5.1'
where interview_model is null or btrim(interview_model) = '';

alter table public.interview_sessions
alter column interview_model set default 'gpt-5.1';

alter table public.interview_sessions
alter column interview_model set not null;

alter table public.interview_sessions
add constraint interview_sessions_interview_model_valid
check (interview_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

comment on column public.interview_sessions.interview_model is
    'Interview model frozen when the session is first created; active sessions retain it if the research design later changes.';

create or replace function public.prepare_interview_session_with_model(
    p_session_id text,
    p_participant_id text,
    p_language text,
    p_interview_model text,
    p_request_at timestamptz,
    p_timeout_minutes integer
)
returns table (
    accepted_session_id text,
    previous_session_id text,
    expired boolean,
    created boolean,
    timeout_at timestamptz,
    selected_interview_model text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    existing_session public.interview_sessions%rowtype;
    new_session_id text;
    calculated_timeout_at timestamptz;
    normalized_model text;
begin
    normalized_model := btrim(p_interview_model);

    if nullif(btrim(p_session_id), '') is null
       or nullif(btrim(p_participant_id), '') is null
       or nullif(btrim(p_language), '') is null
       or nullif(normalized_model, '') is null
       or normalized_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or p_request_at is null
       or p_timeout_minutes is null
       or p_timeout_minutes < 1
       or p_timeout_minutes > 10080 then
        raise exception 'Invalid interview session preparation request.';
    end if;

    select session.*
    into existing_session
    from public.interview_sessions as session
    where session.session_id = btrim(p_session_id)
    for update;

    if not found then
        insert into public.interview_sessions (
            session_id,
            participant_id,
            language,
            interview_model,
            completed,
            completed_at,
            created_at,
            updated_at,
            last_activity_at,
            session_status,
            inactivity_timeout_minutes
        ) values (
            btrim(p_session_id),
            btrim(p_participant_id),
            btrim(p_language),
            normalized_model,
            false,
            null,
            p_request_at,
            p_request_at,
            null,
            'active',
            p_timeout_minutes
        );

        return query select
            btrim(p_session_id),
            null::text,
            false,
            true,
            null::timestamptz,
            normalized_model;
        return;
    end if;

    if existing_session.participant_id <> btrim(p_participant_id) then
        raise exception 'Interview session participant does not match.';
    end if;

    calculated_timeout_at := coalesce(
        existing_session.timed_out_at,
        existing_session.ended_at,
        existing_session.last_activity_at
            + make_interval(mins => p_timeout_minutes)
    );

    if existing_session.session_status in ('timed_out', 'abandoned')
       or (
            existing_session.last_activity_at is not null
            and p_request_at > existing_session.last_activity_at
                + make_interval(mins => p_timeout_minutes)
       ) then
        if not existing_session.completed
           and existing_session.session_status = 'active' then
            calculated_timeout_at := existing_session.last_activity_at
                + make_interval(mins => p_timeout_minutes);

            update public.interview_sessions
            set
                session_status = 'timed_out',
                end_reason = 'inactivity_timeout',
                timed_out_at = calculated_timeout_at,
                ended_at = calculated_timeout_at
            where session_id = existing_session.session_id;
        end if;

        new_session_id := 'S'
            || floor(extract(epoch from p_request_at) * 1000)::bigint::text
            || '-'
            || replace(gen_random_uuid()::text, '-', '');

        insert into public.interview_sessions (
            session_id,
            participant_id,
            language,
            interview_model,
            completed,
            completed_at,
            created_at,
            updated_at,
            last_activity_at,
            session_status,
            continuation_of_session_id,
            inactivity_timeout_minutes
        ) values (
            new_session_id,
            btrim(p_participant_id),
            btrim(p_language),
            normalized_model,
            false,
            null,
            p_request_at,
            p_request_at,
            null,
            'active',
            existing_session.session_id,
            p_timeout_minutes
        );

        return query select
            new_session_id,
            existing_session.session_id,
            true,
            true,
            calculated_timeout_at,
            normalized_model;
        return;
    end if;

    update public.interview_sessions
    set inactivity_timeout_minutes = p_timeout_minutes
    where session_id = existing_session.session_id;

    return query select
        existing_session.session_id,
        null::text,
        false,
        false,
        null::timestamptz,
        existing_session.interview_model;
end;
$$;

revoke all on function public.prepare_interview_session_with_model(
    text,
    text,
    text,
    text,
    timestamptz,
    integer
)
from public, anon, authenticated, service_role;

grant execute on function public.prepare_interview_session_with_model(
    text,
    text,
    text,
    text,
    timestamptz,
    integer
)
to service_role;
