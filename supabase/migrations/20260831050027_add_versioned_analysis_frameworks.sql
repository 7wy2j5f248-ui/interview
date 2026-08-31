create table public.research_projects (
    id uuid primary key default gen_random_uuid(),
    project_code text not null unique,
    project_name text not null,
    research_topic text not null,
    created_at timestamptz not null default now(),
    created_by text not null default 'researcher',
    constraint research_projects_code_not_blank
        check (btrim(project_code) <> ''),
    constraint research_projects_name_not_blank
        check (btrim(project_name) <> ''),
    constraint research_projects_topic_not_blank
        check (btrim(research_topic) <> '')
);

comment on table public.research_projects is
    'Stable named research-project and topic lineages shared by interview-protocol versions and analysis-framework versions.';

alter table public.research_designs
add column project_id uuid
    references public.research_projects(id) on delete restrict;

comment on column public.research_designs.project_id is
    'The stable research project/topic lineage. Protocol versions may change without changing this project identity.';

with inserted_project as (
    insert into public.research_projects (
        project_code, project_name, research_topic, created_by
    ) values (
        'SLEEPING-HABITS',
        'Sleeping habits',
        'Sleeping habits',
        'system-migration'
    )
    on conflict (project_code) do update
    set project_name = excluded.project_name
    returning id
)
update public.research_designs as design
set project_id = inserted_project.id
from inserted_project
where design.project_id is null
  and (
      lower(coalesce(design.research_title, '')) like '%sleep%'
      or lower(coalesce(design.interview_topic, '')) like '%sleep%'
  );

create table public.analysis_frameworks (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null
        references public.research_projects(id) on delete restrict,
    version_number integer not null,
    predecessor_id uuid
        references public.analysis_frameworks(id) on delete restrict,
    study_scope text not null,
    theme_requirements text not null,
    code_derivation_rules text not null,
    theme_code_fit_rules text not null,
    inclusion_rules text not null,
    exclusion_rules text not null,
    provenance_expectations text not null,
    application_scope text not null,
    version_notes text,
    created_at timestamptz not null default now(),
    created_by text not null default 'researcher',
    constraint analysis_frameworks_project_version_unique
        unique (project_id, version_number),
    constraint analysis_frameworks_version_positive
        check (version_number > 0),
    constraint analysis_frameworks_scope_valid
        check (application_scope in ('future_only', 'include_completed')),
    constraint analysis_frameworks_required_text
        check (
            btrim(study_scope) <> ''
            and btrim(theme_requirements) <> ''
            and btrim(code_derivation_rules) <> ''
            and btrim(theme_code_fit_rules) <> ''
            and btrim(inclusion_rules) <> ''
            and btrim(exclusion_rules) <> ''
            and btrim(provenance_expectations) <> ''
        )
);

comment on table public.analysis_frameworks is
    'Immutable, independently versioned analysis instructions bound to one named research project and topic lineage.';

create table public.active_analysis_frameworks (
    project_id uuid primary key
        references public.research_projects(id) on delete restrict,
    framework_id uuid not null unique
        references public.analysis_frameworks(id) on delete restrict,
    activated_at timestamptz not null default now(),
    activated_by text not null default 'researcher'
);

create table public.analysis_framework_events (
    id bigint generated always as identity primary key,
    framework_id uuid not null
        references public.analysis_frameworks(id) on delete restrict,
    event_type text not null,
    actor text not null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint analysis_framework_events_type_not_blank
        check (btrim(event_type) <> ''),
    constraint analysis_framework_events_actor_not_blank
        check (btrim(actor) <> ''),
    constraint analysis_framework_events_details_object
        check (jsonb_typeof(details) = 'object')
);

create index analysis_frameworks_project_time_idx
on public.analysis_frameworks(project_id, version_number desc);

create index analysis_framework_events_framework_time_idx
on public.analysis_framework_events(framework_id, created_at);

with sleeping_project as (
    select id
    from public.research_projects
    where project_code = 'SLEEPING-HABITS'
), inserted_framework as (
    insert into public.analysis_frameworks (
        project_id,
        version_number,
        study_scope,
        theme_requirements,
        code_derivation_rules,
        theme_code_fit_rules,
        inclusion_rules,
        exclusion_rules,
        provenance_expectations,
        application_scope,
        version_notes,
        created_by
    )
    select
        id,
        1,
        'Analyse each formally completed interview as one individual case. The study concerns participants'' sleeping habits and their explicitly connected contexts, determinants, and outcomes.',
        'Themes must be broad, comparable one- or two-word English subject labels that directly concern sleeping habits. A contextual theme is permitted only when the participant explicitly connects it to sleep.',
        'Derive each concise English code bottom-up from one or more related exact keyword occurrences in the participant''s preserved original-language transcript. Exact quotation is necessary but not sufficient: every keyword must semantically support its code.',
        'Every code must belong to at least one theme, and its meaning and exact evidence must materially support that theme. Reject unrelated cross-topic evidence.',
        'Include participant statements about sleep behaviour, routines, duration, timing, waking, conditions, determinants, strategies, satisfaction, and outcomes. Include contextual activity only when its connection to sleep is explicit.',
        'Exclude greetings, courtesies, interviewer wording, generic technology, AI chatbot, media, work, family, or other activity unless the participant explicitly links it to sleep. Never infer a sleep connection merely because the interview protocol asked about the topic.',
        'Retain exact message IDs, exact original-language keyword text, character offsets, code-to-keyword links, theme-to-code links, model, timestamps, project identity, framework version, and source-report lineage. Present AI analysis as reviewable output rather than confirmed findings.',
        'future_only',
        'Initial explicit framework reconstructed from the existing sleeping-habits analysis rules. It does not retroactively replace any prior report.',
        'system-migration'
    from sleeping_project
    on conflict (project_id, version_number) do nothing
    returning id, project_id
)
insert into public.active_analysis_frameworks (
    project_id, framework_id, activated_by
)
select project_id, id, 'system-migration'
from inserted_framework
on conflict (project_id) do update
set framework_id = excluded.framework_id,
    activated_at = now(),
    activated_by = excluded.activated_by;

alter table public.automatic_case_analysis_jobs
add column project_id uuid
    references public.research_projects(id) on delete restrict,
add column analysis_framework_id uuid
    references public.analysis_frameworks(id) on delete restrict;

alter table public.qualitative_case_reports
add column project_id uuid
    references public.research_projects(id) on delete restrict,
add column analysis_framework_id uuid
    references public.analysis_frameworks(id) on delete restrict;

comment on column public.qualitative_case_reports.project_id is
    'Named research-project/topic lineage used by this report.';

comment on column public.qualitative_case_reports.analysis_framework_id is
    'Immutable analysis-framework version used by this report; null means a legacy pre-framework report.';

update public.automatic_case_analysis_jobs as job
set project_id = design.project_id
from public.interview_sessions as session
join public.research_designs as design
  on design.id = session.research_design_id
where session.session_id = job.session_id
  and job.project_id is null;

update public.qualitative_case_reports as report
set project_id = design.project_id
from public.interview_sessions as session
join public.research_designs as design
  on design.id = session.research_design_id
where session.session_id = report.session_id
  and report.project_id is null;

update public.automatic_case_analysis_jobs as job
set analysis_framework_id = active.framework_id
from public.active_analysis_frameworks as active
where active.project_id = job.project_id
  and job.status <> 'completed'
  and job.analysis_framework_id is null;

alter table public.automatic_case_reanalysis_requests
add column project_id uuid
    references public.research_projects(id) on delete restrict,
add column analysis_framework_id uuid
    references public.analysis_frameworks(id) on delete restrict;

alter table public.automatic_case_reanalysis_proposals
add column project_id uuid
    references public.research_projects(id) on delete restrict,
add column analysis_framework_id uuid
    references public.analysis_frameworks(id) on delete restrict;

alter table public.automatic_case_reanalysis_requests
drop constraint automatic_case_reanalysis_reason_valid;

alter table public.automatic_case_reanalysis_requests
add constraint automatic_case_reanalysis_reason_valid
check (reason_code in (
    'keywords_unrelated_to_theme',
    'evidence_theme_mismatch',
    'analysis_framework_changed',
    'other'
));

update public.automatic_case_reanalysis_requests as request
set
    project_id = report.project_id,
    analysis_framework_id = active.framework_id
from public.qualitative_case_reports as report
left join public.active_analysis_frameworks as active
  on active.project_id = report.project_id
where report.id = request.source_report_id
  and request.project_id is null;

update public.automatic_case_reanalysis_proposals as proposal
set
    project_id = request.project_id,
    analysis_framework_id = request.analysis_framework_id
from public.automatic_case_reanalysis_requests as request
where request.id = proposal.request_id
  and proposal.project_id is null;

create or replace function public.bind_automatic_case_job_framework()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if new.project_id is null then
        select design.project_id
        into new.project_id
        from public.interview_sessions as session
        join public.research_designs as design
          on design.id = session.research_design_id
        where session.session_id = new.session_id;
    end if;

    if new.analysis_framework_id is null and new.project_id is not null then
        select active.framework_id
        into new.analysis_framework_id
        from public.active_analysis_frameworks as active
        where active.project_id = new.project_id;
    end if;

    return new;
end;
$function$;

create trigger automatic_case_jobs_bind_framework
before insert on public.automatic_case_analysis_jobs
for each row execute function public.bind_automatic_case_job_framework();

create or replace function public.bind_reanalysis_framework()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    framework_project_id uuid;
begin
    if new.project_id is null then
        select report.project_id
        into new.project_id
        from public.qualitative_case_reports as report
        where report.id = new.source_report_id;
    end if;

    if new.analysis_framework_id is null and new.project_id is not null then
        select active.framework_id
        into new.analysis_framework_id
        from public.active_analysis_frameworks as active
        where active.project_id = new.project_id;
    end if;

    if new.project_id is null or new.analysis_framework_id is null then
        raise exception 'The case is not bound to an active project analysis framework.';
    end if;

    select framework.project_id
    into framework_project_id
    from public.analysis_frameworks as framework
    where framework.id = new.analysis_framework_id;

    if framework_project_id is distinct from new.project_id then
        raise exception 'The analysis framework belongs to a different research project/topic lineage.';
    end if;

    return new;
end;
$function$;

create trigger automatic_case_reanalysis_bind_framework
before insert on public.automatic_case_reanalysis_requests
for each row execute function public.bind_reanalysis_framework();

create or replace function public.bind_reanalysis_proposal_framework()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    select request.project_id, request.analysis_framework_id
    into new.project_id, new.analysis_framework_id
    from public.automatic_case_reanalysis_requests as request
    where request.id = new.request_id;

    if new.project_id is null or new.analysis_framework_id is null then
        raise exception 'The proposal has no project/framework lineage.';
    end if;

    return new;
end;
$function$;

create trigger automatic_case_reanalysis_proposal_bind_framework
before insert on public.automatic_case_reanalysis_proposals
for each row execute function public.bind_reanalysis_proposal_framework();

create or replace function public.bind_case_report_framework()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    framework_project_id uuid;
begin
    if new.reanalysis_request_id is not null then
        select request.project_id, request.analysis_framework_id
        into new.project_id, new.analysis_framework_id
        from public.automatic_case_reanalysis_requests as request
        where request.id = new.reanalysis_request_id;
    else
        select job.project_id, job.analysis_framework_id
        into new.project_id, new.analysis_framework_id
        from public.automatic_case_analysis_jobs as job
        where job.session_id = new.session_id;
    end if;

    if new.project_id is null or new.analysis_framework_id is null then
        raise exception 'A new case report must preserve project and analysis-framework lineage.';
    end if;

    select framework.project_id
    into framework_project_id
    from public.analysis_frameworks as framework
    where framework.id = new.analysis_framework_id;

    if framework_project_id is distinct from new.project_id then
        raise exception 'The report framework belongs to a different research project/topic lineage.';
    end if;

    return new;
end;
$function$;

create trigger a_qualitative_case_reports_bind_framework
before insert on public.qualitative_case_reports
for each row execute function public.bind_case_report_framework();

create or replace function public.save_analysis_framework_version(
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
    historical_requests_queued integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    selected_project public.research_projects%rowtype;
    prior_framework_id uuid;
    next_version integer;
    stored_framework_id uuid;
    queued_count integer := 0;
begin
    if btrim(coalesce(p_project_name, '')) = ''
       or btrim(coalesce(p_research_topic, '')) = '' then
        raise exception 'Project name and research topic are required.';
    end if;

    if p_application_scope not in ('future_only', 'include_completed') then
        raise exception 'Choose future analysis only or include completed interviews.';
    end if;

    if p_project_id is null then
        insert into public.research_projects (
            project_code, project_name, research_topic
        ) values (
            'PROJECT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
            btrim(p_project_name),
            btrim(p_research_topic)
        ) returning * into selected_project;
    else
        select * into selected_project
        from public.research_projects
        where id = p_project_id
        for update;

        if not found then
            raise exception 'The selected research project was not found.';
        end if;

        if selected_project.project_name <> btrim(p_project_name)
           or selected_project.research_topic <> btrim(p_research_topic) then
            raise exception 'Project name/topic identity is immutable. Start a new project for a different research topic.';
        end if;
    end if;

    select active.framework_id
    into prior_framework_id
    from public.active_analysis_frameworks as active
    where active.project_id = selected_project.id;

    select coalesce(max(framework.version_number), 0) + 1
    into next_version
    from public.analysis_frameworks as framework
    where framework.project_id = selected_project.id;

    insert into public.analysis_frameworks (
        project_id,
        version_number,
        predecessor_id,
        study_scope,
        theme_requirements,
        code_derivation_rules,
        theme_code_fit_rules,
        inclusion_rules,
        exclusion_rules,
        provenance_expectations,
        application_scope,
        version_notes
    ) values (
        selected_project.id,
        next_version,
        prior_framework_id,
        btrim(p_study_scope),
        btrim(p_theme_requirements),
        btrim(p_code_derivation_rules),
        btrim(p_theme_code_fit_rules),
        btrim(p_inclusion_rules),
        btrim(p_exclusion_rules),
        btrim(p_provenance_expectations),
        p_application_scope,
        nullif(btrim(p_version_notes), '')
    ) returning id into stored_framework_id;

    insert into public.active_analysis_frameworks (
        project_id, framework_id
    ) values (
        selected_project.id, stored_framework_id
    )
    on conflict on constraint active_analysis_frameworks_pkey do update
    set framework_id = excluded.framework_id,
        activated_at = now(),
        activated_by = 'researcher';

    insert into public.analysis_framework_events (
        framework_id, event_type, actor, details
    ) values (
        stored_framework_id,
        'activated',
        'researcher',
        jsonb_build_object(
            'projectId', selected_project.id,
            'projectName', selected_project.project_name,
            'researchTopic', selected_project.research_topic,
            'versionNumber', next_version,
            'predecessorId', prior_framework_id,
            'applicationScope', p_application_scope
        )
    );

    if p_application_scope = 'include_completed' then
        with eligible as (
            select
                report.session_id,
                report.id as source_report_id,
                coalesce(max(existing.request_number), 0) + 1
                    as request_number
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
             and design.project_id = selected_project.id
            left join public.automatic_case_reanalysis_requests as existing
              on existing.session_id = report.session_id
            where report.superseded_at is null
              and not exists (
                  select 1
                  from public.automatic_case_reanalysis_requests as open_request
                  where open_request.session_id = report.session_id
                    and open_request.status in (
                        'queued', 'processing', 'proposal_ready'
                    )
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
                analysis_framework_id
            )
            select
                eligible.session_id,
                eligible.source_report_id,
                eligible.request_number,
                'analysis_framework_changed',
                'Generate a versioned proposal under analysis framework v'
                    || next_version::text || ' for project '
                    || selected_project.project_name
                    || '. Preserve the current report until researcher approval.',
                'analysis_framework_scope',
                'case-reanalysis-v2-framework-governed',
                selected_project.id,
                stored_framework_id
            from eligible
            returning id, source_report_id
        ), events as (
            insert into public.automatic_case_reanalysis_events (
                request_id, event_type, actor, details
            )
            select
                inserted.id,
                'requested',
                'analysis_framework_scope',
                jsonb_build_object(
                    'sourceReportId', inserted.source_report_id,
                    'projectId', selected_project.id,
                    'analysisFrameworkId', stored_framework_id,
                    'analysisFrameworkVersion', next_version,
                    'currentReportPreserved', true,
                    'researcherApprovalRequired', true
                )
            from inserted
        )
        select count(*) into queued_count from inserted;
    end if;

    update public.analysis_framework_events as framework_event
    set details = framework_event.details || jsonb_build_object(
        'historicalRequestsQueued', queued_count
    )
    where framework_event.framework_id = stored_framework_id
      and framework_event.event_type = 'activated';

    return query select
        stored_framework_id,
        selected_project.id,
        next_version,
        queued_count;
end;
$function$;

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
        where request.requested_by = 'analysis_framework_scope'
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

alter table public.research_projects enable row level security;
alter table public.analysis_frameworks enable row level security;
alter table public.active_analysis_frameworks enable row level security;
alter table public.analysis_framework_events enable row level security;

revoke all on table
    public.research_projects,
    public.analysis_frameworks,
    public.active_analysis_frameworks,
    public.analysis_framework_events
from public, anon, authenticated;

grant select, insert on table public.research_projects to service_role;
grant select, insert on table public.analysis_frameworks to service_role;
grant select, insert, update on table public.active_analysis_frameworks
to service_role;
grant select, insert, update on table public.analysis_framework_events
to service_role;
grant usage, select on sequence public.analysis_framework_events_id_seq
to service_role;

revoke all on function public.save_analysis_framework_version(
    uuid, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.save_analysis_framework_version(
    uuid, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

revoke all on function public.claim_next_framework_reanalysis()
from public, anon, authenticated;
grant execute on function public.claim_next_framework_reanalysis()
to service_role;

revoke all on function public.bind_automatic_case_job_framework()
from public, anon, authenticated;
revoke all on function public.bind_reanalysis_framework()
from public, anon, authenticated;
revoke all on function public.bind_reanalysis_proposal_framework()
from public, anon, authenticated;
revoke all on function public.bind_case_report_framework()
from public, anon, authenticated;
