alter table public.automatic_case_analysis_jobs
add column archived_at timestamptz,
add column archived_by text,
add column archive_note text;

alter table public.automatic_case_analysis_jobs
add constraint automatic_case_analysis_jobs_archived_by_not_blank
check (archived_by is null or btrim(archived_by) <> ''),
add constraint automatic_case_analysis_jobs_archive_note_not_blank
check (archive_note is null or btrim(archive_note) <> '');

comment on column public.automatic_case_analysis_jobs.archived_at is
    'Researcher-controlled removal from active analysis. Archived cases retain transcripts, reports, and lineage.';
comment on column public.automatic_case_analysis_jobs.archived_by is
    'Authenticated application actor that archived the case.';
comment on column public.automatic_case_analysis_jobs.archive_note is
    'Optional researcher note explaining the archive decision.';

create index automatic_case_analysis_jobs_active_scope_idx
on public.automatic_case_analysis_jobs (
    source_completed_at,
    queued_at,
    session_id
)
where archived_at is null;

create index automatic_case_analysis_jobs_archive_scope_idx
on public.automatic_case_analysis_jobs (
    archived_at desc,
    source_completed_at,
    session_id
)
where archived_at is not null;

create table public.automatic_case_analysis_archive_events (
    id bigint generated always as identity primary key,
    session_id text not null
        references public.automatic_case_analysis_jobs(session_id)
        on delete restrict,
    action text not null
        check (action in ('archived', 'restored')),
    actor text not null
        check (btrim(actor) <> ''),
    note text,
    created_at timestamptz not null default now(),
    constraint automatic_case_archive_events_note_not_blank
        check (note is null or btrim(note) <> '')
);

comment on table public.automatic_case_analysis_archive_events is
    'Append-only audit history of researcher archive and restore decisions.';

create index automatic_case_archive_events_session_idx
on public.automatic_case_analysis_archive_events (
    session_id,
    created_at desc,
    id desc
);

alter table public.automatic_case_analysis_archive_events
enable row level security;

revoke all on table public.automatic_case_analysis_archive_events
from public, anon, authenticated, service_role;
revoke all on sequence public.automatic_case_analysis_archive_events_id_seq
from public, anon, authenticated, service_role;
grant select, insert on table public.automatic_case_analysis_archive_events
to service_role;
grant usage, select on sequence public.automatic_case_analysis_archive_events_id_seq
to service_role;

create or replace function public.set_automatic_case_archive(
    p_session_id text,
    p_action text,
    p_note text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    changed_session_id text;
    normalized_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if p_action not in ('archive', 'restore') then
        raise exception 'Archive action must be archive or restore.';
    end if;

    if p_action = 'archive' then
        update public.automatic_case_analysis_jobs
        set
            archived_at = now(),
            archived_by = 'researcher_dashboard',
            archive_note = normalized_note,
            updated_at = now()
        where session_id = p_session_id
          and status = 'completed'
          and archived_at is null
        returning session_id into changed_session_id;
    else
        update public.automatic_case_analysis_jobs
        set
            archived_at = null,
            archived_by = null,
            archive_note = null,
            updated_at = now()
        where session_id = p_session_id
          and archived_at is not null
        returning session_id into changed_session_id;
    end if;

    if changed_session_id is null then
        return false;
    end if;

    insert into public.automatic_case_analysis_archive_events (
        session_id,
        action,
        actor,
        note
    ) values (
        changed_session_id,
        case when p_action = 'archive' then 'archived' else 'restored' end,
        'researcher_dashboard',
        normalized_note
    );

    return true;
end;
$function$;

revoke all on function public.set_automatic_case_archive(text, text, text)
from public, anon, authenticated;
grant execute on function public.set_automatic_case_archive(text, text, text)
to service_role;

create or replace function public.claim_next_automatic_case_analysis(
    p_analysis_version text
)
returns table (
    session_id text,
    participant_id text,
    case_number text,
    source_completed_at timestamptz,
    attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    perform pg_advisory_xact_lock(hashtextextended(
        'automatic_case_analysis_fifo',
        0
    ));

    return query
    with candidate as (
        select job.session_id
        from public.automatic_case_analysis_jobs as job
        where job.analysis_version = p_analysis_version
          and job.archived_at is null
          and (
              (
                  job.status = 'pending'
                  and coalesce(job.next_retry_at, now()) <= now()
              )
              or (
                  job.status = 'failed'
                  and job.attempt_count < 5
                  and coalesce(job.next_retry_at, now()) <= now()
              )
              or (
                  job.status = 'processing'
                  and coalesce(job.lease_expires_at, now()) <= now()
              )
          )
          and not exists (
              select 1
              from public.automatic_case_analysis_jobs as active_job
              where active_job.analysis_version = p_analysis_version
                and active_job.archived_at is null
                and active_job.status = 'processing'
                and coalesce(active_job.lease_expires_at, now()) > now()
          )
        order by
            job.source_completed_at,
            job.queued_at,
            job.session_id
        for update
        limit 1
    )
    update public.automatic_case_analysis_jobs as job
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
    returning
        job.session_id,
        job.participant_id,
        job.case_number,
        job.source_completed_at,
        job.attempt_count;
end;
$function$;

revoke all on function public.claim_next_automatic_case_analysis(text)
from public, anon, authenticated;
grant execute on function public.claim_next_automatic_case_analysis(text)
to service_role;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

do $block$
begin
    if not exists (
        select 1
        from cron.job
        where jobname = 'pli-automatic-case-analysis-wakeup'
    ) then
        perform cron.schedule(
            'pli-automatic-case-analysis-wakeup',
            '* * * * *',
            $cron$
                select net.http_get(
                    url := 'https://intervu.quest/api/loadDesign',
                    timeout_milliseconds := 10000
                ) as request_id;
            $cron$
        );
    end if;
end;
$block$;
