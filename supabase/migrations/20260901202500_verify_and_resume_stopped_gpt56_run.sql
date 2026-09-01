alter table public.advanced_preliminary_analysis_runs
    add column if not exists contract_transitions jsonb
        not null default '[]'::jsonb;

comment on column public.advanced_preliminary_analysis_runs.contract_transitions is
    'Append-only run-contract lineage. Existing case reports keep their own immutable analysis and prompt versions.';

drop function if exists public.resume_advanced_preliminary_analysis_run(
    uuid, numeric, numeric, numeric, numeric, text
);

create function public.resume_advanced_preliminary_analysis_run(
    p_run_id uuid,
    p_spending_limit_usd numeric,
    p_input_price_usd_per_million numeric,
    p_output_price_usd_per_million numeric,
    p_next_call_reserve_usd numeric,
    p_execution_plan_hash text,
    p_resumed_by text default 'researcher'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.advanced_preliminary_analysis_runs%rowtype;
    selected_project_id uuid;
    selected_framework public.analysis_frameworks%rowtype;
    selected_global_rules public.global_analysis_rules%rowtype;
    frozen_rules jsonb;
    baseline_cost numeric(12,6);
    resumed_jobs integer;
    report_evidence record;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_run'));

    if exists (
        select 1
        from public.advanced_preliminary_analysis_runs
        where id <> p_run_id and status in ('queued', 'processing')
    ) then
        raise exception 'Another preliminary case-analysis run is already active.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = p_run_id
    for update;

    if selected_run.id is null then
        raise exception 'The selected analysis run does not exist.';
    end if;
    if selected_run.status <> 'cancelled' then
        raise exception 'Only a stopped analysis run can be explicitly resumed.';
    end if;
    if selected_run.authoritative_source <> 'original_completed_transcripts'
       or selected_run.legacy_analysis_input <> 'excluded'
       or selected_run.prior_analysis_role <> 'transcript_only_no_prior_analysis'
       or selected_run.stop_layer <> 'preliminary_tentative_themes' then
        raise exception 'The stopped run does not satisfy the transcript-only independent-analysis contract.';
    end if;
    if selected_run.model <> 'gpt-5.6-sol'
       or selected_run.resolved_model <> 'gpt-5.6-sol'
       or selected_run.reasoning_effort <> 'high' then
        raise exception 'This authorization is only for GPT-5.6 Sol with high reasoning.';
    end if;
    if p_spending_limit_usd <= 0
       or p_input_price_usd_per_million <= 0
       or p_output_price_usd_per_million <= 0
       or p_next_call_reserve_usd <= 0
       or p_next_call_reserve_usd > p_spending_limit_usd
       or coalesce(p_execution_plan_hash, '') !~ '^[0-9a-f]{64}$' then
        raise exception 'A positive spending limit, price snapshot, reserve, and confirmed plan hash are required.';
    end if;

    select
        count(*)::integer as report_count,
        count(*) filter (
            where report.provider = 'openai'
              and report.model = 'gpt-5.6-sol'
              and report.resolved_model = 'gpt-5.6-sol'
              and report.reasoning_effort = 'high'
              and report.analytical_audit->>'priorAnalysisUsed' = 'false'
              and report.analytical_audit->>'aiAnalysisPassCount' = '1'
              and report.analytical_audit->>'validationType'
                = 'local_deterministic_source_and_relationship_integrity'
        )::integer as independently_verified_count
    into report_evidence
    from public.advanced_preliminary_case_reports as report
    where report.run_id = p_run_id;

    if report_evidence.report_count <> selected_run.completed_count
       or report_evidence.independently_verified_count
            <> report_evidence.report_count then
        raise exception 'The preserved completed reports do not all prove one-pass GPT-5.6 transcript-only analysis.';
    end if;

    selected_project_id := nullif(
        selected_run.project_snapshot->0->>'project_id', ''
    )::uuid;

    select framework.* into selected_framework
    from public.active_analysis_frameworks as active
    join public.analysis_frameworks as framework
      on framework.id = active.framework_id
    where active.project_id = selected_project_id;

    select rules.* into selected_global_rules
    from public.active_global_analysis_rules as active
    join public.global_analysis_rules as rules
      on rules.id = active.rule_id
    where active.singleton = true;

    if selected_framework.id is null or selected_global_rules.id is null then
        raise exception 'Active project and global analysis rules are required.';
    end if;

    frozen_rules := jsonb_build_object(
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
    );

    select coalesce(sum(
        (coalesce(report.input_token_count, 0)::numeric
            * p_input_price_usd_per_million
         + coalesce(report.output_token_count, 0)::numeric
            * p_output_price_usd_per_million) / 1000000
    ), 0)::numeric(12,6)
    into baseline_cost
    from public.advanced_preliminary_case_reports as report
    where report.run_id = p_run_id;

    update public.advanced_preliminary_analysis_jobs
    set status = 'pending', attempt_count = 0, claimed_at = null,
        lease_expires_at = null, next_retry_at = null, completed_at = null,
        last_error = null, updated_at = now()
    where run_id = p_run_id
      and status in ('cancelled', 'failed')
      and not exists (
          select 1
          from public.advanced_preliminary_case_reports as report
          where report.job_id = advanced_preliminary_analysis_jobs.id
      );

    get diagnostics resumed_jobs = row_count;

    update public.advanced_preliminary_analysis_runs
    set contract_transitions = contract_transitions
            || jsonb_build_array(jsonb_build_object(
                'transitionedAt', now(),
                'transitionedBy', coalesce(nullif(btrim(p_resumed_by), ''), 'researcher'),
                'reason', 'Researcher explicitly authorized continuation of the remaining GPT-5.6 Sol cases after all preserved reports proved transcript-only independent generation.',
                'previousOperationType', operation_type,
                'previousContractVersion', execution_contract_version,
                'previousExecutionPlanHash', execution_plan_hash,
                'previousAnalysisVersion', analysis_version,
                'previousPromptVersion', prompt_version,
                'preservedReportCount', report_evidence.report_count,
                'newExecutionPlanHash', p_execution_plan_hash
            )),
        previous_cancellations = previous_cancellations
            || jsonb_build_array(jsonb_build_object(
                'cancelledAt', cancelled_at,
                'reason', cancellation_reason,
                'resumedAt', now(),
                'resumedBy', coalesce(nullif(btrim(p_resumed_by), ''), 'researcher')
            )),
        cancelled_at = null,
        cancellation_reason = null,
        completed_at = null,
        last_error = null,
        operation_type = 'fresh_independent_analysis',
        execution_contract_version = 'researcher-operation-contract-v1',
        execution_plan_hash = p_execution_plan_hash,
        rules_snapshot = frozen_rules,
        analysis_version = 'preliminary-case-analysis-v4-researcher-controlled-independent',
        prompt_version = 'preliminary-case-analysis-prompt-v4-explicit-run-contract',
        spending_limit_usd = p_spending_limit_usd,
        spending_baseline_usd = baseline_cost,
        estimated_incremental_spend_usd = 0,
        input_price_usd_per_million = p_input_price_usd_per_million,
        output_price_usd_per_million = p_output_price_usd_per_million,
        next_call_reserve_usd = p_next_call_reserve_usd,
        spend_guard_status = 'active',
        spend_guard_checked_at = now(),
        resumed_at = now(),
        resumed_by = coalesce(nullif(btrim(p_resumed_by), ''), 'researcher'),
        resume_count = resume_count + 1,
        status = 'queued',
        updated_at = now()
    where id = p_run_id;

    perform public.refresh_advanced_preliminary_analysis_run(p_run_id);

    return jsonb_build_object(
        'runId', p_run_id,
        'status', 'resumed',
        'resumedJobs', resumed_jobs,
        'preservedCompletedCases', selected_run.completed_count,
        'verifiedPreservedReports', report_evidence.independently_verified_count,
        'spendingLimitUsd', p_spending_limit_usd,
        'spendingBaselineUsd', baseline_cost,
        'nextCallReserveUsd', p_next_call_reserve_usd,
        'executionPlanHash', p_execution_plan_hash
    );
end;
$function$;

revoke all on function public.resume_advanced_preliminary_analysis_run(
    uuid, numeric, numeric, numeric, numeric, text, text
) from public, anon, authenticated;

grant execute on function public.resume_advanced_preliminary_analysis_run(
    uuid, numeric, numeric, numeric, numeric, text, text
) to service_role;
