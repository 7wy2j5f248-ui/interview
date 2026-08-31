create table public.research_project_case_memberships (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null
        references public.research_projects(id) on delete restrict,
    session_id text not null
        references public.interview_sessions(session_id) on delete restrict,
    source_report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    reason text not null,
    bound_by text not null default 'researcher',
    bound_at timestamptz not null default now(),
    constraint research_project_case_membership_unique
        unique (project_id, session_id, source_report_id),
    constraint research_project_case_membership_reason_not_blank
        check (btrim(reason) <> '')
);

comment on table public.research_project_case_memberships is
    'Append-only explicit project/topic lineage for a preserved legacy case report. The historical report row itself is never rewritten.';

alter table public.research_project_case_memberships enable row level security;
revoke all on table public.research_project_case_memberships
from public, anon, authenticated;
grant select, insert on table public.research_project_case_memberships
to service_role;

insert into public.research_project_case_memberships (
    project_id,
    session_id,
    source_report_id,
    reason,
    bound_by
)
select
    project.id,
    report.session_id,
    report.id,
    'Researcher explicitly included legacy Case 34 in the Sleeping habits project revision without altering its preserved historical report.',
    'researcher-authorized-migration'
from public.research_projects as project
join public.qualitative_case_reports as report
  on report.session_id = 'S1783783759083'
 and report.case_number = 'P0034-S01'
 and report.superseded_at is null
where project.project_code = 'SLEEPING-HABITS'
on conflict (project_id, session_id, source_report_id) do nothing;

drop index if exists public.automatic_case_reanalysis_one_open_request_idx;

create unique index automatic_case_reanalysis_one_processing_request_idx
on public.automatic_case_reanalysis_requests(session_id)
where status in ('queued', 'processing');

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
    with scoped_reports as (
        select report.session_id, job.archived_at
        from public.qualitative_case_reports as report
        join public.automatic_case_analysis_jobs as job
          on job.session_id = report.session_id
         and job.status = 'completed'
        join public.interview_sessions as session
          on session.session_id = report.session_id
         and session.completed = true
         and session.completed_at is not null
        left join public.research_designs as design
          on design.id = session.research_design_id
        where report.superseded_at is null
          and (
              report.project_id = selected_project.id
              or design.project_id = selected_project.id
              or exists (
                  select 1
                  from public.research_project_case_memberships as membership
                  where membership.project_id = selected_project.id
                    and membership.session_id = report.session_id
                    and membership.source_report_id = report.id
              )
          )
    ), classified as (
        select
            scoped.session_id,
            scoped.archived_at is not null as is_archived,
            exists (
                select 1
                from public.automatic_case_reanalysis_requests as request
                where request.session_id = scoped.session_id
                  and request.status in ('queued', 'processing')
            ) as has_active_processing_request
        from scoped_reports as scoped
    )
    select
        selected_project.id,
        selected_project.project_name,
        selected_project.research_topic,
        selected_framework.id,
        selected_framework.version_number,
        count(*) filter (
            where not classified.is_archived
              and not classified.has_active_processing_request
        )::integer,
        count(*) filter (
            where not classified.is_archived
              and classified.has_active_processing_request
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
            'analysisVersion', 'case-reanalysis-v5-meaning-units-categories-proposed',
            'eligibleCaseCount', preview.eligible_case_count,
            'openRequestExcludedCount', preview.open_request_excluded_count,
            'archivedCaseExcludedCount', preview.archived_case_excluded_count,
            'currentReportsPreserved', true,
            'resultsAreProposals', true,
            'automaticPromotion', false,
            'researcherApprovalRequiredPerCaseToInspect', false
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
        left join public.research_designs as design
          on design.id = session.research_design_id
        left join public.automatic_case_reanalysis_requests as existing
          on existing.session_id = report.session_id
        where report.superseded_at is null
          and (
              report.project_id = p_project_id
              or design.project_id = p_project_id
              or exists (
                  select 1
                  from public.research_project_case_memberships as membership
                  where membership.project_id = p_project_id
                    and membership.session_id = report.session_id
                    and membership.source_report_id = report.id
              )
          )
          and not exists (
              select 1
              from public.automatic_case_reanalysis_requests as active_request
              where active_request.session_id = report.session_id
                and active_request.status in ('queued', 'processing')
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
            'case-reanalysis-v5-meaning-units-categories-proposed',
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
                'analysisVersion', 'case-reanalysis-v5-meaning-units-categories-proposed',
                'currentReportPreserved', true,
                'resultIsProposal', true,
                'automaticPromotion', false,
                'researcherApprovalRequiredToInspect', false
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

revoke all on function public.preview_project_wide_reanalysis(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.preview_project_wide_reanalysis(uuid, uuid)
to service_role;

revoke all on function public.create_project_wide_reanalysis_batch(
    uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.create_project_wide_reanalysis_batch(
    uuid, uuid, text, text
) to service_role;

comment on function public.create_project_wide_reanalysis_batch(
    uuid, uuid, text, text
) is
    'Creates one proposal-only revision request per eligible project case. Prior and current reports remain unchanged; inspecting or downloading proposals never promotes them.';

revoke execute on function public.complete_automatic_case_reanalysis(uuid)
from service_role;

comment on function public.complete_automatic_case_reanalysis(uuid) is
    'Legacy automatic-promotion helper retained only for database lineage. Execution is disabled; proposal inspection and download never promote reports.';
