alter table public.interview_sessions
add column last_activity_at timestamptz;

alter table public.interview_sessions
add column ended_at timestamptz;

alter table public.interview_sessions
add column session_status text not null default 'active';

alter table public.interview_sessions
add column end_reason text;

alter table public.interview_sessions
add column timed_out_at timestamptz;

alter table public.interview_sessions
add column continuation_of_session_id text;

alter table public.interview_sessions
add column inactivity_timeout_minutes integer not null default 30;

alter table public.interview_sessions
add column active_duration_ms bigint not null default 0;

alter table public.interview_sessions
add column elapsed_duration_ms bigint not null default 0;

alter table public.interview_sessions
add column inactivity_break_count integer not null default 0;

alter table public.interview_sessions
add column excluded_idle_duration_ms bigint not null default 0;

alter table public.interview_sessions
add column inactivity_breaks jsonb not null default '[]'::jsonb;

alter table public.interview_sessions
add column duration_calculated_at timestamptz;

comment on column public.interview_sessions.last_activity_at is
    'Most recent server-accepted participant or interviewer message activity for inactivity enforcement.';

comment on column public.interview_sessions.inactivity_timeout_minutes is
    'Backend inactivity threshold used for this session and its persisted duration calculation.';

comment on column public.interview_sessions.active_duration_ms is
    'Sum of consecutive-message intervals at or below the stored inactivity threshold.';

comment on column public.interview_sessions.elapsed_duration_ms is
    'Raw elapsed span from the first to last valid message timestamp.';

comment on column public.interview_sessions.inactivity_breaks is
    'Ordered audit record of inter-message gaps excluded from active interview duration.';

comment on column public.interview_sessions.continuation_of_session_id is
    'Prior session that expired or ended before this distinct continuation session began.';

with ordered_messages as (
    select
        btrim(message."Session") as session_id,
        message."Timestamp" as message_at,
        lag(message."Timestamp") over (
            partition by btrim(message."Session")
            order by message."Timestamp", message.id
        ) as previous_message_at
    from public.interview_messages as message
    where nullif(btrim(message."Session"), '') is not null
      and message."Timestamp" is not null
),
message_gaps as (
    select
        session_id,
        message_at,
        previous_message_at,
        extract(epoch from (message_at - previous_message_at)) * 1000
            as gap_ms
    from ordered_messages
),
session_metrics as (
    select
        session_id,
        min(message_at) as first_message_at,
        max(message_at) as last_message_at,
        round(
            extract(epoch from (max(message_at) - min(message_at))) * 1000
        )::bigint as elapsed_duration_ms,
        round(coalesce(sum(
            case
                when previous_message_at is not null
                 and gap_ms <= 30 * 60 * 1000
                    then gap_ms
                else 0
            end
        ), 0))::bigint as active_duration_ms,
        count(*) filter (
            where previous_message_at is not null
              and gap_ms > 30 * 60 * 1000
        )::integer as inactivity_break_count,
        round(coalesce(sum(
            case
                when previous_message_at is not null
                 and gap_ms > 30 * 60 * 1000
                    then gap_ms
                else 0
            end
        ), 0))::bigint as excluded_idle_duration_ms,
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'previous_message_at', previous_message_at,
                    'next_message_at', message_at,
                    'timeout_at',
                        previous_message_at + interval '30 minutes',
                    'duration_ms', round(gap_ms)::bigint,
                    'threshold_minutes', 30
                ) order by message_at
            ) filter (
                where previous_message_at is not null
                  and gap_ms > 30 * 60 * 1000
            ),
            '[]'::jsonb
        ) as inactivity_breaks,
        min(previous_message_at + interval '30 minutes') filter (
            where previous_message_at is not null
              and gap_ms > 30 * 60 * 1000
        ) as first_timeout_at
    from message_gaps
    group by session_id
)
update public.interview_sessions as session
set
    last_activity_at = metrics.last_message_at,
    inactivity_timeout_minutes = 30,
    active_duration_ms = metrics.active_duration_ms,
    elapsed_duration_ms = metrics.elapsed_duration_ms,
    inactivity_break_count = metrics.inactivity_break_count,
    excluded_idle_duration_ms = metrics.excluded_idle_duration_ms,
    inactivity_breaks = metrics.inactivity_breaks,
    duration_calculated_at = now(),
    session_status = case
        when session.completed then 'completed'
        when metrics.inactivity_break_count > 0 then 'timed_out'
        else 'active'
    end,
    end_reason = case
        when session.completed then 'final_question_answered'
        when metrics.inactivity_break_count > 0 then 'inactivity_timeout'
        else null
    end,
    timed_out_at = case
        when not session.completed and metrics.inactivity_break_count > 0
            then metrics.first_timeout_at
        else null
    end,
    ended_at = case
        when session.completed then session.completed_at
        when metrics.inactivity_break_count > 0 then metrics.first_timeout_at
        else null
    end
from session_metrics as metrics
where session.session_id = metrics.session_id;

update public.interview_sessions
set
    session_status = 'completed',
    end_reason = 'final_question_answered',
    ended_at = completed_at,
    timed_out_at = null,
    last_activity_at = coalesce(last_activity_at, completed_at, created_at),
    duration_calculated_at = coalesce(duration_calculated_at, now())
where completed;

update public.interview_sessions
set last_activity_at = coalesce(last_activity_at, created_at)
where last_activity_at is null;

alter table public.interview_sessions
add constraint interview_sessions_status_valid
check (session_status in ('active', 'completed', 'timed_out', 'abandoned'));

alter table public.interview_sessions
add constraint interview_sessions_end_reason_valid
check (
    end_reason is null
    or end_reason in (
        'final_question_answered',
        'inactivity_timeout',
        'participant_exit',
        'researcher_closed'
    )
);

alter table public.interview_sessions
add constraint interview_sessions_timeout_minutes_valid
check (inactivity_timeout_minutes between 1 and 10080);

alter table public.interview_sessions
add constraint interview_sessions_duration_values_valid
check (
    active_duration_ms >= 0
    and elapsed_duration_ms >= 0
    and inactivity_break_count >= 0
    and excluded_idle_duration_ms >= 0
    and active_duration_ms <= elapsed_duration_ms
    and excluded_idle_duration_ms <= elapsed_duration_ms
);

alter table public.interview_sessions
add constraint interview_sessions_inactivity_breaks_array
check (jsonb_typeof(inactivity_breaks) = 'array');

alter table public.interview_sessions
add constraint interview_sessions_lifecycle_consistent
check (
    (
        session_status = 'active'
        and not completed
        and ended_at is null
        and end_reason is null
        and timed_out_at is null
    )
    or (
        session_status = 'completed'
        and completed
        and completed_at is not null
        and ended_at is not null
        and end_reason = 'final_question_answered'
        and timed_out_at is null
    )
    or (
        session_status = 'timed_out'
        and not completed
        and completed_at is null
        and ended_at is not null
        and timed_out_at is not null
        and end_reason = 'inactivity_timeout'
    )
    or (
        session_status = 'abandoned'
        and not completed
        and completed_at is null
        and ended_at is not null
        and timed_out_at is null
        and end_reason in ('participant_exit', 'researcher_closed')
    )
);

alter table public.interview_sessions
add constraint interview_sessions_continuation_fkey
foreign key (continuation_of_session_id)
references public.interview_sessions(session_id)
on update cascade
on delete restrict;

alter table public.interview_sessions
add constraint interview_sessions_continuation_not_self
check (
    continuation_of_session_id is null
    or continuation_of_session_id <> session_id
);

create index interview_sessions_status_idx
on public.interview_sessions(session_status);

create index interview_sessions_last_activity_idx
on public.interview_sessions(last_activity_at);

create index interview_sessions_continuation_idx
on public.interview_sessions(continuation_of_session_id)
where continuation_of_session_id is not null;

create or replace function public.refresh_interview_session_metrics(
    p_session_id text,
    p_timeout_minutes integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    updated_count integer;
begin
    if p_timeout_minutes is null
       or p_timeout_minutes < 1
       or p_timeout_minutes > 10080 then
        raise exception 'Invalid interview inactivity timeout.';
    end if;

    with ordered_messages as (
        select
            message."Timestamp" as message_at,
            lag(message."Timestamp") over (
                order by message."Timestamp", message.id
            ) as previous_message_at
        from public.interview_messages as message
        where btrim(message."Session") = btrim(p_session_id)
          and message."Timestamp" is not null
    ),
    message_gaps as (
        select
            message_at,
            previous_message_at,
            extract(epoch from (message_at - previous_message_at)) * 1000
                as gap_ms
        from ordered_messages
    ),
    metrics as (
        select
            min(message_at) as first_message_at,
            max(message_at) as last_message_at,
            round(
                extract(epoch from (max(message_at) - min(message_at))) * 1000
            )::bigint as elapsed_duration_ms,
            round(coalesce(sum(
                case
                    when previous_message_at is not null
                     and gap_ms <= p_timeout_minutes * 60 * 1000
                        then gap_ms
                    else 0
                end
            ), 0))::bigint as active_duration_ms,
            count(*) filter (
                where previous_message_at is not null
                  and gap_ms > p_timeout_minutes * 60 * 1000
            )::integer as inactivity_break_count,
            round(coalesce(sum(
                case
                    when previous_message_at is not null
                     and gap_ms > p_timeout_minutes * 60 * 1000
                        then gap_ms
                    else 0
                end
            ), 0))::bigint as excluded_idle_duration_ms,
            coalesce(
                jsonb_agg(
                    jsonb_build_object(
                        'previous_message_at', previous_message_at,
                        'next_message_at', message_at,
                        'timeout_at', previous_message_at
                            + make_interval(mins => p_timeout_minutes),
                        'duration_ms', round(gap_ms)::bigint,
                        'threshold_minutes', p_timeout_minutes
                    ) order by message_at
                ) filter (
                    where previous_message_at is not null
                      and gap_ms > p_timeout_minutes * 60 * 1000
                ),
                '[]'::jsonb
            ) as inactivity_breaks
        from message_gaps
    )
    update public.interview_sessions as session
    set
        last_activity_at = metrics.last_message_at,
        inactivity_timeout_minutes = p_timeout_minutes,
        active_duration_ms = metrics.active_duration_ms,
        elapsed_duration_ms = metrics.elapsed_duration_ms,
        inactivity_break_count = metrics.inactivity_break_count,
        excluded_idle_duration_ms = metrics.excluded_idle_duration_ms,
        inactivity_breaks = metrics.inactivity_breaks,
        duration_calculated_at = now()
    from metrics
    where session.session_id = btrim(p_session_id)
      and metrics.last_message_at is not null;

    get diagnostics updated_count = row_count;
    return updated_count = 1;
end;
$$;

revoke all on function public.refresh_interview_session_metrics(text, integer)
from public, anon, authenticated, service_role;

grant execute on function public.refresh_interview_session_metrics(text, integer)
to service_role;

create or replace function public.prepare_interview_session(
    p_session_id text,
    p_participant_id text,
    p_language text,
    p_request_at timestamptz,
    p_timeout_minutes integer
)
returns table (
    accepted_session_id text,
    previous_session_id text,
    expired boolean,
    created boolean,
    timeout_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    existing_session public.interview_sessions%rowtype;
    new_session_id text;
    calculated_timeout_at timestamptz;
begin
    if nullif(btrim(p_session_id), '') is null
       or nullif(btrim(p_participant_id), '') is null
       or nullif(btrim(p_language), '') is null
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
            null::timestamptz;
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
            calculated_timeout_at;
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
        null::timestamptz;
end;
$$;

revoke all on function public.prepare_interview_session(
    text,
    text,
    text,
    timestamptz,
    integer
)
from public, anon, authenticated, service_role;

grant execute on function public.prepare_interview_session(
    text,
    text,
    text,
    timestamptz,
    integer
)
to service_role;

create or replace function public.complete_interview_session(
    p_session_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    session_exists boolean;
begin
    update public.interview_sessions
    set
        completed = true,
        completed_at = coalesce(completed_at, now()),
        session_status = 'completed',
        end_reason = 'final_question_answered',
        ended_at = coalesce(completed_at, now()),
        timed_out_at = null,
        updated_at = now()
    where session_id = p_session_id
      and completed = false;

    select exists (
        select 1
        from public.interview_sessions
        where session_id = p_session_id
          and completed = true
          and session_status = 'completed'
    )
    into session_exists;

    return session_exists;
end;
$$;

revoke all on function public.complete_interview_session(text)
from public, anon, authenticated, service_role;

grant execute on function public.complete_interview_session(text)
to service_role;

alter table public.interview_sessions enable row level security;

revoke all on table public.interview_sessions
from public, anon, authenticated, service_role;

grant select, insert, update on table public.interview_sessions
to service_role;
