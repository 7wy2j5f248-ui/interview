alter table public.advanced_preliminary_analysis_jobs
    add column if not exists provider_response_id text,
    add column if not exists provider_response_status text,
    add column if not exists provider_response_submitted_at timestamptz,
    add column if not exists provider_response_checked_at timestamptz,
    add column if not exists provider_response_completed_at timestamptz,
    add column if not exists provider_input_token_count integer,
    add column if not exists provider_output_token_count integer,
    add column if not exists unverified_spend_reserve_usd numeric(12,6)
        not null default 0;

comment on column public.advanced_preliminary_analysis_jobs.provider_response_id is
    'Durable OpenAI Responses API identifier. Polling this identifier never submits a second analysis call.';
comment on column public.advanced_preliminary_analysis_jobs.unverified_spend_reserve_usd is
    'Conservative amount charged against the researcher limit when an earlier request may have incurred unobservable usage.';

alter table public.advanced_preliminary_analysis_jobs
    drop constraint if exists advanced_preliminary_job_unverified_spend_nonnegative;
alter table public.advanced_preliminary_analysis_jobs
    add constraint advanced_preliminary_job_unverified_spend_nonnegative
        check (unverified_spend_reserve_usd >= 0);

create index if not exists advanced_preliminary_provider_response_idx
on public.advanced_preliminary_analysis_jobs (provider_response_id)
where provider_response_id is not null;

create or replace function public.save_advanced_preliminary_provider_response(
    p_job_id uuid,
    p_provider_response_id text,
    p_provider_response_status text,
    p_input_token_count integer default null,
    p_output_token_count integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    reserve_amount numeric(12,6);
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id
    for update;

    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The advanced preliminary job is not processing.';
    end if;
    if nullif(btrim(p_provider_response_id), '') is null then
        raise exception 'A provider response identifier is required.';
    end if;
    if selected_job.provider_response_id is not null
       and selected_job.provider_response_id <> btrim(p_provider_response_id) then
        raise exception 'The job is already bound to another provider response.';
    end if;

    select coalesce(run.next_call_reserve_usd, 0)
    into reserve_amount
    from public.advanced_preliminary_analysis_runs as run
    where run.id = selected_job.run_id;

    update public.advanced_preliminary_analysis_jobs
    set provider_response_id = btrim(p_provider_response_id),
        provider_response_status = coalesce(
            nullif(btrim(p_provider_response_status), ''), 'queued'
        ),
        provider_response_submitted_at = coalesce(
            provider_response_submitted_at, now()
        ),
        provider_response_checked_at = now(),
        provider_response_completed_at = case
            when p_provider_response_status in (
                'completed', 'failed', 'cancelled', 'incomplete'
            ) then coalesce(provider_response_completed_at, now())
            else provider_response_completed_at
        end,
        provider_input_token_count = coalesce(
            p_input_token_count, provider_input_token_count
        ),
        provider_output_token_count = coalesce(
            p_output_token_count, provider_output_token_count
        ),
        unverified_spend_reserve_usd = case
            when p_provider_response_status in ('failed', 'cancelled', 'incomplete')
             and p_input_token_count is null and p_output_token_count is null
                then greatest(unverified_spend_reserve_usd, reserve_amount)
            else unverified_spend_reserve_usd
        end,
        lease_expires_at = now() + interval '24 hours',
        updated_at = now()
    where id = selected_job.id;
end;
$function$;

drop function if exists public.claim_next_advanced_preliminary_analysis();

create function public.claim_next_advanced_preliminary_analysis()
returns table (
    job_id uuid, run_id uuid, session_id text, participant_id text,
    case_number text, source_completed_at timestamptz, project_id uuid,
    analysis_framework_id uuid, source_report_id uuid,
    project_binding_status text, provider text, model text,
    resolved_model text, reasoning_effort text, analysis_version text,
    prompt_version text, operation_type text, authoritative_source text,
    legacy_analysis_input text, execution_contract_version text,
    rules_snapshot jsonb, provider_response_id text,
    provider_response_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    active_run public.advanced_preliminary_analysis_runs%rowtype;
    recorded_total numeric(12,6);
    orphan_job_total numeric(12,6);
    reserve_total numeric(12,6);
    incremental_total numeric(12,6);
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_worker'));

    -- A pre-background request could be terminated after OpenAI received it but
    -- before an ID was saved. Retry it once, but reserve the full per-call amount
    -- so the uncertainty is included in the researcher's spending ceiling.
    update public.advanced_preliminary_analysis_jobs as job
    set status = 'failed', lease_expires_at = null, next_retry_at = now(),
        unverified_spend_reserve_usd = greatest(
            job.unverified_spend_reserve_usd, run.next_call_reserve_usd
        ),
        last_error = coalesce(job.last_error,
            'Website runtime expired before a durable provider response identifier was returned; conservative spending reserve recorded and one durable retry scheduled.'),
        updated_at = now()
    from public.advanced_preliminary_analysis_runs as run
    where run.id = job.run_id
      and run.status in ('queued', 'processing')
      and job.status = 'processing'
      and job.provider_response_id is null
      and job.lease_expires_at < now();

    perform public.refresh_advanced_preliminary_analysis_run(run.id)
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing');

    select * into active_run
    from public.advanced_preliminary_analysis_runs
    where status in ('queued', 'processing')
    order by requested_at
    for update
    limit 1;

    if active_run.id is null then return; end if;

    -- Poll the one already-submitted response before considering another case.
    select job.* into selected_job
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = active_run.id
      and job.status = 'processing'
      and job.provider_response_id is not null
    order by job.source_completed_at, job.session_id
    for update
    limit 1;

    if selected_job.id is not null then
        update public.advanced_preliminary_analysis_jobs
        set lease_expires_at = now() + interval '24 hours', updated_at = now()
        where id = selected_job.id;

        return query
        select selected_job.id, selected_job.run_id, selected_job.session_id,
            selected_job.participant_id, selected_job.case_number,
            selected_job.source_completed_at, selected_job.project_id,
            selected_job.analysis_framework_id, selected_job.source_report_id,
            selected_job.project_binding_status, active_run.provider,
            active_run.model, active_run.resolved_model,
            active_run.reasoning_effort, active_run.analysis_version,
            active_run.prompt_version, active_run.operation_type,
            active_run.authoritative_source, active_run.legacy_analysis_input,
            active_run.execution_contract_version, active_run.rules_snapshot,
            selected_job.provider_response_id,
            selected_job.provider_response_status;
        return;
    end if;

    -- A just-claimed case has a short submission lease. Never claim around it.
    if exists (
        select 1
        from public.advanced_preliminary_analysis_jobs as job
        where job.run_id = active_run.id
          and job.status = 'processing'
          and job.lease_expires_at >= now()
    ) then
        return;
    end if;

    if active_run.spend_guard_status = 'active' then
        select coalesce(sum(
            (coalesce(report.input_token_count, 0)::numeric
                * active_run.input_price_usd_per_million
             + coalesce(report.output_token_count, 0)::numeric
                * active_run.output_price_usd_per_million)
            / 1000000
        ), 0)::numeric(12,6)
        into recorded_total
        from public.advanced_preliminary_case_reports as report
        where report.run_id = active_run.id;

        select coalesce(sum(
            (coalesce(job.provider_input_token_count, 0)::numeric
                * active_run.input_price_usd_per_million
             + coalesce(job.provider_output_token_count, 0)::numeric
                * active_run.output_price_usd_per_million)
            / 1000000
        ), 0)::numeric(12,6)
        into orphan_job_total
        from public.advanced_preliminary_analysis_jobs as job
        where job.run_id = active_run.id
          and (job.provider_input_token_count is not null
               or job.provider_output_token_count is not null)
          and not exists (
              select 1
              from public.advanced_preliminary_case_reports as report
              where report.job_id = job.id
          );

        select coalesce(sum(job.unverified_spend_reserve_usd), 0)::numeric(12,6)
        into reserve_total
        from public.advanced_preliminary_analysis_jobs as job
        where job.run_id = active_run.id;

        incremental_total := greatest(
            recorded_total - active_run.spending_baseline_usd,
            0
        ) + orphan_job_total + reserve_total;

        update public.advanced_preliminary_analysis_runs
        set estimated_incremental_spend_usd = incremental_total,
            spend_guard_checked_at = now(), updated_at = now()
        where id = active_run.id;

        if incremental_total + active_run.next_call_reserve_usd
            > active_run.spending_limit_usd then
            update public.advanced_preliminary_analysis_runs
            set spend_guard_status = 'limit_reached',
                status = 'spending_limit_reached',
                last_error = format(
                    'Authorized model-spending limit reached: $%s recorded or conservatively reserved since resumption; $%s reserved for the next case; $%s limit.',
                    incremental_total, active_run.next_call_reserve_usd,
                    active_run.spending_limit_usd
                ),
                updated_at = now()
            where id = active_run.id;
            return;
        end if;
    end if;

    select candidate.* into selected_job
    from public.advanced_preliminary_analysis_jobs as candidate
    where candidate.run_id = active_run.id
      and active_run.operation_type = 'fresh_independent_analysis'
      and active_run.authoritative_source = 'original_completed_transcripts'
      and active_run.legacy_analysis_input = 'excluded'
      and candidate.source_report_id is null
      and (
          candidate.status = 'pending'
          or (candidate.status = 'failed' and candidate.attempt_count < 3
              and coalesce(candidate.next_retry_at,
                  '-infinity'::timestamptz) <= now())
      )
    order by candidate.source_completed_at, candidate.session_id
    for update skip locked
    limit 1;

    if selected_job.id is null then return; end if;

    update public.advanced_preliminary_analysis_jobs
    set status = 'processing', attempt_count = attempt_count + 1,
        claimed_at = now(), lease_expires_at = now() + interval '12 minutes',
        next_retry_at = null, updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);

    return query
    select selected_job.id, selected_job.run_id, selected_job.session_id,
        selected_job.participant_id, selected_job.case_number,
        selected_job.source_completed_at, selected_job.project_id,
        selected_job.analysis_framework_id, selected_job.source_report_id,
        selected_job.project_binding_status, active_run.provider,
        active_run.model, active_run.resolved_model,
        active_run.reasoning_effort, active_run.analysis_version,
        active_run.prompt_version, active_run.operation_type,
        active_run.authoritative_source, active_run.legacy_analysis_input,
        active_run.execution_contract_version, active_run.rules_snapshot,
        selected_job.provider_response_id,
        selected_job.provider_response_status;
end;
$function$;

revoke all on function public.save_advanced_preliminary_provider_response(
    uuid, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.claim_next_advanced_preliminary_analysis()
from public, anon, authenticated;

grant execute on function public.save_advanced_preliminary_provider_response(
    uuid, text, text, integer, integer
) to service_role;
grant execute on function public.claim_next_advanced_preliminary_analysis()
to service_role;

-- The researcher already authorized this active $80-limited continuation.
-- Re-arm exactly one server wake after the durable worker is deployed.
update public.advanced_preliminary_analysis_runs
set initial_wake_pending = true,
    initial_wake_consumed_at = null,
    updated_at = now()
where status in ('queued', 'processing')
  and operation_type = 'fresh_independent_analysis'
  and authoritative_source = 'original_completed_transcripts'
  and legacy_analysis_input = 'excluded'
  and spend_guard_status = 'active'
  and spending_limit_usd = 80
  and resumed_at is not null
  and (pending_count > 0 or processing_count > 0);
