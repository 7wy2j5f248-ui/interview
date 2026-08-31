create table public.global_analysis_rules (
    id uuid primary key default gen_random_uuid(),
    version_number integer not null unique,
    predecessor_id uuid
        references public.global_analysis_rules(id) on delete restrict,
    rules_text text not null,
    version_notes text,
    created_at timestamptz not null default now(),
    created_by text not null default 'researcher',
    constraint global_analysis_rules_version_positive
        check (version_number > 0),
    constraint global_analysis_rules_text_not_blank
        check (btrim(rules_text) <> '')
);

create table public.active_global_analysis_rules (
    singleton boolean primary key default true
        check (singleton),
    rule_id uuid not null unique
        references public.global_analysis_rules(id) on delete restrict,
    activated_at timestamptz not null default now(),
    activated_by text not null default 'researcher'
);

comment on table public.global_analysis_rules is
    'Immutable researcher-authored global analysis-rule versions that apply to future analysis across projects.';
comment on table public.active_global_analysis_rules is
    'The one global analysis-rule version frozen onto newly queued analyses.';

with seeded as (
    insert into public.global_analysis_rules (
        version_number, rules_text, version_notes, created_by
    ) values (
        1,
        $rules$The report for each participant is completed independently before cross-case comparison. Evidence and assignments remain tied to that single case.
A meaning unit is an exact coherent passage whose boundary follows meaning rather than punctuation. Optional anchors remain exact expressions inside that highlighted passage.
The annotated transcript highlights the complete meaning unit, places its code above it, and preserves the upward code → category → theme path.
A code must be supportable by its meaning units. Never introduce a cause, motive, diagnosis, social structure, consequence, or theoretical explanation absent from the underlying text.
Codes, categories, and themes use common corpus-wide terminology when this case's own evidence supports it. Shared vocabulary never supplies missing case evidence.
A category answers “What is being described?” and groups related codes into one firm descriptive phenomenon.
A theme answers “What patterned meaning links these observations?” and interprets several categories together. Themes are tentative interpretive analytical results, not approval requests.
Complete and publish the analytical outcome without waiting for a researcher decision. Researcher feedback starts a new completed version.
If a firm code or category lacks enough related material for a defensible higher level, retain it as unsynthesized. Never force a category or theme.
Every code, category, theme, and complete evidence chain must remain relevant under the named project's topic and scope.
Labels at the same analytical level must be conceptually distinct and useful for comparison across cases.$rules$,
        'Initial configurable version of the existing platform-wide analytical rules.',
        'system-migration'
    )
    returning id
)
insert into public.active_global_analysis_rules (
    singleton, rule_id, activated_by
)
select true, id, 'system-migration'
from seeded;

create or replace function public.save_global_analysis_rules_version(
    p_rules_text text,
    p_version_notes text default null
)
returns table (
    rule_id uuid,
    version_number integer,
    predecessor_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    prior_id uuid;
    next_version integer;
    stored_id uuid;
begin
    if nullif(btrim(p_rules_text), '') is null then
        raise exception 'Global analysis rules cannot be blank.';
    end if;

    lock table public.global_analysis_rules in share row exclusive mode;

    select active.rule_id
    into prior_id
    from public.active_global_analysis_rules as active
    where active.singleton = true;

    select coalesce(max(rules.version_number), 0) + 1
    into next_version
    from public.global_analysis_rules as rules;

    insert into public.global_analysis_rules (
        version_number, predecessor_id, rules_text, version_notes, created_by
    ) values (
        next_version,
        prior_id,
        btrim(p_rules_text),
        nullif(btrim(p_version_notes), ''),
        'researcher'
    ) returning id into stored_id;

    insert into public.active_global_analysis_rules (
        singleton, rule_id, activated_at, activated_by
    ) values (
        true, stored_id, now(), 'researcher'
    )
    on conflict (singleton) do update
    set rule_id = excluded.rule_id,
        activated_at = excluded.activated_at,
        activated_by = excluded.activated_by;

    return query select stored_id, next_version, prior_id;
end;
$function$;

revoke all on function public.save_global_analysis_rules_version(text, text)
from public, anon, authenticated;
grant execute on function public.save_global_analysis_rules_version(text, text)
to service_role;

alter table public.global_analysis_rules enable row level security;
alter table public.active_global_analysis_rules enable row level security;

revoke all on table public.global_analysis_rules from anon, authenticated;
revoke all on table public.active_global_analysis_rules from anon, authenticated;
grant select, insert on table public.global_analysis_rules to service_role;
grant select, insert, update on table public.active_global_analysis_rules
to service_role;

alter table public.automatic_case_analysis_jobs
add column global_analysis_rule_id uuid
    references public.global_analysis_rules(id) on delete restrict;

alter table public.automatic_case_reanalysis_requests
add column global_analysis_rule_id uuid
    references public.global_analysis_rules(id) on delete restrict;

alter table public.qualitative_case_reports
add column global_analysis_rule_id uuid
    references public.global_analysis_rules(id) on delete restrict;

comment on column public.qualitative_case_reports.global_analysis_rule_id is
    'Immutable global analysis-rule version used to generate this report; null identifies a legacy report.';

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

    if new.global_analysis_rule_id is null then
        select active.rule_id
        into new.global_analysis_rule_id
        from public.active_global_analysis_rules as active
        where active.singleton = true;
    end if;

    return new;
end;
$function$;

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

    if new.global_analysis_rule_id is null then
        select active.rule_id
        into new.global_analysis_rule_id
        from public.active_global_analysis_rules as active
        where active.singleton = true;
    end if;

    if new.project_id is null or new.analysis_framework_id is null
       or new.global_analysis_rule_id is null then
        raise exception 'The case is not bound to active global and project analysis rules.';
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
        select request.project_id,
               request.analysis_framework_id,
               request.global_analysis_rule_id
        into new.project_id,
             new.analysis_framework_id,
             new.global_analysis_rule_id
        from public.automatic_case_reanalysis_requests as request
        where request.id = new.reanalysis_request_id;
    else
        select job.project_id,
               job.analysis_framework_id,
               job.global_analysis_rule_id
        into new.project_id,
             new.analysis_framework_id,
             new.global_analysis_rule_id
        from public.automatic_case_analysis_jobs as job
        where job.session_id = new.session_id;
    end if;

    if new.project_id is null or new.analysis_framework_id is null
       or new.global_analysis_rule_id is null then
        raise exception 'A new case report must preserve global and project analysis-rule lineage.';
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

update public.automatic_case_analysis_jobs as job
set global_analysis_rule_id = active.rule_id,
    updated_at = now()
from public.active_global_analysis_rules as active
where active.singleton = true
  and job.archived_at is null
  and job.status <> 'completed'
  and job.global_analysis_rule_id is null;

-- The v5 rollout must not requeue an already completed test result. Restore
-- every job with a current report to the completion state recorded by that
-- report; the report itself and its analytical content remain unchanged.
with current_report as (
    select distinct on (report.session_id)
        report.session_id,
        report.analysis_version,
        coalesce(report.completed_at, report.created_at) as completed_at
    from public.qualitative_case_reports as report
    where report.superseded_at is null
    order by report.session_id,
             report.completed_at desc nulls last,
             report.created_at desc
)
update public.automatic_case_analysis_jobs as job
set status = 'completed',
    analysis_version = report.analysis_version,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = report.completed_at,
    last_error = null,
    updated_at = now()
from current_report as report
where report.session_id = job.session_id
  and job.archived_at is null
  and job.analysis_version = 'case-analysis-v5-meaning-units-categories-completed';
