create table public.analysis_framework_reanalysis_batches (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null
        references public.research_projects(id) on delete restrict,
    analysis_framework_id uuid not null
        references public.analysis_frameworks(id) on delete restrict,
    reason_code text not null default 'analysis_framework_changed',
    researcher_notes text not null,
    requested_by text not null default 'researcher',
    status text not null default 'queued',
    eligible_case_count integer not null default 0,
    queued_case_count integer not null default 0,
    processing_case_count integer not null default 0,
    proposal_ready_case_count integer not null default 0,
    approved_case_count integer not null default 0,
    rejected_case_count integer not null default 0,
    failed_case_count integer not null default 0,
    scope_snapshot jsonb not null,
    requested_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    constraint analysis_framework_reanalysis_batch_reason_valid
        check (reason_code in ('analysis_framework_changed', 'other')),
    constraint analysis_framework_reanalysis_batch_notes_not_blank
        check (btrim(researcher_notes) <> ''),
    constraint analysis_framework_reanalysis_batch_status_valid
        check (status in (
            'queued', 'processing', 'awaiting_review',
            'completed', 'completed_with_failures', 'empty'
        )),
    constraint analysis_framework_reanalysis_batch_scope_object
        check (jsonb_typeof(scope_snapshot) = 'object'),
    constraint analysis_framework_reanalysis_batch_counts_nonnegative
        check (
            eligible_case_count >= 0 and queued_case_count >= 0
            and processing_case_count >= 0
            and proposal_ready_case_count >= 0
            and approved_case_count >= 0
            and rejected_case_count >= 0
            and failed_case_count >= 0
        )
);

comment on table public.analysis_framework_reanalysis_batches is
    'Researcher-confirmed project-wide re-analysis runs. Every eligible case remains a separate versioned proposal and no current report is overwritten or approved by the batch.';

alter table public.automatic_case_reanalysis_requests
add column project_reanalysis_batch_id uuid
    references public.analysis_framework_reanalysis_batches(id)
    on delete restrict;

create index analysis_framework_reanalysis_batches_project_time_idx
on public.analysis_framework_reanalysis_batches(project_id, requested_at desc);

create index analysis_framework_reanalysis_batches_framework_idx
on public.analysis_framework_reanalysis_batches(analysis_framework_id);

create index automatic_case_reanalysis_batch_status_idx
on public.automatic_case_reanalysis_requests(
    project_reanalysis_batch_id, status, requested_at
)
where project_reanalysis_batch_id is not null;

create or replace function public.preview_project_wide_reanalysis(
    p_project_id uuid,
    p_analysis_framework_id uuid
)
returns table (
    project_id uuid,
    project_name text,
    research_topic text,
    analysis_framework_id uuid,
    framework_version integer,
    eligible_case_count integer,
    open_request_excluded_count integer,
    archived_case_excluded_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    selected_project public.research_projects%rowtype;
    selected_framework public.analysis_frameworks%rowtype;
begin
    select * into selected_project
    from public.research_projects as project
    where project.id = p_project_id;

    select * into selected_framework
    from public.analysis_frameworks as framework
    where framework.id = p_analysis_framework_id;

    if selected_project.id is null or selected_framework.id is null
       or selected_framework.project_id <> selected_project.id then
        raise exception 'The selected Analysis Framework does not belong to this research project/topic.';
    end if;

    return query
    with active_reports as (
        select report.session_id, job.archived_at
        from public.qualitative_case_reports as report
        join public.automatic_case_analysis_jobs as job
          on job.session_id = report.session_id
         and job.status = 'completed'
        join public.interview_sessions as session
          on session.session_id = report.session_id
         and session.completed = true
         and session.completed_at is not null
        join public.research_designs as design
          on design.id = session.research_design_id
         and design.project_id = selected_project.id
        where report.superseded_at is null
    ), classified as (
        select
            active.session_id,
            active.archived_at is not null as is_archived,
            exists (
                select 1
                from public.automatic_case_reanalysis_requests as request
                where request.session_id = active.session_id
                  and request.status in ('queued', 'processing', 'proposal_ready')
            ) as has_open_request
        from active_reports as active
    )
    select
        selected_project.id,
        selected_project.project_name,
        selected_project.research_topic,
        selected_framework.id,
        selected_framework.version_number,
        count(*) filter (
            where not classified.is_archived
              and not classified.has_open_request
        )::integer,
        count(*) filter (
            where not classified.is_archived
              and classified.has_open_request
        )::integer,
        count(*) filter (where classified.is_archived)::integer
    from classified;
end;
$function$;

create or replace function public.create_project_wide_reanalysis_batch(
    p_project_id uuid,
    p_analysis_framework_id uuid,
    p_reason_code text,
    p_researcher_notes text
)
returns table (
    batch_id uuid,
    eligible_case_count integer,
    queued_case_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    preview record;
    stored_batch_id uuid;
    inserted_count integer := 0;
begin
    if p_reason_code not in ('analysis_framework_changed', 'other')
       or btrim(coalesce(p_researcher_notes, '')) = '' then
        raise exception 'A valid project-wide reason and researcher notes are required.';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        'project_wide_reanalysis:' || p_project_id::text, 0
    ));

    select * into preview
    from public.preview_project_wide_reanalysis(
        p_project_id, p_analysis_framework_id
    );

    insert into public.analysis_framework_reanalysis_batches (
        project_id,
        analysis_framework_id,
        reason_code,
        researcher_notes,
        eligible_case_count,
        scope_snapshot
    ) values (
        p_project_id,
        p_analysis_framework_id,
        p_reason_code,
        btrim(p_researcher_notes),
        preview.eligible_case_count,
        jsonb_build_object(
            'projectId', preview.project_id,
            'projectName', preview.project_name,
            'researchTopic', preview.research_topic,
            'analysisFrameworkId', preview.analysis_framework_id,
            'analysisFrameworkVersion', preview.framework_version,
            'eligibleCaseCount', preview.eligible_case_count,
            'openRequestExcludedCount', preview.open_request_excluded_count,
            'archivedCaseExcludedCount', preview.archived_case_excluded_count,
            'currentReportsPreserved', true,
            'researcherApprovalRequiredPerCase', true
        )
    ) returning id into stored_batch_id;

    with eligible as (
        select
            report.session_id,
            report.id as source_report_id,
            coalesce(max(existing.request_number), 0) + 1 as request_number
        from public.qualitative_case_reports as report
        join public.automatic_case_analysis_jobs as job
          on job.session_id = report.session_id
         and job.status = 'completed'
         and job.archived_at is null
        join public.interview_sessions as session
          on session.session_id = report.session_id
         and session.completed = true
         and session.completed_at is not null
        join public.research_designs as design
          on design.id = session.research_design_id
         and design.project_id = p_project_id
        left join public.automatic_case_reanalysis_requests as existing
          on existing.session_id = report.session_id
        where report.superseded_at is null
          and not exists (
              select 1
              from public.automatic_case_reanalysis_requests as open_request
              where open_request.session_id = report.session_id
                and open_request.status in ('queued', 'processing', 'proposal_ready')
          )
        group by report.session_id, report.id
    ), inserted as (
        insert into public.automatic_case_reanalysis_requests (
            session_id,
            source_report_id,
            request_number,
            reason_code,
            researcher_notes,
            requested_by,
            analysis_version,
            project_id,
            analysis_framework_id,
            project_reanalysis_batch_id
        )
        select
            eligible.session_id,
            eligible.source_report_id,
            eligible.request_number,
            p_reason_code,
            btrim(p_researcher_notes),
            'project_wide_reanalysis',
            'case-reanalysis-v2-framework-governed',
            p_project_id,
            p_analysis_framework_id,
            stored_batch_id
        from eligible
        returning id, source_report_id
    ), events as (
        insert into public.automatic_case_reanalysis_events (
            request_id, event_type, actor, details
        )
        select
            inserted.id,
            'requested',
            'project_wide_reanalysis',
            jsonb_build_object(
                'batchId', stored_batch_id,
                'sourceReportId', inserted.source_report_id,
                'projectId', p_project_id,
                'analysisFrameworkId', p_analysis_framework_id,
                'currentReportPreserved', true,
                'researcherApprovalRequired', true
            )
        from inserted
    )
    select count(*) into inserted_count from inserted;

    update public.analysis_framework_reanalysis_batches as batch
    set queued_case_count = inserted_count,
        eligible_case_count = inserted_count,
        status = case when inserted_count = 0 then 'empty' else 'queued' end,
        completed_at = case when inserted_count = 0 then now() else null end,
        updated_at = now()
    where batch.id = stored_batch_id;

    return query select stored_batch_id, inserted_count, inserted_count;
end;
$function$;

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
    total_count integer;
begin
    if batch_id_to_sync is null then
        return new;
    end if;

    select
        count(*) filter (where request.status = 'queued')::integer,
        count(*) filter (where request.status = 'processing')::integer,
        count(*) filter (where request.status = 'proposal_ready')::integer,
        count(*) filter (where request.status = 'approved')::integer,
        count(*) filter (where request.status = 'rejected')::integer,
        count(*) filter (where request.status = 'failed')::integer,
        count(*)::integer
    into queued_count, processing_count, proposal_count,
         approved_count, rejected_count, failed_count, total_count
    from public.automatic_case_reanalysis_requests as request
    where request.project_reanalysis_batch_id = batch_id_to_sync;

    update public.analysis_framework_reanalysis_batches as batch
    set queued_case_count = queued_count,
        processing_case_count = processing_count,
        proposal_ready_case_count = proposal_count,
        approved_case_count = approved_count,
        rejected_case_count = rejected_count,
        failed_case_count = failed_count,
        status = case
            when total_count = 0 then 'empty'
            when processing_count > 0 then 'processing'
            when queued_count > 0 then 'queued'
            when proposal_count > 0 then 'awaiting_review'
            when failed_count > 0 then 'completed_with_failures'
            else 'completed'
        end,
        completed_at = case
            when total_count = 0
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

create trigger automatic_case_reanalysis_sync_batch
after update of status on public.automatic_case_reanalysis_requests
for each row
when (new.project_reanalysis_batch_id is not null)
execute function public.sync_project_wide_reanalysis_batch();

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

alter table public.analysis_framework_reanalysis_batches
enable row level security;

revoke all on table public.analysis_framework_reanalysis_batches
from anon, authenticated;

grant select, insert, update on table
    public.analysis_framework_reanalysis_batches
to service_role;

revoke all on function public.preview_project_wide_reanalysis(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.preview_project_wide_reanalysis(uuid, uuid)
to service_role;

revoke all on function public.create_project_wide_reanalysis_batch(
    uuid, uuid, text, text
)
from public, anon, authenticated;
grant execute on function public.create_project_wide_reanalysis_batch(
    uuid, uuid, text, text
)
to service_role;

revoke all on function public.sync_project_wide_reanalysis_batch()
from public, anon, authenticated;
grant execute on function public.sync_project_wide_reanalysis_batch()
to service_role;
