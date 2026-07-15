create table public.interview_sessions (
    session_id text primary key,
    participant_id text not null,
    language text not null,
    completed boolean not null default false,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint interview_sessions_session_id_not_blank
        check (btrim(session_id) <> ''),
    constraint interview_sessions_completion_consistent
        check (
            (completed = false and completed_at is null)
            or
            (completed = true and completed_at is not null)
        )
);

comment on table public.interview_sessions is
    'Machine-readable lifecycle state for participant interview sessions. Historical sessions are not backfilled.';

comment on column public.interview_sessions.completed is
    'Monotonic explicit completion state; false is never inferred from message content or activity.';

alter table public.interview_sessions enable row level security;

revoke all on table public.interview_sessions
from public, anon, authenticated;

grant select, insert, update on table public.interview_sessions
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
        updated_at = now()
    where session_id = p_session_id
      and completed = false;

    select exists (
        select 1
        from public.interview_sessions
        where session_id = p_session_id
          and completed = true
    )
    into session_exists;

    return session_exists;
end;
$$;

revoke all on function public.complete_interview_session(text)
from public, anon, authenticated;

grant execute on function public.complete_interview_session(text)
to service_role;
