-- Researcher authorization on 2026-09-02: finish the complete GPT-5.6 Stage 1
-- run under a USD 150 technical spending ceiling.
with selected_run as (
    select id, spending_limit_usd
    from public.advanced_preliminary_analysis_runs
    where status in (
        'queued', 'processing', 'spending_limit_reached',
        'completed_with_failures'
    )
      and operation_type = 'fresh_independent_analysis'
      and authoritative_source = 'original_completed_transcripts'
      and legacy_analysis_input = 'excluded'
      and model = 'gpt-5.6-sol'
      and spending_limit_usd < 150
    order by requested_at desc
    limit 1
    for update
), updated as (
    update public.advanced_preliminary_analysis_runs as run
    set spending_limit_usd = 150,
        spend_guard_status = 'active',
        completed_at = null,
        last_error = null,
        status = 'processing',
        contract_transitions = coalesce(
            run.contract_transitions, '[]'::jsonb
        ) || jsonb_build_array(jsonb_build_object(
            'transitionedAt', now(),
            'transitionedBy', 'researcher',
            'reason', 'Researcher explicitly authorized continuing the complete GPT-5.6 Stage 1 run after the prior technical spending ceiling stopped submissions.',
            'changeType', 'technical_spending_ceiling',
            'previousSpendingLimitUsd', selected_run.spending_limit_usd,
            'newSpendingLimitUsd', 150,
            'participantInclusionEffect',
                'none_all_transcripts_remain_processible'
        )),
        updated_at = now()
    from selected_run
    where run.id = selected_run.id
    returning run.id
)
select public.refresh_advanced_preliminary_analysis_run(id)
from updated;
