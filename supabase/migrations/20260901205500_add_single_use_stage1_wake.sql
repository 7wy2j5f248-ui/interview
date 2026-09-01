alter table public.advanced_preliminary_analysis_runs
    add column if not exists initial_wake_pending boolean
        not null default false,
    add column if not exists initial_wake_consumed_at timestamptz;

comment on column public.advanced_preliminary_analysis_runs.initial_wake_pending is
    'Single-use server wake authorization created only by an explicitly authorized run resumption.';

create or replace function public.mark_resumed_analysis_initial_wake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if new.resume_count > old.resume_count
       and new.spend_guard_status = 'active'
       and new.spending_limit_usd is not null then
        new.initial_wake_pending := true;
        new.initial_wake_consumed_at := null;
    end if;
    return new;
end;
$function$;

drop trigger if exists advanced_preliminary_resumption_authorizes_one_wake
on public.advanced_preliminary_analysis_runs;

create trigger advanced_preliminary_resumption_authorizes_one_wake
before update on public.advanced_preliminary_analysis_runs
for each row
execute function public.mark_resumed_analysis_initial_wake();

update public.advanced_preliminary_analysis_runs
set initial_wake_pending = true,
    initial_wake_consumed_at = null,
    updated_at = now()
where status in ('queued', 'processing')
  and spend_guard_status = 'active'
  and spending_limit_usd is not null
  and resumed_at is not null
  and pending_count > 0
  and initial_wake_consumed_at is null;

create or replace function public.consume_authorized_analysis_initial_wake()
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run_id uuid;
begin
    perform pg_advisory_xact_lock(
        hashtext('advanced_preliminary_analysis_initial_wake')
    );

    select run.id into selected_run_id
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
      and run.spend_guard_status = 'active'
      and run.spending_limit_usd is not null
      and run.initial_wake_pending = true
      and run.initial_wake_consumed_at is null
      and run.pending_count > 0
    order by run.resumed_at desc nulls last, run.requested_at
    for update
    limit 1;

    if selected_run_id is null then return null; end if;

    update public.advanced_preliminary_analysis_runs
    set initial_wake_pending = false,
        initial_wake_consumed_at = now(),
        updated_at = now()
    where id = selected_run_id;

    return selected_run_id;
end;
$function$;

revoke all on function public.mark_resumed_analysis_initial_wake()
from public, anon, authenticated;
revoke all on function public.consume_authorized_analysis_initial_wake()
from public, anon, authenticated;

grant execute on function public.consume_authorized_analysis_initial_wake()
to service_role;
