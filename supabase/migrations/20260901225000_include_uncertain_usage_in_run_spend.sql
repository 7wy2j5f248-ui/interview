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
    orphan_job_total numeric(12,6);
    reserve_total numeric(12,6);
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

    select coalesce(sum(
        (coalesce(job.provider_input_token_count, 0)::numeric
            * coalesce(selected_run.input_price_usd_per_million, 0)
         + coalesce(job.provider_output_token_count, 0)::numeric
            * coalesce(selected_run.output_price_usd_per_million, 0))
        / 1000000
    ), 0)::numeric(12,6)
    into orphan_job_total
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = p_run_id
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
    where job.run_id = p_run_id;

    incremental_total := greatest(
        recorded_total - selected_run.spending_baseline_usd,
        0
    ) + orphan_job_total + reserve_total;

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

select public.refresh_advanced_preliminary_analysis_run(run.id)
from public.advanced_preliminary_analysis_runs as run
where run.status in ('queued', 'processing', 'spending_limit_reached');
