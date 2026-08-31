alter table public.automatic_case_reanalysis_requests
drop constraint automatic_case_reanalysis_status_valid;

alter table public.automatic_case_reanalysis_requests
add constraint automatic_case_reanalysis_status_valid
check (status in (
    'queued', 'processing', 'proposal_ready',
    'approved', 'rejected', 'failed', 'cancelled'
));

alter table public.automatic_case_reanalysis_requests
add column cancelled_at timestamptz,
add column cancellation_reason text;

alter table public.analysis_framework_reanalysis_batches
drop constraint analysis_framework_reanalysis_batch_status_valid;

alter table public.analysis_framework_reanalysis_batches
add constraint analysis_framework_reanalysis_batch_status_valid
check (status in (
    'queued', 'processing', 'awaiting_review',
    'completed', 'completed_with_failures', 'empty',
    'cancellation_requested', 'cancelled'
));

alter table public.analysis_framework_reanalysis_batches
add column cancelled_case_count integer not null default 0,
add column cancellation_requested_at timestamptz,
add column cancelled_at timestamptz,
add column cancellation_reason text,
add column cancelled_by text;

alter table public.analysis_framework_reanalysis_batches
add constraint analysis_framework_reanalysis_batch_cancelled_nonnegative
check (cancelled_case_count >= 0);

create or replace function public.prevent_cancelled_reanalysis_restart()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if old.status = 'cancelled' and new.status <> 'cancelled' then
        raise exception 'A cancelled re-analysis request is terminal and cannot restart.';
    end if;
    return new;
end;
$function$;

create trigger automatic_case_reanalysis_cancelled_is_terminal
before update of status on public.automatic_case_reanalysis_requests
for each row execute function public.prevent_cancelled_reanalysis_restart();

create or replace function public.prevent_cancelled_reanalysis_proposal()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    request_status text;
begin
    select request.status into request_status
    from public.automatic_case_reanalysis_requests as request
    where request.id = new.request_id;

    if request_status = 'cancelled' then
        raise exception 'A cancelled re-analysis request cannot store a new proposal.';
    end if;
    return new;
end;
$function$;

create trigger automatic_case_reanalysis_no_cancelled_proposal
before insert on public.automatic_case_reanalysis_proposals
for each row execute function public.prevent_cancelled_reanalysis_proposal();

create or replace function public.sync_project_wide_reanalysis_batch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    batch_id_to_sync uuid := new.project_reanalysis_batch_id;
    queued_count integer;
    processing_count integer;
    proposal_count integer;
    approved_count integer;
    rejected_count integer;
    failed_count integer;
    cancelled_count integer;
    total_count integer;
    cancellation_time timestamptz;
begin
    if batch_id_to_sync is null then
        return new;
    end if;

    select batch.cancellation_requested_at
    into cancellation_time
    from public.analysis_framework_reanalysis_batches as batch
    where batch.id = batch_id_to_sync;

    select
        count(*) filter (where request.status = 'queued')::integer,
        count(*) filter (where request.status = 'processing')::integer,
        count(*) filter (where request.status = 'proposal_ready')::integer,
        count(*) filter (where request.status = 'approved')::integer,
        count(*) filter (where request.status = 'rejected')::integer,
        count(*) filter (where request.status = 'failed')::integer,
        count(*) filter (where request.status = 'cancelled')::integer,
        count(*)::integer
    into queued_count, processing_count, proposal_count,
         approved_count, rejected_count, failed_count,
         cancelled_count, total_count
    from public.automatic_case_reanalysis_requests as request
    where request.project_reanalysis_batch_id = batch_id_to_sync;

    update public.analysis_framework_reanalysis_batches as batch
    set queued_case_count = queued_count,
        processing_case_count = processing_count,
        proposal_ready_case_count = proposal_count,
        approved_case_count = approved_count,
        rejected_case_count = rejected_count,
        failed_case_count = failed_count,
        cancelled_case_count = cancelled_count,
        status = case
            when cancellation_time is not null then 'cancelled'
            when total_count = 0 then 'empty'
            when processing_count > 0 then 'processing'
            when queued_count > 0 then 'queued'
            when proposal_count > 0 then 'awaiting_review'
            when failed_count > 0 then 'completed_with_failures'
            else 'completed'
        end,
        completed_at = case
            when cancellation_time is not null
              or total_count = 0
              or (queued_count = 0 and processing_count = 0
                  and proposal_count = 0)
            then coalesce(batch.completed_at, now())
            else null
        end,
        updated_at = now()
    where batch.id = batch_id_to_sync;

    return new;
end;
$function$;

create or replace function public.cancel_project_wide_reanalysis_batch(
    p_batch_id uuid,
    p_cancellation_reason text
)
returns table (
    batch_id uuid,
    cancelled_case_count integer,
    batch_status text
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    selected_batch public.analysis_framework_reanalysis_batches%rowtype;
    cancellation_time timestamptz := clock_timestamp();
    stored_cancelled_count integer := 0;
begin
    if btrim(coalesce(p_cancellation_reason, '')) = '' then
        raise exception 'A cancellation reason is required.';
    end if;

    select * into selected_batch
    from public.analysis_framework_reanalysis_batches as batch
    where batch.id = p_batch_id
    for update;

    if not found then
        raise exception 'The project-wide re-analysis run was not found.';
    end if;

    if selected_batch.status in ('cancelled', 'completed', 'empty') then
        raise exception 'This project-wide run is already terminal.';
    end if;

    update public.analysis_framework_reanalysis_batches as batch
    set status = 'cancellation_requested',
        cancellation_requested_at = cancellation_time,
        cancellation_reason = btrim(p_cancellation_reason),
        cancelled_by = 'researcher',
        updated_at = cancellation_time
    where batch.id = p_batch_id;

    update public.automatic_case_reanalysis_requests as request
    set status = 'cancelled',
        cancelled_at = cancellation_time,
        cancellation_reason = btrim(p_cancellation_reason),
        last_error = null
    where request.project_reanalysis_batch_id = p_batch_id
      and request.status in (
          'queued', 'processing', 'proposal_ready', 'failed'
      );

    get diagnostics stored_cancelled_count = row_count;

    insert into public.automatic_case_reanalysis_events (
        request_id, event_type, actor, details
    )
    select
        request.id,
        'cancelled',
        'researcher',
        jsonb_build_object(
            'batchId', p_batch_id,
            'reason', btrim(p_cancellation_reason),
            'cancelledAt', cancellation_time,
            'currentReportPreserved', true,
            'proposalRetainedForAudit', exists (
                select 1
                from public.automatic_case_reanalysis_proposals as proposal
                where proposal.request_id = request.id
            )
        )
    from public.automatic_case_reanalysis_requests as request
    where request.project_reanalysis_batch_id = p_batch_id
      and request.cancelled_at = cancellation_time;

    update public.analysis_framework_reanalysis_batches as batch
    set status = 'cancelled',
        cancelled_case_count = stored_cancelled_count,
        queued_case_count = 0,
        processing_case_count = 0,
        proposal_ready_case_count = 0,
        failed_case_count = 0,
        cancelled_at = cancellation_time,
        completed_at = cancellation_time,
        updated_at = cancellation_time
    where batch.id = p_batch_id;

    return query select p_batch_id, stored_cancelled_count, 'cancelled'::text;
end;
$function$;

create or replace function public.save_analysis_framework_version_with_batch(
    p_project_id uuid,
    p_project_name text,
    p_research_topic text,
    p_study_scope text,
    p_theme_requirements text,
    p_code_derivation_rules text,
    p_theme_code_fit_rules text,
    p_inclusion_rules text,
    p_exclusion_rules text,
    p_provenance_expectations text,
    p_application_scope text,
    p_version_notes text default null
)
returns table (
    framework_id uuid,
    project_id uuid,
    version_number integer,
    historical_requests_queued integer,
    historical_batch_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    saved record;
    batch_result record;
    effective_scope text;
begin
    select null::uuid as batch_id, 0::integer as queued_case_count
    into batch_result;

    effective_scope := case
        when p_application_scope = 'include_completed' then 'future_only'
        else p_application_scope
    end;

    select * into saved
    from public.save_analysis_framework_version(
        p_project_id,
        p_project_name,
        p_research_topic,
        p_study_scope,
        p_theme_requirements,
        p_code_derivation_rules,
        p_theme_code_fit_rules,
        p_inclusion_rules,
        p_exclusion_rules,
        p_provenance_expectations,
        effective_scope,
        p_version_notes
    );

    if p_application_scope = 'include_completed' then
        update public.analysis_frameworks as framework
        set application_scope = 'include_completed'
        where framework.id = saved.framework_id;

        update public.analysis_framework_events as framework_event
        set details = framework_event.details || jsonb_build_object(
            'applicationScope', 'include_completed'
        )
        where framework_event.framework_id = saved.framework_id
          and framework_event.event_type = 'activated';

        select * into batch_result
        from public.create_project_wide_reanalysis_batch(
            saved.project_id,
            saved.framework_id,
            'analysis_framework_changed',
            'Apply newly saved Analysis Framework v'
                || saved.version_number::text
                || ' to eligible completed cases in this project/topic. '
                || 'Preserve current reports until individual approval.'
        );
    end if;

    return query select
        saved.framework_id,
        saved.project_id,
        saved.version_number,
        coalesce(batch_result.queued_case_count, 0)::integer,
        batch_result.batch_id;
end;
$function$;

revoke all on function public.cancel_project_wide_reanalysis_batch(uuid, text)
from public, anon, authenticated;
grant execute on function public.cancel_project_wide_reanalysis_batch(uuid, text)
to service_role;

revoke all on function public.save_analysis_framework_version_with_batch(
    uuid, text, text, text, text, text, text, text, text, text, text, text
)
from public, anon, authenticated;
grant execute on function public.save_analysis_framework_version_with_batch(
    uuid, text, text, text, text, text, text, text, text, text, text, text
)
to service_role;

revoke all on function public.prevent_cancelled_reanalysis_restart()
from public, anon, authenticated;
revoke all on function public.prevent_cancelled_reanalysis_proposal()
from public, anon, authenticated;
