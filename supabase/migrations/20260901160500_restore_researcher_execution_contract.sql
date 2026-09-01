alter table public.advanced_preliminary_analysis_runs
    add column if not exists operation_type text
        not null default 'fresh_independent_analysis',
    add column if not exists authoritative_source text
        not null default 'original_completed_transcripts',
    add column if not exists legacy_analysis_input text
        not null default 'excluded',
    add column if not exists execution_contract_version text
        not null default 'researcher-operation-contract-v1',
    add column if not exists execution_plan_hash text,
    add column if not exists rules_snapshot jsonb
        not null default '{}'::jsonb,
    add column if not exists automatic_continuation boolean
        not null default true,
    add column if not exists maximum_analysis_calls integer;

update public.advanced_preliminary_analysis_runs
set operation_type = 'historical_unverified_execution',
    execution_contract_version = 'historical-unverified-contract'
where execution_plan_hash is null;

alter table public.advanced_preliminary_analysis_runs
    drop constraint if exists advanced_preliminary_operation_type_check,
    drop constraint if exists advanced_preliminary_authoritative_source_check,
    drop constraint if exists advanced_preliminary_legacy_analysis_input_check,
    drop constraint if exists advanced_preliminary_execution_plan_hash_check,
    drop constraint if exists advanced_preliminary_maximum_calls_check;

alter table public.advanced_preliminary_analysis_runs
    add constraint advanced_preliminary_operation_type_check
        check (operation_type in (
            'fresh_independent_analysis',
            'historical_unverified_execution'
        )),
    add constraint advanced_preliminary_authoritative_source_check
        check (authoritative_source = 'original_completed_transcripts'),
    add constraint advanced_preliminary_legacy_analysis_input_check
        check (legacy_analysis_input = 'excluded'),
    add constraint advanced_preliminary_execution_plan_hash_check
        check (execution_plan_hash is null or execution_plan_hash ~ '^[0-9a-f]{64}$'),
    add constraint advanced_preliminary_maximum_calls_check
        check (maximum_analysis_calls is null or maximum_analysis_calls >= 0);

update public.advanced_preliminary_analysis_runs
set maximum_analysis_calls = source_case_count
where maximum_analysis_calls is null;

comment on column public.advanced_preliminary_analysis_runs.operation_type is
    'Researcher-selected operation. This execution path only permits a fresh independent analysis.';
comment on column public.advanced_preliminary_analysis_runs.execution_plan_hash is
    'SHA-256 of the exact preflight plan explicitly confirmed by the researcher.';
comment on column public.advanced_preliminary_analysis_runs.rules_snapshot is
    'Immutable global and project analysis rules shown at preflight and frozen onto the run.';

create or replace function public.preview_fresh_independent_analysis_run(
    p_project_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_project public.research_projects%rowtype;
    selected_framework public.analysis_frameworks%rowtype;
    selected_global_rules public.global_analysis_rules%rowtype;
    eligible_count integer;
    participant_message_count integer;
    stored_translation_count integer;
    missing_stored_translation_count integer;
begin
    select * into selected_project
    from public.research_projects
    where id = p_project_id;

    if selected_project.id is null then
        raise exception 'The selected research project does not exist.';
    end if;

    select framework.* into selected_framework
    from public.active_analysis_frameworks as active
    join public.analysis_frameworks as framework
      on framework.id = active.framework_id
    where active.project_id = selected_project.id;

    select rules.* into selected_global_rules
    from public.active_global_analysis_rules as active
    join public.global_analysis_rules as rules
      on rules.id = active.rule_id
    where active.singleton = true;

    if selected_framework.id is null or selected_global_rules.id is null then
        raise exception 'Active global and project analysis rules are required.';
    end if;

    select count(*)::integer
    into eligible_count
    from public.interview_sessions as session
    join public.research_designs as design
      on design.id = session.research_design_id
     and design.project_id = selected_project.id
    join public.case_code_map as code_map
      on code_map.session_id = session.session_id
    where session.completed = true
      and session.completed_at is not null;

    select
        count(*)::integer,
        count(*) filter (
            where lower(coalesce(message."Language", '')) <> 'en'
              and nullif(btrim(message."EnglishTranslation"), '') is not null
        )::integer,
        count(*) filter (
            where lower(coalesce(message."Language", '')) <> 'en'
              and nullif(btrim(message."EnglishTranslation"), '') is null
        )::integer
    into participant_message_count,
         stored_translation_count,
         missing_stored_translation_count
    from public.interview_sessions as session
    join public.research_designs as design
      on design.id = session.research_design_id
     and design.project_id = selected_project.id
    join public.case_code_map as code_map
      on code_map.session_id = session.session_id
    join public.interview_messages as message
      on message."Session" = session.session_id
    where session.completed = true
      and session.completed_at is not null
      and lower(coalesce(message."Speaker", '')) in ('participant', 'user');

    return jsonb_build_object(
        'source_case_count', eligible_count,
        'participant_message_count', participant_message_count,
        'stored_translation_count', stored_translation_count,
        'missing_stored_translation_count', missing_stored_translation_count,
        'rules_snapshot', jsonb_build_object(
            'global', jsonb_build_object(
                'id', selected_global_rules.id,
                'versionNumber', selected_global_rules.version_number,
                'rulesText', selected_global_rules.rules_text
            ),
            'project', jsonb_build_object(
                'id', selected_framework.id,
                'projectId', selected_framework.project_id,
                'versionNumber', selected_framework.version_number,
                'studyScope', selected_framework.study_scope,
                'themeRequirements', selected_framework.theme_requirements,
                'codeDerivationRules', selected_framework.code_derivation_rules,
                'themeCodeFitRules', selected_framework.theme_code_fit_rules,
                'inclusionRules', selected_framework.inclusion_rules,
                'exclusionRules', selected_framework.exclusion_rules,
                'provenanceExpectations', selected_framework.provenance_expectations
            )
        )
    );
end;
$function$;

drop function if exists public.create_stage1_meaning_unit_run(
    uuid, text, text, text, text, text, text, text
);
drop function if exists public.create_advanced_preliminary_analysis_run(
    text, text, text, text, text, text, text
);

create or replace function public.create_fresh_independent_analysis_run(
    p_project_id uuid,
    p_provider text,
    p_model text,
    p_resolved_model text,
    p_reasoning_effort text,
    p_analysis_version text,
    p_prompt_version text,
    p_execution_contract_version text,
    p_execution_plan_hash text,
    p_rules_snapshot jsonb,
    p_requested_by text default 'researcher'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    new_run_id uuid;
    selected_project public.research_projects%rowtype;
    selected_framework_id uuid;
    eligible_count integer;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_run'));

    if exists (
        select 1
        from public.advanced_preliminary_analysis_runs
        where status in ('queued', 'processing')
    ) then
        raise exception 'A preliminary case-analysis run is already active.';
    end if;

    select * into selected_project
    from public.research_projects
    where id = p_project_id;

    if selected_project.id is null then
        raise exception 'The selected research project does not exist.';
    end if;

    select active.framework_id into selected_framework_id
    from public.active_analysis_frameworks as active
    where active.project_id = selected_project.id;

    if selected_framework_id is null then
        raise exception 'An active project analysis framework is required.';
    end if;

    if btrim(coalesce(p_provider, '')) = ''
       or btrim(coalesce(p_model, '')) = ''
       or btrim(coalesce(p_resolved_model, '')) = ''
       or btrim(coalesce(p_analysis_version, '')) = ''
       or btrim(coalesce(p_prompt_version, '')) = ''
       or btrim(coalesce(p_execution_contract_version, '')) = ''
       or coalesce(p_execution_plan_hash, '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p_rules_snapshot) <> 'object' then
        raise exception 'The confirmed operation, model, versions, rules, and execution-plan hash are required.';
    end if;

    insert into public.advanced_preliminary_analysis_runs (
        source_scope, provider, model, resolved_model, reasoning_effort,
        analysis_version, prompt_version, prior_analysis_role, stop_layer,
        requested_by, model_verified_at, project_snapshot,
        operation_type, authoritative_source, legacy_analysis_input,
        execution_contract_version, execution_plan_hash, rules_snapshot,
        automatic_continuation
    ) values (
        'single_project_formally_completed_transcripts',
        btrim(p_provider), btrim(p_model), btrim(p_resolved_model),
        p_reasoning_effort, btrim(p_analysis_version), btrim(p_prompt_version),
        'transcript_only_no_prior_analysis', 'preliminary_tentative_themes',
        coalesce(nullif(btrim(p_requested_by), ''), 'researcher'), now(),
        jsonb_build_array(jsonb_build_object(
            'project_id', selected_project.id,
            'project_code', selected_project.project_code,
            'project_name', selected_project.project_name,
            'research_topic', selected_project.research_topic
        )),
        'fresh_independent_analysis', 'original_completed_transcripts',
        'excluded', btrim(p_execution_contract_version),
        p_execution_plan_hash, p_rules_snapshot, true
    ) returning id into new_run_id;

    insert into public.advanced_preliminary_analysis_jobs (
        run_id, session_id, participant_id, case_number,
        source_completed_at, project_id, analysis_framework_id,
        source_report_id, project_binding_status
    )
    select
        new_run_id, session.session_id, session.participant_id,
        code_map.case_number, session.completed_at, selected_project.id,
        selected_framework_id, null, 'project_bound'
    from public.interview_sessions as session
    join public.research_designs as design
      on design.id = session.research_design_id
     and design.project_id = selected_project.id
    join public.case_code_map as code_map
      on code_map.session_id = session.session_id
    where session.completed = true
      and session.completed_at is not null
    order by session.completed_at, session.session_id;

    select count(*)::integer into eligible_count
    from public.advanced_preliminary_analysis_jobs
    where run_id = new_run_id;

    if eligible_count = 0 then
        raise exception 'The selected project has no formally completed transcripts with stable case IDs.';
    end if;

    update public.advanced_preliminary_analysis_runs
    set source_case_count = eligible_count,
        pending_count = eligible_count,
        maximum_analysis_calls = eligible_count,
        updated_at = now()
    where id = new_run_id;

    return new_run_id;
end;
$function$;

drop function if exists public.claim_next_advanced_preliminary_analysis();

create function public.claim_next_advanced_preliminary_analysis()
returns table (
    job_id uuid,
    run_id uuid,
    session_id text,
    participant_id text,
    case_number text,
    source_completed_at timestamptz,
    project_id uuid,
    analysis_framework_id uuid,
    source_report_id uuid,
    project_binding_status text,
    provider text,
    model text,
    resolved_model text,
    reasoning_effort text,
    analysis_version text,
    prompt_version text,
    operation_type text,
    authoritative_source text,
    legacy_analysis_input text,
    execution_contract_version text,
    rules_snapshot jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_worker'));

    update public.advanced_preliminary_analysis_jobs as job
    set status = 'failed',
        lease_expires_at = null,
        next_retry_at = now(),
        last_error = coalesce(job.last_error, 'Worker lease expired; retry scheduled.'),
        updated_at = now()
    from public.advanced_preliminary_analysis_runs as run
    where run.id = job.run_id
      and run.status in ('queued', 'processing')
      and job.status = 'processing'
      and job.lease_expires_at < now();

    perform public.refresh_advanced_preliminary_analysis_run(run.id)
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing');

    if exists (
        select 1
        from public.advanced_preliminary_analysis_jobs as job
        join public.advanced_preliminary_analysis_runs as run on run.id = job.run_id
        where run.status in ('queued', 'processing')
          and job.status = 'processing'
          and job.lease_expires_at >= now()
    ) then
        return;
    end if;

    select candidate.* into selected_job
    from public.advanced_preliminary_analysis_jobs as candidate
    join public.advanced_preliminary_analysis_runs as run on run.id = candidate.run_id
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
      and candidate.source_report_id is null
      and (
          candidate.status = 'pending'
          or (
              candidate.status = 'failed'
              and candidate.attempt_count < 3
              and coalesce(candidate.next_retry_at, '-infinity'::timestamptz) <= now()
          )
      )
    order by run.requested_at, candidate.source_completed_at, candidate.session_id
    for update of candidate skip locked
    limit 1;

    if selected_job.id is null then
        return;
    end if;

    update public.advanced_preliminary_analysis_jobs
    set status = 'processing',
        attempt_count = attempt_count + 1,
        claimed_at = now(),
        lease_expires_at = now() + interval '12 minutes',
        next_retry_at = null,
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);

    return query
    select
        selected_job.id, selected_job.run_id, selected_job.session_id,
        selected_job.participant_id, selected_job.case_number,
        selected_job.source_completed_at, selected_job.project_id,
        selected_job.analysis_framework_id, selected_job.source_report_id,
        selected_job.project_binding_status, run.provider, run.model,
        run.resolved_model, run.reasoning_effort, run.analysis_version,
        run.prompt_version, run.operation_type, run.authoritative_source,
        run.legacy_analysis_input, run.execution_contract_version,
        run.rules_snapshot
    from public.advanced_preliminary_analysis_runs as run
    where run.id = selected_job.run_id;
end;
$function$;

create or replace function public.cancel_advanced_preliminary_analysis_run(
    p_run_id uuid,
    p_cancellation_reason text,
    p_cancelled_by text default 'researcher'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    cancelled_jobs integer;
begin
    if nullif(btrim(p_cancellation_reason), '') is null then
        raise exception 'A researcher-visible cancellation reason is required.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = p_run_id
    for update;

    if selected_run.id is null then
        raise exception 'The selected analysis run does not exist.';
    end if;

    update public.advanced_preliminary_analysis_jobs
    set status = 'cancelled',
        lease_expires_at = null,
        next_retry_at = null,
        last_error = case
            when status = 'processing' then 'Cancelled while a model call may have been in flight; its output was not accepted.'
            else last_error
        end,
        updated_at = now()
    where run_id = p_run_id
      and status in ('pending', 'processing', 'failed');

    get diagnostics cancelled_jobs = row_count;

    update public.advanced_preliminary_analysis_runs
    set status = 'cancelled',
        cancelled_at = coalesce(cancelled_at, now()),
        cancellation_reason = btrim(p_cancellation_reason),
        last_error = format('Stopped by %s.', coalesce(nullif(btrim(p_cancelled_by), ''), 'researcher')),
        updated_at = now()
    where id = p_run_id;

    perform public.refresh_advanced_preliminary_analysis_run(p_run_id);

    return jsonb_build_object(
        'runId', p_run_id,
        'status', 'cancelled',
        'cancelledJobs', cancelled_jobs,
        'reason', btrim(p_cancellation_reason)
    );
end;
$function$;

revoke all on function public.preview_fresh_independent_analysis_run(uuid)
from public, anon, authenticated;
revoke all on function public.create_fresh_independent_analysis_run(
    uuid, text, text, text, text, text, text, text, text, jsonb, text
)
from public, anon, authenticated;
revoke all on function public.claim_next_advanced_preliminary_analysis()
from public, anon, authenticated;
revoke all on function public.cancel_advanced_preliminary_analysis_run(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.preview_fresh_independent_analysis_run(uuid)
to service_role;
grant execute on function public.create_fresh_independent_analysis_run(
    uuid, text, text, text, text, text, text, text, text, jsonb, text
)
to service_role;
grant execute on function public.claim_next_advanced_preliminary_analysis()
to service_role;
grant execute on function public.cancel_advanced_preliminary_analysis_run(uuid, text, text)
to service_role;
