-- The researcher explicitly directed that GPT-5.6 Stage 1 work must make
-- practical progress instead of serially blocking the full participant queue.
-- This changes scheduling only. It does not validate, reject, or exclude any
-- participant, transcript, model output, or report.
create or replace function public.claim_available_advanced_preliminary_analysis()
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
    maximum_parallel_cases constant integer := 8;
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    active_run public.advanced_preliminary_analysis_runs%rowtype;
    current_processing integer;
    may_submit boolean;
begin
    perform pg_advisory_xact_lock(
        hashtext('advanced_preliminary_analysis_worker')
    );

    -- Recover only a submission whose website lease expired before a durable
    -- provider response ID was saved. The participant remains in the queue.
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

    select run.* into active_run
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
    order by run.requested_at
    for update
    limit 1;

    if active_run.id is null then return; end if;

    select count(*) into current_processing
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = active_run.id
      and job.status = 'processing';

    may_submit := current_processing < maximum_parallel_cases;
    if may_submit and active_run.spend_guard_status = 'active' then
        may_submit := coalesce(
            active_run.estimated_incremental_spend_usd, 0
        ) + (current_processing + 1) * active_run.next_call_reserve_usd
            <= active_run.spending_limit_usd;
    end if;

    if may_submit then
        select candidate.* into selected_job
        from public.advanced_preliminary_analysis_jobs as candidate
        where candidate.run_id = active_run.id
          and candidate.source_report_id is null
          and (
              candidate.status = 'pending'
              or (candidate.status = 'failed'
                  and candidate.attempt_count < 3
                  and coalesce(candidate.next_retry_at,
                      '-infinity'::timestamptz) <= now())
          )
        order by candidate.source_completed_at, candidate.session_id
        for update skip locked
        limit 1;

        if selected_job.id is not null then
            update public.advanced_preliminary_analysis_jobs
            set status = 'processing', attempt_count = attempt_count + 1,
                claimed_at = now(),
                lease_expires_at = now() + interval '12 minutes',
                next_retry_at = null, updated_at = now()
            where id = selected_job.id;

            perform public.refresh_advanced_preliminary_analysis_run(
                selected_job.run_id
            );

            return query
            select selected_job.id, selected_job.run_id,
                selected_job.session_id, selected_job.participant_id,
                selected_job.case_number, selected_job.source_completed_at,
                selected_job.project_id, selected_job.analysis_framework_id,
                selected_job.source_report_id,
                selected_job.project_binding_status, active_run.provider,
                active_run.model, active_run.resolved_model,
                active_run.reasoning_effort, active_run.analysis_version,
                active_run.prompt_version, active_run.operation_type,
                active_run.authoritative_source,
                active_run.legacy_analysis_input,
                active_run.execution_contract_version,
                active_run.rules_snapshot, selected_job.provider_response_id,
                selected_job.provider_response_status;
            return;
        end if;
    end if;

    -- Poll each in-flight response in turn. A response checked during this tick
    -- is not selected again for at least 20 seconds.
    select job.* into selected_job
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = active_run.id
      and job.status = 'processing'
      and job.provider_response_id is not null
      and (
          job.provider_response_checked_at is null
          or job.provider_response_checked_at <= now() - interval '20 seconds'
      )
    order by job.provider_response_checked_at nulls first,
        job.source_completed_at, job.session_id
    for update skip locked
    limit 1;

    if selected_job.id is null then return; end if;

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
end;
$function$;

revoke all on function public.claim_available_advanced_preliminary_analysis()
from public, anon, authenticated;
grant execute on function public.claim_available_advanced_preliminary_analysis()
to service_role;

comment on function public.claim_available_advanced_preliminary_analysis() is
    'Researcher-directed bounded concurrent Stage 1 scheduling. Operational only; never a participant, transcript, or report eligibility rule.';
