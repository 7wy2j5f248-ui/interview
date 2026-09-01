alter table public.advanced_preliminary_analysis_runs
    add column if not exists last_server_tick_at timestamptz;

comment on column public.advanced_preliminary_analysis_runs.last_server_tick_at is
    'Rate-limited database authorization for a server-side durable Stage 1 worker tick.';

create or replace function public.consume_authorized_analysis_server_tick()
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run_id uuid;
begin
    perform pg_advisory_xact_lock(
        hashtext('advanced_preliminary_analysis_server_tick')
    );

    select run.id into selected_run_id
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
      and run.spend_guard_status = 'active'
      and run.spending_limit_usd is not null
      and run.resumed_at is not null
      and (run.pending_count > 0 or run.processing_count > 0)
      and coalesce(run.last_server_tick_at,
          '-infinity'::timestamptz) <= now() - interval '20 seconds'
    order by run.resumed_at desc nulls last, run.requested_at
    for update
    limit 1;

    if selected_run_id is null then return null; end if;

    update public.advanced_preliminary_analysis_runs
    set last_server_tick_at = now(), updated_at = now()
    where id = selected_run_id;

    return selected_run_id;
end;
$function$;

revoke all on function public.consume_authorized_analysis_server_tick()
from public, anon, authenticated;
grant execute on function public.consume_authorized_analysis_server_tick()
to service_role;

-- Replace the obsolete design-read wakeup with a minute-by-minute, database-
-- authorized worker tick. Each tick only submits or polls one case, and the
-- job's durable provider response ID prevents a second paid submission.
select cron.unschedule('pli-automatic-case-analysis-wakeup')
where exists (
    select 1 from cron.job
    where jobname = 'pli-automatic-case-analysis-wakeup'
);

select cron.schedule(
    'pli-automatic-case-analysis-wakeup',
    '* * * * *',
    $cron$
    select net.http_post(
        url := 'https://intervu.quest/api/automatic-analysis',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"worker":"authorized-run-tick"}'::jsonb,
        timeout_milliseconds := 10000
    ) as request_id;
    $cron$
);
