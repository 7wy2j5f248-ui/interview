-- Researcher-directed recovery of Stage 1 output that earlier analytical
-- gatekeeping left absent from the exact-response field.
--
-- Existing provider response IDs are retrieved without another model request.
-- Only blank reports with no provider response ID are queued for a new request.
-- Their surviving relational analysis remains in place and the replacement is
-- explicitly marked as regenerated, never represented as the missing original.

create or replace function public.restore_advanced_preliminary_existing_report_output(
    p_job_id uuid,
    p_participant_code text,
    p_language text,
    p_input_token_count integer,
    p_output_token_count integer,
    p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    selected_report public.advanced_preliminary_case_reports%rowtype;
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id
    for update;

    if selected_job.id is null then
        raise exception 'The Stage 1 case-processing job does not exist.';
    end if;

    select * into selected_report
    from public.advanced_preliminary_case_reports
    where job_id = selected_job.id
    for update;

    if selected_report.id is null then
        raise exception 'The existing Stage 1 report does not exist.';
    end if;

    -- A delayed duplicate worker may confirm completion, but may never replace
    -- a verbatim output that is already present.
    if nullif(selected_report.raw_model_output_text, '') is null then
        update public.advanced_preliminary_case_reports
        set participant_code = coalesce(
                nullif(btrim(p_participant_code), ''), participant_code
            ),
            language = coalesce(nullif(btrim(p_language), ''), language),
            input_token_count = coalesce(
                p_input_token_count, input_token_count
            ),
            output_token_count = coalesce(
                p_output_token_count, output_token_count
            ),
            raw_model_output_text = coalesce(
                p_payload->>'rawModelOutputText', ''
            ),
            parsed_model_output = null,
            system_processing_notes = '[]'::jsonb,
            analytical_audit = coalesce(analytical_audit, '{}'::jsonb)
                || coalesce(p_payload->'audit', '{}'::jsonb)
                || jsonb_build_object(
                    'exactFirstResponseAuthoritative', true,
                    'validationType', 'none_no_analytical_validator',
                    'relationalProjectionType', 'none_removed',
                    'automaticRetry', false,
                    'stage2Eligible', false,
                    'outputRestoredAt', now()
                ),
            completed_at = now()
        where id = selected_report.id;
    end if;

    update public.advanced_preliminary_analysis_jobs
    set status = 'completed',
        completed_at = coalesce(completed_at, now()),
        lease_expires_at = null,
        next_retry_at = null,
        last_error = null,
        raw_model_output_text = case
            when nullif(raw_model_output_text, '') is not null
                then raw_model_output_text
            else coalesce(p_payload->>'rawModelOutputText', '')
        end,
        parsed_model_output = null,
        system_processing_notes = '[]'::jsonb,
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
    return selected_report.id;
end;
$function$;

revoke all on function public.restore_advanced_preliminary_existing_report_output(
    uuid, text, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.restore_advanced_preliminary_existing_report_output(
    uuid, text, text, integer, integer, jsonb
) to service_role;

comment on function public.restore_advanced_preliminary_existing_report_output(
    uuid, text, text, integer, integer, jsonb
) is 'Fills only a blank existing report from an exact provider response. It cannot overwrite an existing verbatim response and performs no analytical validation.';

do $function$
declare
    target_run_id uuid;
begin
    select run.id into target_run_id
    from public.advanced_preliminary_analysis_runs as run
    where run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
      and exists (
          select 1
          from public.advanced_preliminary_analysis_jobs as job
          join public.advanced_preliminary_case_reports as report
            on report.job_id = job.id
          where job.run_id = run.id
            and nullif(report.raw_model_output_text, '') is null
      )
    order by run.requested_at desc, run.id desc
    limit 1;

    if target_run_id is null then
        return;
    end if;

    -- These reports retain a completed provider response ID. Retrieval restores
    -- the exact already-paid first response without making another model call.
    update public.advanced_preliminary_case_reports as report
    set analytical_audit = coalesce(report.analytical_audit, '{}'::jsonb)
        || jsonb_build_object(
            'outputRecoveryMode', 'original_provider_response_retrieval',
            'outputRecoveryRequestedAt', now(),
            'legacyStructuredAnalysisPreserved', true
        )
    from public.advanced_preliminary_analysis_jobs as job
    where report.job_id = job.id
      and job.run_id = target_run_id
      and nullif(report.raw_model_output_text, '') is null
      and job.provider_response_id is not null;

    update public.advanced_preliminary_analysis_jobs as job
    set status = 'processing',
        completed_at = null,
        lease_expires_at = now() + interval '24 hours',
        next_retry_at = null,
        provider_response_checked_at = null,
        last_error = null,
        updated_at = now()
    where job.run_id = target_run_id
      and job.provider_response_id is not null
      and exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = job.id
            and nullif(report.raw_model_output_text, '') is null
      );

    -- No verbatim response or durable provider ID survives for these reports.
    -- The new response is explicitly a researcher-directed regeneration.
    update public.advanced_preliminary_case_reports as report
    set analytical_audit = coalesce(report.analytical_audit, '{}'::jsonb)
        || jsonb_build_object(
            'outputRecoveryMode', 'researcher_directed_regeneration',
            'originalVerbatimResponseAvailable', false,
            'outputRecoveryRequestedAt', now(),
            'legacyStructuredAnalysisPreserved', true
        )
    from public.advanced_preliminary_analysis_jobs as job
    where report.job_id = job.id
      and job.run_id = target_run_id
      and nullif(report.raw_model_output_text, '') is null
      and job.provider_response_id is null;

    update public.advanced_preliminary_analysis_jobs as job
    set status = 'pending',
        completed_at = null,
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = now(),
        last_error = null,
        updated_at = now()
    where job.run_id = target_run_id
      and job.provider_response_id is null
      and exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = job.id
            and nullif(report.raw_model_output_text, '') is null
      );

    update public.advanced_preliminary_analysis_runs
    set status = 'processing',
        completed_at = null,
        cancelled_at = null,
        cancellation_reason = null,
        automatic_continuation = true,
        initial_wake_pending = true,
        initial_wake_consumed_at = null,
        last_error = null,
        updated_at = now()
    where id = target_run_id;

    perform public.refresh_advanced_preliminary_analysis_run(target_run_id);
end;
$function$;
