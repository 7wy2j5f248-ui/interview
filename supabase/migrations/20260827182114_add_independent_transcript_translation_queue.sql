create table public.automatic_transcript_translation_jobs (
    session_id text primary key
        references public.interview_sessions(session_id) on delete restrict,
    source_completed_at timestamptz not null,
    status text not null default 'pending',
    attempt_count integer not null default 0,
    queued_at timestamptz not null default now(),
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    next_retry_at timestamptz,
    completed_at timestamptz,
    last_error text,
    updated_at timestamptz not null default now(),
    constraint automatic_transcript_translation_status_valid
        check (status in ('pending', 'processing', 'completed', 'failed')),
    constraint automatic_transcript_translation_attempts_nonnegative
        check (attempt_count >= 0)
);

comment on table public.automatic_transcript_translation_jobs is
    'Durable transcript translation work, independent from individual case analysis.';

create index automatic_transcript_translation_fifo_idx
on public.automatic_transcript_translation_jobs (
    status,
    source_completed_at,
    queued_at,
    session_id
);

create or replace function public.enqueue_completed_transcript_translation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.completed is not true or new.completed_at is null then
        return new;
    end if;

    if exists (
        select 1
        from public.interview_messages as message
        where message."Session" = new.session_id
          and lower(coalesce(message."Language", '')) <> 'en'
          and nullif(btrim(message."EnglishTranslation"), '') is null
    ) then
        insert into public.automatic_transcript_translation_jobs (
            session_id,
            source_completed_at,
            queued_at
        ) values (
            new.session_id,
            new.completed_at,
            new.completed_at
        )
        on conflict (session_id) do update
        set
            status = case
                when automatic_transcript_translation_jobs.status = 'completed'
                    then 'pending'
                else automatic_transcript_translation_jobs.status
            end,
            completed_at = null,
            updated_at = now();
    end if;

    return new;
end;
$function$;

revoke all on function public.enqueue_completed_transcript_translation()
from public, anon, authenticated;

create trigger interview_sessions_enqueue_transcript_translation
after insert or update of completed, completed_at
on public.interview_sessions
for each row
when (new.completed = true)
execute function public.enqueue_completed_transcript_translation();

insert into public.automatic_transcript_translation_jobs (
    session_id,
    source_completed_at,
    queued_at
)
select
    session.session_id,
    session.completed_at,
    session.completed_at
from public.interview_sessions as session
join public.automatic_case_analysis_jobs as analysis_job
  on analysis_job.session_id = session.session_id
 and analysis_job.archived_at is null
where session.completed = true
  and session.completed_at is not null
  and exists (
      select 1
      from public.interview_messages as message
      where message."Session" = session.session_id
        and lower(coalesce(message."Language", '')) <> 'en'
        and nullif(btrim(message."EnglishTranslation"), '') is null
  )
order by session.completed_at, session.session_id
on conflict (session_id) do nothing;

create or replace function public.claim_transcript_translation_session(
    p_session_id text
)
returns table (
    session_id text,
    source_completed_at timestamptz,
    attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    return query
    update public.automatic_transcript_translation_jobs as job
    set
        status = 'processing',
        attempt_count = job.attempt_count + 1,
        claimed_at = now(),
        lease_expires_at = now() + interval '10 minutes',
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    where job.session_id = p_session_id
      and (
          job.status = 'pending'
          or (
              job.status = 'failed'
              and job.attempt_count < 8
              and coalesce(job.next_retry_at, now()) <= now()
          )
          or (
              job.status = 'processing'
              and coalesce(job.lease_expires_at, now()) <= now()
          )
      )
    returning job.session_id, job.source_completed_at, job.attempt_count;
end;
$function$;

create or replace function public.claim_next_transcript_translation()
returns table (
    session_id text,
    source_completed_at timestamptz,
    attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    perform pg_advisory_xact_lock(hashtextextended(
        'automatic_transcript_translation_fifo',
        0
    ));

    return query
    with candidate as (
        select job.session_id
        from public.automatic_transcript_translation_jobs as job
        join public.automatic_case_analysis_jobs as analysis_job
          on analysis_job.session_id = job.session_id
         and analysis_job.archived_at is null
        where (
            job.status = 'pending'
            or (
                job.status = 'failed'
                and job.attempt_count < 8
                and coalesce(job.next_retry_at, now()) <= now()
            )
            or (
                job.status = 'processing'
                and coalesce(job.lease_expires_at, now()) <= now()
            )
        )
          and not exists (
              select 1
              from public.automatic_transcript_translation_jobs as active_job
              where active_job.status = 'processing'
                and coalesce(active_job.lease_expires_at, now()) > now()
          )
        order by job.source_completed_at, job.queued_at, job.session_id
        for update of job
        limit 1
    )
    update public.automatic_transcript_translation_jobs as job
    set
        status = 'processing',
        attempt_count = job.attempt_count + 1,
        claimed_at = now(),
        lease_expires_at = now() + interval '10 minutes',
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    from candidate
    where job.session_id = candidate.session_id
    returning job.session_id, job.source_completed_at, job.attempt_count;
end;
$function$;

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
        select 1
        from public.interview_messages as message
        where message."Session" = p_session_id
          and lower(coalesce(message."Language", '')) <> 'en'
          and nullif(btrim(message."EnglishTranslation"), '') is null
    ) into translation_complete;

    update public.automatic_transcript_translation_jobs
    set
        status = case when translation_complete then 'completed' else 'pending' end,
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

create or replace function public.fail_transcript_translation(
    p_session_id text,
    p_error text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    update public.automatic_transcript_translation_jobs
    set
        status = 'failed',
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = now() + interval '1 minute',
        completed_at = null,
        last_error = left(coalesce(p_error, 'Unknown translation error.'), 2000),
        updated_at = now()
    where session_id = p_session_id;
end;
$function$;

alter table public.automatic_transcript_translation_jobs enable row level security;

revoke all on table public.automatic_transcript_translation_jobs
from public, anon, authenticated, service_role;
grant select, insert, update on table public.automatic_transcript_translation_jobs
to service_role;

revoke all on function public.claim_transcript_translation_session(text)
from public, anon, authenticated;
revoke all on function public.claim_next_transcript_translation()
from public, anon, authenticated;
revoke all on function public.finish_transcript_translation(text)
from public, anon, authenticated;
revoke all on function public.fail_transcript_translation(text, text)
from public, anon, authenticated;

grant execute on function public.claim_transcript_translation_session(text)
to service_role;
grant execute on function public.claim_next_transcript_translation()
to service_role;
grant execute on function public.finish_transcript_translation(text)
to service_role;
grant execute on function public.fail_transcript_translation(text, text)
to service_role;
