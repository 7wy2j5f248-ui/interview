create or replace function public.mark_stale_interview_sessions_incomplete()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    changed_count integer;
begin
    with stale_sessions as (
        select
            session.session_id,
            coalesce(session.last_activity_at, session.created_at)
                + make_interval(
                    mins => coalesce(session.inactivity_timeout_minutes, 30)
                ) as timeout_at
        from public.interview_sessions as session
        where not session.completed
          and session.session_status = 'active'
          and coalesce(session.last_activity_at, session.created_at)
                + make_interval(
                    mins => coalesce(session.inactivity_timeout_minutes, 30)
                ) <= now()
    ), changed as (
        update public.interview_sessions as session
        set
            session_status = 'timed_out',
            end_reason = 'inactivity_timeout',
            timed_out_at = stale.timeout_at,
            ended_at = stale.timeout_at,
            updated_at = now()
        from stale_sessions as stale
        where session.session_id = stale.session_id
        returning session.session_id
    )
    select count(*)
    into changed_count
    from changed;

    return changed_count;
end;
$$;

revoke all on function public.mark_stale_interview_sessions_incomplete()
from public, anon, authenticated, service_role;

select public.mark_stale_interview_sessions_incomplete();

do $$
declare
    existing_job_id bigint;
begin
    select jobid
    into existing_job_id
    from cron.job
    where jobname = 'pli-mark-incomplete-sessions'
    limit 1;

    if existing_job_id is not null then
        perform cron.unschedule(existing_job_id);
    end if;

    perform cron.schedule(
        'pli-mark-incomplete-sessions',
        '* * * * *',
        'select public.mark_stale_interview_sessions_incomplete();'
    );
end;
$$;
