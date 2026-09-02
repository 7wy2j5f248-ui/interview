alter table public.advanced_preliminary_analysis_jobs
    add column if not exists provider_response_history jsonb
        not null default '[]'::jsonb,
    add column if not exists stale_response_retry_count integer
        not null default 0;

alter table public.advanced_preliminary_analysis_jobs
    drop constraint if exists advanced_preliminary_stale_retry_count_check;
alter table public.advanced_preliminary_analysis_jobs
    add constraint advanced_preliminary_stale_retry_count_check
        check (stale_response_retry_count between 0 and 1);

comment on column public.advanced_preliminary_analysis_jobs.provider_response_history is
    'Append-only lineage for cancelled or terminal provider attempts before the current response.';
comment on column public.advanced_preliminary_analysis_jobs.stale_response_retry_count is
    'At most one fresh provider submission is allowed after a response exceeds the stale threshold.';
comment on column public.advanced_preliminary_analysis_jobs.unverified_spend_reserve_usd is
    'Cumulative exact or conservative cost from prior attempts that did not produce the accepted report.';

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
        lease_expires_at = now() + interval '24 hours',
        updated_at = now()
    where id = selected_job.id;
end;
$function$;

create or replace function public.resolve_stalled_advanced_preliminary_response(
    p_job_id uuid,
    p_provider_response_id text,
    p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    prior_attempt_cost numeric(12,6);
    resolution text;
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id
    for update;

    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The advanced preliminary job is not processing.';
    end if;
    if selected_job.provider_response_id is null
       or selected_job.provider_response_id <> btrim(p_provider_response_id) then
        raise exception 'The stalled response does not match the job response.';
    end if;
    if selected_job.provider_response_submitted_at is null
       or selected_job.provider_response_submitted_at
            > now() - interval '45 minutes' then
        raise exception 'The provider response has not reached the stale threshold.';
    end if;
    if selected_job.provider_response_status <> 'cancelled' then
        raise exception 'The provider response must be cancelled before retry resolution.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = selected_job.run_id
    for update;

    prior_attempt_cost := case
        when selected_job.provider_input_token_count is not null
          or selected_job.provider_output_token_count is not null then
            (
                coalesce(selected_job.provider_input_token_count, 0)::numeric
                    * selected_run.input_price_usd_per_million
              + coalesce(selected_job.provider_output_token_count, 0)::numeric
                    * selected_run.output_price_usd_per_million
            ) / 1000000
        else selected_run.next_call_reserve_usd
    end;

    resolution := case
        when selected_job.stale_response_retry_count < 1
            then 'retry_scheduled'
        else 'terminal_failure'
    end;

    update public.advanced_preliminary_analysis_jobs
    set provider_response_history = provider_response_history
            || jsonb_build_array(jsonb_build_object(
                'responseId', selected_job.provider_response_id,
                'status', selected_job.provider_response_status,
                'submittedAt', selected_job.provider_response_submitted_at,
                'lastCheckedAt', selected_job.provider_response_checked_at,
                'completedAt', selected_job.provider_response_completed_at,
                'inputTokenCount', selected_job.provider_input_token_count,
                'outputTokenCount', selected_job.provider_output_token_count,
                'reason', left(coalesce(p_reason,
                    'Provider response exceeded the stale threshold.'), 1000),
                'resolution', resolution,
                'archivedAt', now()
            )),
        stale_response_retry_count = stale_response_retry_count + case
            when stale_response_retry_count < 1 then 1 else 0 end,
        unverified_spend_reserve_usd = unverified_spend_reserve_usd
            + coalesce(prior_attempt_cost, selected_run.next_call_reserve_usd),
        provider_response_id = null,
        provider_response_status = null,
        provider_response_submitted_at = null,
        provider_response_checked_at = null,
        provider_response_completed_at = null,
        provider_input_token_count = null,
        provider_output_token_count = null,
        status = 'failed',
        lease_expires_at = null,
        next_retry_at = case when resolution = 'retry_scheduled'
            then now() else null end,
        last_error = left(format(
            '%s Stalled response preserved in attempt history; resolution: %s.',
            coalesce(p_reason, 'Provider response exceeded the stale threshold.'),
            resolution
        ), 5000),
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
    return resolution;
end;
$function$;

revoke all on function public.save_advanced_preliminary_provider_response(
    uuid, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.resolve_stalled_advanced_preliminary_response(
    uuid, text, text
) from public, anon, authenticated;

grant execute on function public.save_advanced_preliminary_provider_response(
    uuid, text, text, integer, integer
) to service_role;
grant execute on function public.resolve_stalled_advanced_preliminary_response(
    uuid, text, text
) to service_role;
