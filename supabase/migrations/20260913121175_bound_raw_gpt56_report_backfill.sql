create or replace function private.backfill_stage1_readable_reports_v2(
    p_from integer,
    p_to integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
    before_count integer;
    after_count integer;
begin
    select count(*) into before_count
    from public.stage1_readable_reports_v2;
-- Use the earlier deterministic report projection only when it was produced
-- from the same byte-for-byte GPT-5.6 Sol High response now frozen on the
-- case-bound attempt. The projection supplies presentation rows, not analysis.
-- GPT-5.1 production output is not a source.
insert into public.stage1_readable_reports_v2 (
    attempt_id, report_json, report_sha256, source_response_sha256,
    source_kind, provider, model, reasoning_effort, provider_status
)
select attempt.id, built.report_json,
    encode(extensions.digest(
        convert_to(built.report_json::text, 'UTF8'), 'sha256'
    ), 'hex'),
    encode(extensions.digest(
        convert_to(attempt.raw_model_output_text, 'UTF8'), 'sha256'
    ), 'hex'),
    'frozen_gpt56_response_projection', source_report.provider,
    coalesce(source_report.resolved_model, source_report.model),
    source_report.reasoning_effort, attempt.provider_status
from public.stage1_attempts_v2 as attempt
join public.pilot_stage1_assumptions_v2 as pilot
  on pilot.case_id = attempt.case_id
join public.analysis_cases_v2 as analysis_case
  on analysis_case.id = attempt.case_id
join public.advanced_preliminary_case_reports as source_report
  on source_report.id = pilot.source_report_id
cross join lateral (
    select jsonb_build_object(
        'meaning_units', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(
                    unit.source_identifier, 'MU', unit.position
                ),
                'sources', jsonb_build_array(jsonb_strip_nulls(
                    jsonb_build_object(
                        'message_id', unit.source_message_id,
                        'english_text', unit.exact_text,
                        'text_field', 'english'
                    )
                ))
            ) order by unit.position)
            from public.stage1_preliminary_meaning_units as unit
            where unit.materialization_run_id = pilot.source_materialization_run_id
              and unit.source_job_id = pilot.source_job_id
        ), '[]'::jsonb),
        'preliminary_codes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(
                    code.source_identifier, 'CO', code.position
                ),
                'label', code.code_label,
                'meaning_unit_ids', private.stage1_report_reference_ids_v2(
                    to_jsonb(code.meaning_unit_references), 'MU'
                ),
                'mention_count', cardinality(code.meaning_unit_references)
            ) order by code.position)
            from public.stage1_preliminary_codes as code
            where code.materialization_run_id = pilot.source_materialization_run_id
              and code.source_job_id = pilot.source_job_id
        ), '[]'::jsonb),
        'preliminary_categories', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(
                    category.source_identifier, 'CA', category.position
                ),
                'label', category.category_label,
                'code_ids', private.stage1_report_reference_ids_v2(
                    to_jsonb(category.code_references), 'CO'
                )
            ) order by category.position)
            from public.stage1_preliminary_categories as category
            where category.materialization_run_id = pilot.source_materialization_run_id
              and category.source_job_id = pilot.source_job_id
        ), '[]'::jsonb),
        'preliminary_tentative_themes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(
                    theme.source_identifier, 'TH', theme.position
                ),
                'statement', theme.theme_label,
                'category_ids', private.stage1_report_reference_ids_v2(
                    to_jsonb(theme.category_references), 'CA'
                )
            ) order by theme.position)
            from public.stage1_preliminary_implied_themes as theme
            where theme.materialization_run_id = pilot.source_materialization_run_id
              and theme.source_job_id = pilot.source_job_id
        ), '[]'::jsonb),
        'presentation_provenance', jsonb_build_object(
            'kind', 'frozen_gpt56_response_projection',
            'provider', source_report.provider,
            'model', coalesce(source_report.resolved_model, source_report.model),
            'reasoning_effort', source_report.reasoning_effort,
            'source_attempt_id', attempt.id,
            'source_response_sha256', encode(extensions.digest(
                convert_to(attempt.raw_model_output_text, 'UTF8'), 'sha256'
            ), 'hex'),
            'provider_response_changed', false,
            'new_ai_call', false,
            'researcher_inspection_required', false
        )
    ) as report_json
) as built
where attempt.status = 'completed'
  and regexp_replace(
      analysis_case.case_number, '[^0-9]', '', 'g'
  )::integer between p_from and p_to
  and source_report.provider = 'openai'
  and coalesce(source_report.resolved_model, source_report.model) = 'gpt-5.6-sol'
  and source_report.reasoning_effort = 'high'
  and source_report.raw_model_output_text = attempt.raw_model_output_text
  and public.stage1_readable_report_complete_v2(built.report_json);


-- Cases without an eligible normalized projection include the researcher-
-- identified P00171 and P00175. Their immutable GPT-5.6 Sol High responses
-- contain complete MU, CO, CA, and TH arrays, so derive the readable report
-- directly from those exact arrays without a provider call.
with target_attempts as materialized (
    select attempt.*
    from public.stage1_attempts_v2 as attempt
    join public.analysis_cases_v2 as analysis_case
      on analysis_case.id = attempt.case_id
    where attempt.status = 'completed'
      and regexp_replace(
          analysis_case.case_number, '[^0-9]', '', 'g'
      )::integer between p_from and p_to
      and not exists (
          select 1 from public.stage1_readable_reports_v2 as existing
          where existing.attempt_id = attempt.id
      )
)
insert into public.stage1_readable_reports_v2 (
    attempt_id, report_json, report_sha256, source_response_sha256,
    source_kind, provider, model, reasoning_effort, provider_status
)
select attempt.id, built.report_json,
    encode(extensions.digest(
        convert_to(built.report_json::text, 'UTF8'), 'sha256'
    ), 'hex'),
    encode(extensions.digest(
        convert_to(attempt.raw_model_output_text, 'UTF8'), 'sha256'
    ), 'hex'),
    'frozen_gpt56_response_projection', configuration.provider,
    configuration.model, configuration.reasoning_effort,
    attempt.provider_status
from target_attempts as attempt
join public.pilot_stage1_assumptions_v2 as pilot
  on pilot.case_id = attempt.case_id
join public.analysis_cases_v2 as analysis_case
  on analysis_case.id = attempt.case_id
join public.analysis_project_configurations_v2 as configuration
  on configuration.id = analysis_case.configuration_id
cross join lateral (
    select
        private.extract_complete_stage1_report_array_v2(
            attempt.raw_model_output_text, 'meaning_units'
        ) as meaning_units,
        private.extract_complete_stage1_report_array_v2(
            attempt.raw_model_output_text, 'preliminary_codes'
        ) as codes,
        private.extract_complete_stage1_report_array_v2(
            attempt.raw_model_output_text, 'preliminary_categories'
        ) as categories,
        private.extract_complete_stage1_report_array_v2(
            attempt.raw_model_output_text, 'preliminary_tentative_themes'
        ) as themes
) as arrays
cross join lateral (
    select jsonb_build_object(
        'meaning_units', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(coalesce(
                    unit.value ->> 'id',
                    unit.value ->> 'meaning_unit_number',
                    unit.value ->> 'unit_number'
                ), 'MU', unit.ordinality),
                'sources', jsonb_build_array(jsonb_strip_nulls(
                    jsonb_build_object(
                        'message_id', unit.value ->> 'message_id',
                        'english_text', coalesce(
                            unit.value ->> 'exact_source_text',
                            unit.value ->> 'english_text',
                            unit.value ->> 'text'
                        )
                    )
                ))
            ) order by unit.ordinality)
            from jsonb_array_elements(arrays.meaning_units)
                with ordinality as unit(value, ordinality)
        ), '[]'::jsonb),
        'preliminary_codes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(coalesce(
                    code.value ->> 'id', code.value ->> 'code_number'
                ), 'CO', code.ordinality),
                'label', coalesce(
                    code.value ->> 'code',
                    code.value ->> 'code_label',
                    code.value ->> 'label'
                ),
                'meaning_unit_ids',
                    private.stage1_report_reference_ids_v2(
                        coalesce(
                            code.value -> 'meaning_unit_numbers',
                            code.value -> 'meaning_unit_ids'
                        ), 'MU'
                    ),
                'mention_count', code.value -> 'occurrence_count'
            ) order by code.ordinality)
            from jsonb_array_elements(arrays.codes)
                with ordinality as code(value, ordinality)
        ), '[]'::jsonb),
        'preliminary_categories', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(coalesce(
                    category.value ->> 'id',
                    category.value ->> 'category_number'
                ), 'CA', category.ordinality),
                'label', coalesce(
                    category.value ->> 'category',
                    category.value ->> 'category_label',
                    category.value ->> 'label'
                ),
                'code_ids', private.stage1_report_reference_ids_v2(
                    coalesce(
                        category.value -> 'code_numbers',
                        category.value -> 'code_ids'
                    ), 'CO'
                )
            ) order by category.ordinality)
            from jsonb_array_elements(arrays.categories)
                with ordinality as category(value, ordinality)
        ), '[]'::jsonb),
        'preliminary_tentative_themes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', private.stage1_report_id_v2(coalesce(
                    theme.value ->> 'id',
                    theme.value ->> 'theme_number',
                    theme.value ->> 'tentative_theme_number'
                ), 'TH', theme.ordinality),
                'statement', coalesce(
                    theme.value ->> 'theme',
                    theme.value ->> 'theme_label',
                    theme.value ->> 'tentative_theme',
                    theme.value ->> 'statement',
                    theme.value ->> 'label'
                ),
                'category_ids', private.stage1_report_reference_ids_v2(
                    coalesce(
                        theme.value -> 'category_numbers',
                        theme.value -> 'category_ids'
                    ), 'CA'
                )
            ) order by theme.ordinality)
            from jsonb_array_elements(arrays.themes)
                with ordinality as theme(value, ordinality)
        ), '[]'::jsonb),
        'presentation_provenance', jsonb_build_object(
            'kind', 'frozen_gpt56_response_projection',
            'provider', configuration.provider,
            'model', configuration.model,
            'reasoning_effort', configuration.reasoning_effort,
            'source_attempt_id', attempt.id,
            'source_response_sha256', encode(extensions.digest(
                convert_to(attempt.raw_model_output_text, 'UTF8'), 'sha256'
            ), 'hex'),
            'provider_response_changed', false,
            'new_ai_call', false,
            'researcher_inspection_required', false
        )
    ) as report_json
) as built
where configuration.provider = 'openai'
  and configuration.model = 'gpt-5.6-sol'
  and configuration.reasoning_effort = 'high'
  and jsonb_array_length(arrays.meaning_units) > 0
  and jsonb_array_length(arrays.codes) > 0
  and jsonb_array_length(arrays.categories) > 0
  and jsonb_array_length(arrays.themes) > 0;


    select count(*) into after_count
    from public.stage1_readable_reports_v2;
    return after_count - before_count;
end;
$function$;

