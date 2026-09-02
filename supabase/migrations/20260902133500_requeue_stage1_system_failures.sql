-- Repair only unsaved GPT-5.6 Stage 1 cases. Provider attempts and costs are
-- archived before their current response fields are cleared. No transcript or
-- completed report is deleted or changed.
with selected_run as (
    select id, input_price_usd_per_million,
        output_price_usd_per_million, next_call_reserve_usd
    from public.advanced_preliminary_analysis_runs
    where status in (
        'queued', 'processing', 'spending_limit_reached',
        'completed_with_failures'
    )
      and operation_type = 'fresh_independent_analysis'
      and authoritative_source = 'original_completed_transcripts'
      and legacy_analysis_input = 'excluded'
      and model = 'gpt-5.6-sol'
    order by requested_at desc
    limit 1
    for update
), repaired as (
    update public.advanced_preliminary_analysis_jobs as job
    set provider_response_history = job.provider_response_history
            || case when job.provider_response_id is not null then
                jsonb_build_array(jsonb_build_object(
                    'responseId', job.provider_response_id,
                    'status', job.provider_response_status,
                    'submittedAt', job.provider_response_submitted_at,
                    'lastCheckedAt', job.provider_response_checked_at,
                    'completedAt', job.provider_response_completed_at,
                    'inputTokenCount', job.provider_input_token_count,
                    'outputTokenCount', job.provider_output_token_count,
                    'reason', left(coalesce(job.last_error,
                        'Technical Stage 1 provider attempt repaired by the system.'),
                        1000),
                    'resolution', 'system_retry_scheduled',
                    'archivedAt', now()
                ))
            else '[]'::jsonb end,
        unverified_spend_reserve_usd =
            job.unverified_spend_reserve_usd
            + case when job.provider_response_id is null then 0
              when job.provider_input_token_count is not null
                or job.provider_output_token_count is not null then (
                    coalesce(job.provider_input_token_count, 0)::numeric
                        * selected_run.input_price_usd_per_million
                  + coalesce(job.provider_output_token_count, 0)::numeric
                        * selected_run.output_price_usd_per_million
                ) / 1000000
              else selected_run.next_call_reserve_usd end,
        provider_response_id = null,
        provider_response_status = null,
        provider_response_submitted_at = null,
        provider_response_checked_at = null,
        provider_response_completed_at = null,
        provider_input_token_count = null,
        provider_output_token_count = null,
        status = 'pending',
        attempt_count = 0,
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = now(),
        stale_response_retry_count = 0,
        last_error = 'Technical failure preserved in provider-response history; system retry scheduled without participant exclusion.',
        updated_at = now()
    from selected_run
    where job.run_id = selected_run.id
      and job.status = 'failed'
      and not exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = job.id
      )
    returning job.run_id
)
select public.refresh_advanced_preliminary_analysis_run(run_id)
from repaired
group by run_id;
