alter table public.advanced_preliminary_analysis_runs
    add column if not exists spending_limit_usd numeric(10,2),
    add column if not exists spending_baseline_usd numeric(12,6)
        not null default 0,
    add column if not exists estimated_incremental_spend_usd numeric(12,6)
        not null default 0,
    add column if not exists input_price_usd_per_million numeric(12,6),
    add column if not exists output_price_usd_per_million numeric(12,6),
    add column if not exists next_call_reserve_usd numeric(12,6),
    add column if not exists spend_guard_status text
        not null default 'not_configured',
    add column if not exists spend_guard_checked_at timestamptz,
    add column if not exists resumed_at timestamptz,
    add column if not exists resumed_by text,
    add column if not exists resume_count integer not null default 0,
    add column if not exists previous_cancellations jsonb
        not null default '[]'::jsonb;

alter table public.advanced_preliminary_analysis_runs
    drop constraint if exists advanced_preliminary_analysis_runs_status_check,
    drop constraint if exists advanced_preliminary_spending_limit_check,
    drop constraint if exists advanced_preliminary_spending_baseline_check,
    drop constraint if exists advanced_preliminary_incremental_spend_check,
    drop constraint if exists advanced_preliminary_input_price_check,
    drop constraint if exists advanced_preliminary_output_price_check,
    drop constraint if exists advanced_preliminary_call_reserve_check,
    drop constraint if exists advanced_preliminary_spend_guard_status_check,
    drop constraint if exists advanced_preliminary_resume_count_check;

alter table public.advanced_preliminary_analysis_runs
    add constraint advanced_preliminary_analysis_runs_status_check
        check (status in (
            'queued', 'processing', 'completed', 'completed_with_failures',
            'cancelled', 'failed', 'spending_limit_reached'
        )),
    add constraint advanced_preliminary_spending_limit_check
        check (spending_limit_usd is null or spending_limit_usd > 0),
    add constraint advanced_preliminary_spending_baseline_check
        check (spending_baseline_usd >= 0),
    add constraint advanced_preliminary_incremental_spend_check
        check (estimated_incremental_spend_usd >= 0),
    add constraint advanced_preliminary_input_price_check
        check (input_price_usd_per_million is null
            or input_price_usd_per_million > 0),
    add constraint advanced_preliminary_output_price_check
        check (output_price_usd_per_million is null
            or output_price_usd_per_million > 0),
    add constraint advanced_preliminary_call_reserve_check
        check (next_call_reserve_usd is null or next_call_reserve_usd > 0),
    add constraint advanced_preliminary_spend_guard_status_check
        check (spend_guard_status in (
            'not_configured', 'active', 'limit_reached', 'completed'
        )),
    add constraint advanced_preliminary_resume_count_check
        check (resume_count >= 0);

comment on column public.advanced_preliminary_analysis_runs.spending_limit_usd is
    'Researcher-authorized maximum incremental model spend for this execution or resumption.';
comment on column public.advanced_preliminary_analysis_runs.spending_baseline_usd is
    'Recorded model cost already incurred before the current authorization; it is not charged against the new incremental limit.';
comment on column public.advanced_preliminary_analysis_runs.next_call_reserve_usd is
    'Amount reserved before claiming the next single case so work stops before the authorized limit.';
comment on column public.advanced_preliminary_analysis_runs.previous_cancellations is
    'Append-only provenance for earlier stops when a researcher explicitly authorizes a continuation.';

create or replace function public.refresh_advanced_preliminary_analysis_run(
    p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
    counts record;
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    recorded_total numeric(12,6);
    incremental_total numeric(12,6);
begin
    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = p_run_id
    for update;

    if selected_run.id is null then return; end if;

    select
        count(*) filter (
            where status = 'pending'
               or (status = 'failed' and attempt_count < 3
                   and next_retry_at is not null)
        )::integer as pending_count,
        count(*) filter (where status = 'processing')::integer as processing_count,
        count(*) filter (where status = 'completed')::integer as completed_count,
        count(*) filter (
            where status = 'failed'
              and (attempt_count >= 3 or next_retry_at is null)
        )::integer as failed_count,
        count(*)::integer as total_count
    into counts
    from public.advanced_preliminary_analysis_jobs
    where run_id = p_run_id;

    select coalesce(sum(
        (coalesce(report.input_token_count, 0)::numeric
            * coalesce(selected_run.input_price_usd_per_million, 0)
         + coalesce(report.output_token_count, 0)::numeric
            * coalesce(selected_run.output_price_usd_per_million, 0))
        / 1000000
    ), 0)::numeric(12,6)
    into recorded_total
    from public.advanced_preliminary_case_reports as report
    where report.run_id = p_run_id;

    incremental_total := greatest(
        recorded_total - selected_run.spending_baseline_usd,
        0
    );

    update public.advanced_preliminary_analysis_runs
    set pending_count = counts.pending_count,
        processing_count = counts.processing_count,
        completed_count = counts.completed_count,
        failed_count = counts.failed_count,
        estimated_incremental_spend_usd = incremental_total,
        spend_guard_checked_at = case
            when spend_guard_status <> 'not_configured' then now()
            else spend_guard_checked_at
        end,
        spend_guard_status = case
            when spend_guard_status = 'limit_reached' then 'limit_reached'
            when spend_guard_status = 'not_configured' then 'not_configured'
            when counts.pending_count = 0 and counts.processing_count = 0
                then 'completed'
            else 'active'
        end,
        status = case
            when spend_guard_status = 'limit_reached'
                then 'spending_limit_reached'
            when cancelled_at is not null then 'cancelled'
            when counts.total_count = 0 then 'failed'
            when counts.pending_count = 0 and counts.processing_count = 0
                then case when counts.failed_count > 0
                    then 'completed_with_failures' else 'completed' end
            when counts.processing_count > 0 or counts.completed_count > 0
                then 'processing'
            else 'queued'
        end,
        started_at = case
            when counts.processing_count > 0 or counts.completed_count > 0
                then coalesce(started_at, now())
            else started_at
        end,
        completed_at = case
            when counts.pending_count = 0 and counts.processing_count = 0
                and counts.total_count > 0 then coalesce(completed_at, now())
            else null
        end,
        updated_at = now()
    where id = p_run_id;
end;
$function$;

create or replace function public.resume_advanced_preliminary_analysis_run(
    p_run_id uuid,
    p_spending_limit_usd numeric,
    p_input_price_usd_per_million numeric,
    p_output_price_usd_per_million numeric,
    p_next_call_reserve_usd numeric,
    p_resumed_by text default 'researcher'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    baseline_cost numeric(12,6);
    resumed_jobs integer;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_run'));

    if exists (
        select 1
        from public.advanced_preliminary_analysis_runs
        where id <> p_run_id and status in ('queued', 'processing')
    ) then
        raise exception 'Another preliminary case-analysis run is already active.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = p_run_id
    for update;

    if selected_run.id is null then
        raise exception 'The selected analysis run does not exist.';
    end if;
    if selected_run.status <> 'cancelled' then
        raise exception 'Only a stopped analysis run can be explicitly resumed.';
    end if;
    if selected_run.operation_type <> 'fresh_independent_analysis'
       or selected_run.authoritative_source <> 'original_completed_transcripts'
       or selected_run.legacy_analysis_input <> 'excluded' then
        raise exception 'The stopped run does not satisfy the independent-analysis contract.';
    end if;
    if selected_run.model <> 'gpt-5.6-sol'
       or selected_run.resolved_model <> 'gpt-5.6-sol'
       or selected_run.reasoning_effort <> 'high' then
        raise exception 'This authorization is only for GPT-5.6 Sol with high reasoning.';
    end if;
    if p_spending_limit_usd <= 0
       or p_input_price_usd_per_million <= 0
       or p_output_price_usd_per_million <= 0
       or p_next_call_reserve_usd <= 0
       or p_next_call_reserve_usd > p_spending_limit_usd then
        raise exception 'A positive spending limit, price snapshot, and next-call reserve are required.';
    end if;

    select coalesce(sum(
        (coalesce(report.input_token_count, 0)::numeric
            * p_input_price_usd_per_million
         + coalesce(report.output_token_count, 0)::numeric
            * p_output_price_usd_per_million)
        / 1000000
    ), 0)::numeric(12,6)
    into baseline_cost
    from public.advanced_preliminary_case_reports as report
    where report.run_id = p_run_id;

    update public.advanced_preliminary_analysis_jobs
    set status = 'pending',
        attempt_count = 0,
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = null,
        last_error = null,
        updated_at = now()
    where run_id = p_run_id
      and status in ('cancelled', 'failed')
      and not exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = advanced_preliminary_analysis_jobs.id
      );

    get diagnostics resumed_jobs = row_count;

    update public.advanced_preliminary_analysis_runs
    set previous_cancellations = previous_cancellations
            || jsonb_build_array(jsonb_build_object(
                'cancelledAt', cancelled_at,
                'reason', cancellation_reason,
                'resumedAt', now(),
                'resumedBy', coalesce(nullif(btrim(p_resumed_by), ''), 'researcher')
            )),
        cancelled_at = null,
        cancellation_reason = null,
        completed_at = null,
        last_error = null,
        spending_limit_usd = p_spending_limit_usd,
        spending_baseline_usd = baseline_cost,
        estimated_incremental_spend_usd = 0,
        input_price_usd_per_million = p_input_price_usd_per_million,
        output_price_usd_per_million = p_output_price_usd_per_million,
        next_call_reserve_usd = p_next_call_reserve_usd,
        spend_guard_status = 'active',
        spend_guard_checked_at = now(),
        resumed_at = now(),
        resumed_by = coalesce(nullif(btrim(p_resumed_by), ''), 'researcher'),
        resume_count = resume_count + 1,
        status = 'queued',
        updated_at = now()
    where id = p_run_id;

    perform public.refresh_advanced_preliminary_analysis_run(p_run_id);

    return jsonb_build_object(
        'runId', p_run_id,
        'status', 'resumed',
        'resumedJobs', resumed_jobs,
        'preservedCompletedCases', selected_run.completed_count,
        'spendingLimitUsd', p_spending_limit_usd,
        'spendingBaselineUsd', baseline_cost,
        'nextCallReserveUsd', p_next_call_reserve_usd
    );
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
    rules_snapshot jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    active_run public.advanced_preliminary_analysis_runs%rowtype;
    recorded_total numeric(12,6);
    incremental_total numeric(12,6);
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_worker'));

    update public.advanced_preliminary_analysis_jobs as job
    set status = 'failed', lease_expires_at = null, next_retry_at = now(),
        last_error = coalesce(job.last_error,
            'Worker lease expired; retry scheduled.'), updated_at = now()
    from public.advanced_preliminary_analysis_runs as run
    where run.id = job.run_id
      and run.status in ('queued', 'processing')
      and job.status = 'processing'
      and job.lease_expires_at < now();

    perform public.refresh_advanced_preliminary_analysis_run(run.id)
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing');

    if exists (
        select 1
        from public.advanced_preliminary_analysis_jobs as job
        join public.advanced_preliminary_analysis_runs as run
          on run.id = job.run_id
        where run.status in ('queued', 'processing')
          and job.status = 'processing'
          and job.lease_expires_at >= now()
    ) then
        return;
    end if;

    select * into active_run
    from public.advanced_preliminary_analysis_runs
    where status in ('queued', 'processing')
    order by requested_at
    for update
    limit 1;

    if active_run.id is null then return; end if;

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

        incremental_total := greatest(
            recorded_total - active_run.spending_baseline_usd,
            0
        );

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
                    'Authorized model-spending limit reached: $%s recorded since resumption; $%s reserved for the next case; $%s limit.',
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
    join public.advanced_preliminary_analysis_runs as run
      on run.id = candidate.run_id
    where run.id = active_run.id
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
      and candidate.source_report_id is null
      and (
          candidate.status = 'pending'
          or (candidate.status = 'failed' and candidate.attempt_count < 3
              and coalesce(candidate.next_retry_at,
                  '-infinity'::timestamptz) <= now())
      )
    order by candidate.source_completed_at, candidate.session_id
    for update of candidate skip locked
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
        selected_job.project_binding_status, run.provider, run.model,
        run.resolved_model, run.reasoning_effort, run.analysis_version,
        run.prompt_version, run.operation_type, run.authoritative_source,
        run.legacy_analysis_input, run.execution_contract_version,
        run.rules_snapshot
    from public.advanced_preliminary_analysis_runs as run
    where run.id = selected_job.run_id;
end;
$function$;

revoke all on function public.resume_advanced_preliminary_analysis_run(
    uuid, numeric, numeric, numeric, numeric, text
) from public, anon, authenticated;
revoke all on function public.claim_next_advanced_preliminary_analysis()
from public, anon, authenticated;

grant execute on function public.resume_advanced_preliminary_analysis_run(
    uuid, numeric, numeric, numeric, numeric, text
) to service_role;
grant execute on function public.claim_next_advanced_preliminary_analysis()
to service_role;
