comment on table public.case_code_map is
    'Private stable mapping from every interview session, complete or incomplete, to a researcher-facing case number such as P0001-S01.';

insert into public.participant_code_map (participant_id)
select distinct session.participant_id
from public.interview_sessions as session
where nullif(btrim(session.participant_id), '') is not null
on conflict (participant_id) do nothing;

with existing_maximum as (
    select
        participant_id,
        max(session_number) as maximum_session_number
    from public.case_code_map
    group by participant_id
), unmapped as (
    select
        session.session_id,
        session.participant_id,
        code.participant_code,
        coalesce(existing.maximum_session_number, 0)
            + row_number() over (
                partition by session.participant_id
                order by session.created_at, session.session_id
            ) as session_number
    from public.interview_sessions as session
    join public.participant_code_map as code
      on code.participant_id = session.participant_id
    left join public.case_code_map as mapped
      on mapped.session_id = session.session_id
    left join existing_maximum as existing
      on existing.participant_id = session.participant_id
    where mapped.session_id is null
)
insert into public.case_code_map (
    session_id,
    participant_id,
    participant_code,
    session_number
)
select
    session_id,
    participant_id,
    participant_code,
    session_number
from unmapped
order by participant_code, session_number;

create or replace function public.ensure_session_case_code_mapping()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    stored_participant_code text;
    next_session_number integer;
begin
    if nullif(btrim(new.participant_id), '') is null then
        return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.participant_id, 0));

    insert into public.participant_code_map (participant_id)
    values (new.participant_id)
    on conflict (participant_id) do nothing;

    select participant_code
    into stored_participant_code
    from public.participant_code_map
    where participant_id = new.participant_id;

    select coalesce(max(session_number), 0) + 1
    into next_session_number
    from public.case_code_map
    where participant_id = new.participant_id;

    insert into public.case_code_map (
        session_id,
        participant_id,
        participant_code,
        session_number
    ) values (
        new.session_id,
        new.participant_id,
        stored_participant_code,
        next_session_number
    )
    on conflict (session_id) do nothing;

    return new;
end;
$$;

revoke all on function public.ensure_session_case_code_mapping()
from public, anon, authenticated, service_role;

drop trigger if exists interview_sessions_ensure_case_code
on public.interview_sessions;

create trigger interview_sessions_ensure_case_code
after insert or update of participant_id
on public.interview_sessions
for each row
execute function public.ensure_session_case_code_mapping();
