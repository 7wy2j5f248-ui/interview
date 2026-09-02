-- The researcher explicitly authorized replacement of every provider response
-- still outstanding in the active Stage 1 run on 2026-09-02. This is a
-- one-use delivery operation, not an analytical validity rule. Every replaced
-- response ID and provider status remains in append-only attempt history.

alter table public.advanced_preliminary_analysis_jobs
    add column if not exists researcher_replacement_authorized_at timestamptz,
    add column if not exists researcher_replacement_consumed_at timestamptz;

comment on column public.advanced_preliminary_analysis_jobs.researcher_replacement_authorized_at is
    'Explicit researcher authorization to replace the provider response currently attached to this job.';
comment on column public.advanced_preliminary_analysis_jobs.researcher_replacement_consumed_at is
    'Time the single-use researcher-authorized provider replacement was consumed.';

do $function$
declare
    target_run_id constant uuid :=
        '9cba2707-bb77-491e-bd10-9518509a6981'::uuid;
    authorized_job_ids constant uuid[] := array[
        '08db1a02-a50b-445c-8a92-493e8287917b'::uuid,
        '0d6f4f9a-d184-4b00-97f5-0bbffc49a3a6'::uuid,
        '0fd6b85f-f74e-46ed-99b9-369dfa20f694'::uuid,
        '15fabe0a-b26e-44e0-b2fd-80bf2053925b'::uuid,
        '1aa7627f-8a4e-4637-a91e-a6c3d3914d84'::uuid,
        '21dca6f3-7b10-4156-9926-b635340e4075'::uuid,
        '32d88c71-b7a5-4233-be07-b5bb811f5c3e'::uuid,
        '373ddd8e-4c9b-4942-9ee7-9841bac1420c'::uuid,
        '437f3ea4-ff02-494f-b787-6c2ab0af878d'::uuid,
        '441923d4-9083-4b66-b088-d4fda6cae2aa'::uuid,
        '65bf7b75-16df-400c-a37d-1a9b7b5dfc17'::uuid,
        '6ab1b901-75a3-4b8c-a3f2-ec92dd90e7a7'::uuid,
        '6e217536-b1e4-4367-ba73-3ef8f73dfac6'::uuid,
        '7b060f37-5d88-45dd-86af-73c60c5416cf'::uuid,
        '82b4cc97-b29b-41f2-862c-1791758175fb'::uuid,
        '99fb3bb5-ac92-46a7-a0cb-73ba7b1354f5'::uuid,
        'a90fbb0d-d811-4c1a-be9b-0760a01d673f'::uuid,
        'ac4afa84-27d4-454a-bdf9-9874e0ff8195'::uuid,
        'b373a377-3171-4a6d-bcee-2621fc259ba1'::uuid,
        'b759eaa3-a697-4997-b103-4f3fac24420c'::uuid,
        'be166c71-bbe6-4f82-8e3c-20f420e58573'::uuid,
        'c743ddc0-2d95-409b-8e03-c704ab812e0f'::uuid,
        'd479bbe3-5e73-46ed-9838-2c11d8cb5650'::uuid,
        'fa16f4d8-2589-45fb-a486-5dc653638b4a'::uuid,
        'fcda16c0-4e9b-4abd-b6a7-e202ca98bbd5'::uuid
    ];
    authorized_count integer;
begin
    if coalesce(array_length(authorized_job_ids, 1), 0) <> 25 then
        raise exception 'The researcher-authorized replacement scope must contain exactly 25 jobs.';
    end if;
    if not exists (
        select 1
        from public.advanced_preliminary_analysis_runs as run
        where run.id = target_run_id
          and run.status in ('queued', 'processing')
          and run.operation_type = 'fresh_independent_analysis'
          and run.authoritative_source = 'original_completed_transcripts'
          and run.legacy_analysis_input = 'excluded'
    ) then
        raise exception 'The explicitly authorized Stage 1 run is not active.';
    end if;

    update public.advanced_preliminary_analysis_jobs as job
    set researcher_replacement_authorized_at = now(),
        researcher_replacement_consumed_at = null,
        updated_at = now()
    where job.run_id = target_run_id
      and job.id = any(authorized_job_ids)
      and job.status = 'processing'
      and job.provider_response_id is not null
      and job.provider_response_status in ('queued', 'in_progress')
      and not exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = job.id
            and nullif(report.raw_model_output_text, '') is not null
      );

    get diagnostics authorized_count = row_count;

    if authorized_count <> 25 then
        raise exception 'Expected 25 outstanding jobs in the exact authorized scope, found %.',
            authorized_count;
    end if;

    update public.advanced_preliminary_analysis_runs
    set contract_transitions = coalesce(contract_transitions, '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                'changeType', 'researcher_authorized_provider_replacement',
                'authorizedAt', now(),
                'authorizedBy', 'researcher',
                'authorizedOutstandingCount', authorized_count,
                'analyticalJudgment', false,
                'preservePriorProviderAttempts', true
            )),
        updated_at = now()
    where id = target_run_id;
end;
$function$;

create or replace function public.replace_researcher_authorized_advanced_preliminary_response(
    p_job_id uuid,
    p_provider_response_id text,
    p_reason text
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

    if selected_job.id is null
       or selected_job.researcher_replacement_authorized_at is null
       or selected_job.researcher_replacement_consumed_at is not null then
        raise exception 'No unused researcher-authorized replacement exists for this job.';
    end if;
    if selected_job.status <> 'processing'
       or selected_job.provider_response_id <> btrim(p_provider_response_id) then
        raise exception 'The authorized replacement does not match the active provider response.';
    end if;
    if selected_job.provider_response_status <> 'cancelled' then
        raise exception 'The provider response must be cancelled before replacement.';
    end if;

    update public.advanced_preliminary_analysis_jobs
    set provider_response_history = coalesce(provider_response_history, '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                'responseId', selected_job.provider_response_id,
                'status', selected_job.provider_response_status,
                'submittedAt', selected_job.provider_response_submitted_at,
                'lastCheckedAt', selected_job.provider_response_checked_at,
                'completedAt', selected_job.provider_response_completed_at,
                'inputTokenCount', selected_job.provider_input_token_count,
                'outputTokenCount', selected_job.provider_output_token_count,
                'reason', left(coalesce(p_reason,
                    'Researcher authorized replacement.'), 1000),
                'resolution', 'researcher_authorized_replacement',
                'archivedAt', now()
            )),
        researcher_replacement_consumed_at = now(),
        provider_response_id = null,
        provider_response_status = null,
        provider_response_submitted_at = null,
        provider_response_checked_at = null,
        provider_response_completed_at = null,
        provider_input_token_count = null,
        provider_output_token_count = null,
        status = 'pending',
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = now(),
        last_error = null,
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
end;
$function$;

create or replace function public.prepare_researcher_authorized_historical_response_restore(
    p_job_id uuid,
    p_current_provider_response_id text,
    p_historical_provider_response_id text,
    p_historical_provider_response_status text,
    p_historical_input_token_count integer,
    p_historical_output_token_count integer
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

    if selected_job.id is null
       or selected_job.researcher_replacement_authorized_at is null
       or selected_job.researcher_replacement_consumed_at is not null then
        raise exception 'No unused researcher-authorized recovery exists for this job.';
    end if;
    if selected_job.status <> 'processing'
       or selected_job.provider_response_id <> btrim(p_current_provider_response_id)
       or selected_job.provider_response_status <> 'cancelled' then
        raise exception 'The current provider response was not cancelled for recovery.';
    end if;
    if nullif(btrim(p_historical_provider_response_id), '') is null
       or p_historical_provider_response_status not in ('completed', 'failed', 'incomplete') then
        raise exception 'The historical provider response is not a preservable terminal response.';
    end if;

    update public.advanced_preliminary_analysis_jobs
    set provider_response_history = coalesce(provider_response_history, '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                'responseId', selected_job.provider_response_id,
                'status', selected_job.provider_response_status,
                'submittedAt', selected_job.provider_response_submitted_at,
                'lastCheckedAt', selected_job.provider_response_checked_at,
                'completedAt', selected_job.provider_response_completed_at,
                'inputTokenCount', selected_job.provider_input_token_count,
                'outputTokenCount', selected_job.provider_output_token_count,
                'reason', 'Researcher authorized recovery of an earlier terminal provider response.',
                'resolution', 'historical_response_recovered',
                'archivedAt', now()
            )),
        researcher_replacement_consumed_at = now(),
        provider_response_id = btrim(p_historical_provider_response_id),
        provider_response_status = p_historical_provider_response_status,
        provider_response_checked_at = now(),
        provider_response_completed_at = now(),
        provider_input_token_count = p_historical_input_token_count,
        provider_output_token_count = p_historical_output_token_count,
        last_error = null,
        updated_at = now()
    where id = selected_job.id;
end;
$function$;

revoke all on function public.replace_researcher_authorized_advanced_preliminary_response(
    uuid, text, text
) from public, anon, authenticated;
grant execute on function public.replace_researcher_authorized_advanced_preliminary_response(
    uuid, text, text
) to service_role;

revoke all on function public.prepare_researcher_authorized_historical_response_restore(
    uuid, text, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.prepare_researcher_authorized_historical_response_restore(
    uuid, text, text, text, integer, integer
) to service_role;

comment on function public.replace_researcher_authorized_advanced_preliminary_response(
    uuid, text, text
) is 'Consumes one explicit researcher authorization, preserves the cancelled provider attempt, and queues one replacement without making an analytical judgment.';
comment on function public.prepare_researcher_authorized_historical_response_restore(
    uuid, text, text, text, integer, integer
) is 'Consumes one explicit researcher authorization and activates an earlier terminal provider response for exact-output preservation.';
