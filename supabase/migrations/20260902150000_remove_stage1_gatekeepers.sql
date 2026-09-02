-- Researcher directive: the provider's exact first response is the Stage 1
-- output. The platform must not validate, score, repair, retry, parse,
-- normalize, project, reconstruct, or use that output to disqualify a case.

create or replace function public.save_advanced_preliminary_model_output(
    p_job_id uuid,
    p_raw_model_output_text text,
    p_parsed_model_output jsonb,
    p_system_processing_notes jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
    update public.advanced_preliminary_analysis_jobs
    set raw_model_output_text = coalesce(p_raw_model_output_text, ''),
        parsed_model_output = null,
        system_processing_notes = '[]'::jsonb,
        updated_at = now()
    where id = p_job_id
      and status = 'processing';

    if not found then
        raise exception 'The Stage 1 job is unavailable for exact-response preservation.';
    end if;
end;
$function$;

create or replace function public.complete_advanced_preliminary_analysis(
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
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    existing_report_id uuid;
    new_report_id uuid;
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id for update;

    if selected_job.id is null then
        raise exception 'The Stage 1 case-processing job does not exist.';
    end if;

    select report.id into existing_report_id
    from public.advanced_preliminary_case_reports as report
    where report.job_id = selected_job.id
    limit 1;

    if existing_report_id is not null then
        update public.advanced_preliminary_analysis_jobs
        set status = 'completed', completed_at = coalesce(completed_at, now()),
            lease_expires_at = null, next_retry_at = null, last_error = null,
            updated_at = now()
        where id = selected_job.id;
        perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
        return existing_report_id;
    end if;

    if selected_job.status <> 'processing' then
        raise exception 'The Stage 1 case-processing job is not processing.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = selected_job.run_id;

    insert into public.advanced_preliminary_case_reports (
        run_id, job_id, session_id, case_number, participant_id,
        participant_code, language, project_id, analysis_framework_id,
        source_report_id, provider, model, resolved_model, reasoning_effort,
        analysis_version, prompt_version, case_summary,
        unassigned_code_numbers, unassigned_category_numbers,
        analytical_audit, input_token_count, output_token_count,
        raw_model_output_text, parsed_model_output, system_processing_notes
    ) values (
        selected_job.run_id, selected_job.id, selected_job.session_id,
        selected_job.case_number, selected_job.participant_id,
        nullif(btrim(p_participant_code), ''), nullif(btrim(p_language), ''),
        selected_job.project_id, selected_job.analysis_framework_id,
        selected_job.source_report_id, selected_run.provider,
        selected_run.model, selected_run.resolved_model,
        selected_run.reasoning_effort, selected_run.analysis_version,
        selected_run.prompt_version, '', '[]'::jsonb, '[]'::jsonb,
        coalesce(p_payload->'audit', '{}'::jsonb)
            || jsonb_build_object(
                'exactFirstResponseAuthoritative', true,
                'validationType', 'none_no_analytical_validator',
                'relationalProjectionType', 'none_removed',
                'automaticRetry', false,
                'stage2Eligible', false
            ),
        p_input_token_count, p_output_token_count,
        coalesce(p_payload->>'rawModelOutputText', ''),
        null, '[]'::jsonb
    ) returning id into new_report_id;

    update public.advanced_preliminary_analysis_jobs
    set status = 'completed', completed_at = now(), lease_expires_at = null,
        next_retry_at = null, last_error = null,
        raw_model_output_text = coalesce(p_payload->>'rawModelOutputText', ''),
        parsed_model_output = null, system_processing_notes = '[]'::jsonb,
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
    return new_report_id;
end;
$function$;

create or replace function public.fail_advanced_preliminary_analysis(
    p_job_id uuid,
    p_error text,
    p_retryable boolean default true
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

    if selected_job.id is null then return; end if;

    if exists (
        select 1 from public.advanced_preliminary_case_reports as report
        where report.job_id = selected_job.id
    ) then
        update public.advanced_preliminary_analysis_jobs
        set status = 'completed', completed_at = coalesce(completed_at, now()),
            lease_expires_at = null, next_retry_at = null, last_error = null,
            updated_at = now()
        where id = selected_job.id;
    else
        update public.advanced_preliminary_analysis_jobs
        set status = 'failed', lease_expires_at = null, next_retry_at = null,
            last_error = left(coalesce(p_error,
                'The provider or system did not produce a first response.'), 5000),
            updated_at = now()
        where id = selected_job.id;
    end if;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
end;
$function$;

create or replace function public.claim_available_advanced_preliminary_analysis(
    p_maximum_parallel_cases integer
)
returns table (
    job_id uuid, run_id uuid, session_id text, participant_id text,
    case_number text, source_completed_at timestamptz, project_id uuid,
    analysis_framework_id uuid, source_report_id uuid,
    project_binding_status text, provider text, model text,
    resolved_model text, reasoning_effort text, analysis_version text,
    prompt_version text, operation_type text, authoritative_source text,
    legacy_analysis_input text, execution_contract_version text,
    rules_snapshot jsonb, provider_response_id text,
    provider_response_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_job public.advanced_preliminary_analysis_jobs%rowtype;
    active_run public.advanced_preliminary_analysis_runs%rowtype;
    current_processing integer;
    may_submit boolean;
begin
    if p_maximum_parallel_cases is null or p_maximum_parallel_cases < 1 then
        raise exception 'Worker concurrency must be a positive integer.';
    end if;

    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_worker'));

    update public.advanced_preliminary_analysis_jobs as job
    set status = 'failed', lease_expires_at = null, next_retry_at = null,
        unverified_spend_reserve_usd = greatest(
            job.unverified_spend_reserve_usd, run.next_call_reserve_usd
        ),
        last_error = coalesce(job.last_error,
            'The website runtime ended before a provider response identifier was stored. No replacement request was submitted.'),
        updated_at = now()
    from public.advanced_preliminary_analysis_runs as run
    where run.id = job.run_id
      and run.status in ('queued', 'processing')
      and job.status = 'processing'
      and job.provider_response_id is null
      and job.lease_expires_at < now();

    perform public.refresh_advanced_preliminary_analysis_run(run.id)
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing');

    select run.* into active_run
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
    order by run.requested_at
    for update
    limit 1;

    if active_run.id is null then return; end if;

    select count(*) into current_processing
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = active_run.id and job.status = 'processing';

    may_submit := current_processing < p_maximum_parallel_cases;
    if may_submit and active_run.spend_guard_status = 'active' then
        may_submit := coalesce(active_run.estimated_incremental_spend_usd, 0)
            + (current_processing + 1) * active_run.next_call_reserve_usd
            <= active_run.spending_limit_usd;
    end if;

    if may_submit then
        select candidate.* into selected_job
        from public.advanced_preliminary_analysis_jobs as candidate
        where candidate.run_id = active_run.id
          and candidate.source_report_id is null
          and candidate.status = 'pending'
        order by candidate.source_completed_at, candidate.session_id
        for update skip locked
        limit 1;

        if selected_job.id is not null then
            update public.advanced_preliminary_analysis_jobs
            set status = 'processing', attempt_count = attempt_count + 1,
                claimed_at = now(), lease_expires_at = now() + interval '12 minutes',
                next_retry_at = null, updated_at = now()
            where id = selected_job.id;

            perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);

            return query
            select selected_job.id, selected_job.run_id,
                selected_job.session_id, selected_job.participant_id,
                selected_job.case_number, selected_job.source_completed_at,
                selected_job.project_id, selected_job.analysis_framework_id,
                selected_job.source_report_id, selected_job.project_binding_status,
                active_run.provider, active_run.model, active_run.resolved_model,
                active_run.reasoning_effort, active_run.analysis_version,
                active_run.prompt_version, active_run.operation_type,
                active_run.authoritative_source, active_run.legacy_analysis_input,
                active_run.execution_contract_version, '{}'::jsonb,
                selected_job.provider_response_id,
                selected_job.provider_response_status;
            return;
        end if;
    end if;

    select job.* into selected_job
    from public.advanced_preliminary_analysis_jobs as job
    where job.run_id = active_run.id
      and job.status = 'processing'
      and job.provider_response_id is not null
      and (
          job.provider_response_checked_at is null
          or job.provider_response_checked_at <= now() - interval '20 seconds'
      )
    order by job.provider_response_checked_at nulls first,
        job.source_completed_at, job.session_id
    for update skip locked
    limit 1;

    if selected_job.id is null then return; end if;

    update public.advanced_preliminary_analysis_jobs
    set provider_response_checked_at = now(),
        lease_expires_at = now() + interval '24 hours', updated_at = now()
    where id = selected_job.id;

    return query
    select selected_job.id, selected_job.run_id, selected_job.session_id,
        selected_job.participant_id, selected_job.case_number,
        selected_job.source_completed_at, selected_job.project_id,
        selected_job.analysis_framework_id, selected_job.source_report_id,
        selected_job.project_binding_status, active_run.provider,
        active_run.model, active_run.resolved_model,
        active_run.reasoning_effort, active_run.analysis_version,
        active_run.prompt_version, active_run.operation_type,
        active_run.authoritative_source, active_run.legacy_analysis_input,
        active_run.execution_contract_version, '{}'::jsonb,
        selected_job.provider_response_id, selected_job.provider_response_status;
end;
$function$;

revoke all on function public.resolve_stalled_advanced_preliminary_response(
    uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.ensure_stage2_code_refinement_run()
from public, anon, authenticated, service_role;
revoke all on function public.claim_next_stage2_code_refinement()
from public, anon, authenticated, service_role;

revoke all on function public.save_advanced_preliminary_model_output(
    uuid, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_advanced_preliminary_analysis(
    uuid, text, boolean
) from public, anon, authenticated;
revoke all on function public.claim_available_advanced_preliminary_analysis(
    integer
) from public, anon, authenticated;

grant execute on function public.save_advanced_preliminary_model_output(
    uuid, text, jsonb, jsonb
) to service_role;
grant execute on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) to service_role;
grant execute on function public.fail_advanced_preliminary_analysis(
    uuid, text, boolean
) to service_role;
grant execute on function public.claim_available_advanced_preliminary_analysis(
    integer
) to service_role;

comment on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) is 'Stores the exact first provider response as the authoritative Stage 1 output. It performs no parsing, validation, scoring, repair, normalization, projection, or reconstruction.';
comment on function public.fail_advanced_preliminary_analysis(
    uuid, text, boolean
) is 'Records a visible provider or system failure without retrying or affecting participant inclusion.';
comment on function public.claim_available_advanced_preliminary_analysis(
    integer
) is 'Submits each pending Stage 1 case once and polls its durable provider response ID until terminal. Failed cases are never resubmitted automatically.';

create table if not exists public.advanced_preliminary_projection_archive (
    report_id uuid primary key
        references public.advanced_preliminary_case_reports(id) on delete restrict,
    run_id uuid not null
        references public.advanced_preliminary_analysis_runs(id) on delete restrict,
    projection jsonb not null,
    archived_at timestamptz not null default now(),
    archive_reason text not null
);

alter table public.advanced_preliminary_projection_archive
    enable row level security;
revoke all on table public.advanced_preliminary_projection_archive
    from public, anon, authenticated;
grant select on table public.advanced_preliminary_projection_archive
    to service_role;

comment on table public.advanced_preliminary_projection_archive is
    'Read-only recovery archive of withdrawn normalized Stage 1 projections. These records are not active analysis and have no authority over participant inclusion or Stage 2.';

do $function$
declare
    target_report_ids uuid[];
    target_run_id uuid;
begin
    select run.id into target_run_id
    from public.advanced_preliminary_analysis_runs as run
    where run.model = 'gpt-5.6-sol'
    order by run.requested_at desc, run.id desc
    limit 1;

    insert into public.advanced_preliminary_projection_archive (
        report_id, run_id, projection, archive_reason
    )
    select report.id, report.run_id,
        jsonb_build_object(
            'meaningUnits', coalesce((
                select jsonb_agg(to_jsonb(mu) order by mu.unit_number)
                from public.advanced_preliminary_meaning_units as mu
                where mu.report_id = report.id
            ), '[]'::jsonb),
            'codes', coalesce((
                select jsonb_agg(to_jsonb(code) order by code.code_number)
                from public.advanced_preliminary_codes as code
                where code.report_id = report.id
            ), '[]'::jsonb),
            'codeMeaningUnits', coalesce((
                select jsonb_agg(to_jsonb(link) order by link.code_id, link.meaning_unit_id)
                from public.advanced_preliminary_code_meaning_units as link
                where link.report_id = report.id
            ), '[]'::jsonb),
            'categories', coalesce((
                select jsonb_agg(to_jsonb(category) order by category.category_number)
                from public.advanced_preliminary_categories as category
                where category.report_id = report.id
            ), '[]'::jsonb),
            'categoryCodes', coalesce((
                select jsonb_agg(to_jsonb(link) order by link.category_id, link.code_id)
                from public.advanced_preliminary_category_codes as link
                where link.report_id = report.id
            ), '[]'::jsonb),
            'tentativeThemes', coalesce((
                select jsonb_agg(to_jsonb(theme) order by theme.theme_number)
                from public.advanced_preliminary_themes as theme
                where theme.report_id = report.id
            ), '[]'::jsonb),
            'themeCategories', coalesce((
                select jsonb_agg(to_jsonb(link) order by link.theme_id, link.category_id)
                from public.advanced_preliminary_theme_categories as link
                where link.report_id = report.id
            ), '[]'::jsonb)
        ),
        'Withdrawn from the active current-run path by researcher directive GOV-STAGE1-EXACT-001.'
    from public.advanced_preliminary_case_reports as report
    where report.run_id = target_run_id
      and nullif(report.raw_model_output_text, '') is not null
    on conflict (report_id) do nothing;

    select array_agg(report.id) into target_report_ids
    from public.advanced_preliminary_case_reports as report
    join public.advanced_preliminary_projection_archive as archive
      on archive.report_id = report.id
    where report.run_id = target_run_id
      and nullif(report.raw_model_output_text, '') is not null;

    if target_report_ids is not null then
        delete from public.advanced_preliminary_theme_categories
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_category_codes
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_code_meaning_units
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_themes
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_categories
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_codes
        where report_id = any(target_report_ids);
        delete from public.advanced_preliminary_meaning_units
        where report_id = any(target_report_ids);

        update public.advanced_preliminary_case_reports
        set parsed_model_output = null,
            system_processing_notes = '[]'::jsonb,
            analytical_audit = coalesce(analytical_audit, '{}'::jsonb)
                || jsonb_build_object(
                    'exactFirstResponseAuthoritative', true,
                    'validationType', 'none_no_analytical_validator',
                    'relationalProjectionType', 'none_removed',
                    'automaticRetry', false,
                    'stage2Eligible', false,
                    'projectionRemovedAt', now()
                )
        where id = any(target_report_ids);

        update public.advanced_preliminary_analysis_jobs as job
        set parsed_model_output = null,
            system_processing_notes = '[]'::jsonb,
            next_retry_at = null,
            updated_at = now()
        where exists (
            select 1 from public.advanced_preliminary_case_reports as report
            where report.job_id = job.id and report.id = any(target_report_ids)
        );
    end if;

    update public.advanced_preliminary_case_reports
    set analytical_audit = coalesce(analytical_audit, '{}'::jsonb)
        || jsonb_build_object(
            'exactFirstResponseAuthoritative', false,
            'exactFirstResponseAvailable', false,
            'historicalProjectionOnly', true,
            'stage2Eligible', false
        )
    where run_id = target_run_id
      and nullif(raw_model_output_text, '') is null;
end;
$function$;

do $function$
declare
    selected_rules public.global_analysis_rules%rowtype;
    next_version integer;
    inserted_rule_id uuid;
begin
    lock table public.global_analysis_rules in share row exclusive mode;

    select rules.* into selected_rules
    from public.active_global_analysis_rules as active
    join public.global_analysis_rules as rules on rules.id = active.rule_id
    where active.singleton = true;

    if selected_rules.id is not null
       and position('GOV-STAGE1-EXACT-001' in selected_rules.rules_text) = 0 then
        select coalesce(max(rules.version_number), 0) + 1 into next_version
        from public.global_analysis_rules as rules;

        insert into public.global_analysis_rules (
            version_number, predecessor_id, rules_text, version_notes, created_by
        ) values (
            next_version,
            selected_rules.id,
            'GOV-STAGE1-EXACT-001 — Stage 1 consists of one independent provider request per completed transcript and preservation of the exact first response. The platform must not validate, score, repair, retry, parse, normalize, project, reconstruct, or use model-output structure to reject a report or disqualify a participant. Provider and system failures remain visible and system-owned. Stage 2 is unavailable until separately authorized by the researcher.'
                || E'\n\n' || selected_rules.rules_text,
            'Researcher-directed removal of all Stage 1 gatekeepers and automatic Stage 2 preparation.',
            'researcher-governance-GOV-STAGE1-EXACT-001'
        ) returning id into inserted_rule_id;

        update public.active_global_analysis_rules
        set rule_id = inserted_rule_id, activated_at = now(),
            activated_by = 'researcher-governance-GOV-STAGE1-EXACT-001'
        where singleton = true;
    end if;
end;
$function$;
