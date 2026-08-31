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
            when failed_count > 0 then 'completed_with_failures'
            else 'completed'
        end,
        completed_at = case
            when cancellation_time is not null
              or total_count = 0
              or (queued_count = 0 and processing_count = 0)
            then coalesce(batch.completed_at, now())
            else null
        end,
        updated_at = now()
    where batch.id = batch_id_to_sync;

    return new;
end;
$function$;

comment on function public.sync_project_wide_reanalysis_batch() is
    'Marks proposal generation complete when every case is terminal. Unreviewed proposals do not block batch completion or consolidated export.';

with counts as (
    select
        batch.id,
        count(request.id) filter (where request.status = 'queued')::integer
            as queued_count,
        count(request.id) filter (where request.status = 'processing')::integer
            as processing_count,
        count(request.id) filter (where request.status = 'proposal_ready')::integer
            as proposal_count,
        count(request.id) filter (where request.status = 'approved')::integer
            as approved_count,
        count(request.id) filter (where request.status = 'rejected')::integer
            as rejected_count,
        count(request.id) filter (where request.status = 'failed')::integer
            as failed_count,
        count(request.id) filter (where request.status = 'cancelled')::integer
            as cancelled_count,
        count(request.id)::integer as total_count
    from public.analysis_framework_reanalysis_batches as batch
    left join public.automatic_case_reanalysis_requests as request
      on request.project_reanalysis_batch_id = batch.id
    where batch.status <> 'cancelled'
      and batch.cancellation_requested_at is null
    group by batch.id
)
update public.analysis_framework_reanalysis_batches as batch
set queued_case_count = counts.queued_count,
    processing_case_count = counts.processing_count,
    proposal_ready_case_count = counts.proposal_count,
    approved_case_count = counts.approved_count,
    rejected_case_count = counts.rejected_count,
    failed_case_count = counts.failed_count,
    cancelled_case_count = counts.cancelled_count,
    status = case
        when counts.total_count = 0 then 'empty'
        when counts.processing_count > 0 then 'processing'
        when counts.queued_count > 0 then 'queued'
        when counts.failed_count > 0 then 'completed_with_failures'
        else 'completed'
    end,
    completed_at = case
        when counts.total_count = 0
          or (counts.queued_count = 0 and counts.processing_count = 0)
        then coalesce(batch.completed_at, now())
        else null
    end,
    updated_at = now()
from counts
where batch.id = counts.id;

