-- Keep project-wide historical re-analysis strictly serial. Multiple public
-- design loads can wake the durable worker at the same time; only the first
-- transaction may claim a case while another fresh request is processing.
create or replace function public.claim_next_framework_reanalysis()
returns table (
    request_id uuid,
    session_id text,
    project_id uuid,
    analysis_framework_id uuid,
    attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    perform pg_advisory_xact_lock(hashtextextended(
        'analysis_framework_reanalysis_fifo', 0
    ));

    if exists (
        select 1
        from public.automatic_case_reanalysis_requests as active_request
        where active_request.status = 'processing'
          and active_request.processing_started_at
              >= now() - interval '15 minutes'
    ) then
        return;
    end if;

    return query
    with candidate as (
        select request.id
        from public.automatic_case_reanalysis_requests as request
        join public.automatic_case_analysis_jobs as job
          on job.session_id = request.session_id
        where request.requested_by in (
            'analysis_framework_scope', 'project_wide_reanalysis'
        )
          and (
              request.status in ('queued', 'failed')
              or (
                  request.status = 'processing'
                  and request.processing_started_at
                      < now() - interval '15 minutes'
              )
          )
          and request.attempt_count < 5
          and job.archived_at is null
        order by request.requested_at, request.id
        for update of request skip locked
        limit 1
    )
    update public.automatic_case_reanalysis_requests as request
    set status = 'processing',
        attempt_count = request.attempt_count + 1,
        processing_started_at = now(),
        model = null,
        last_error = null
    from candidate
    where request.id = candidate.id
    returning
        request.id,
        request.session_id,
        request.project_id,
        request.analysis_framework_id,
        request.attempt_count;
end;
$function$;

revoke all on function public.claim_next_framework_reanalysis()
from public, anon, authenticated;

grant execute on function public.claim_next_framework_reanalysis()
to service_role;
