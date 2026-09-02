-- Researcher directive: model-output structure must never gate a Stage-1 case.
-- The case report is authoritative and completes independently. The normalized
-- MU/CO/CA/TH tables are only a best-effort display projection. Any projection
-- failure is retained as a system-owned note beside the exact model output.

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
    new_report_id uuid;
    item jsonb;
    item_ordinal integer;
    item_number integer;
    new_code_id uuid;
    new_category_id uuid;
    new_theme_id uuid;
    final_processing_notes jsonb;
begin
    select * into selected_job
    from public.advanced_preliminary_analysis_jobs
    where id = p_job_id for update;
    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The Stage 1 case-processing job is not processing.';
    end if;

    select * into selected_run
    from public.advanced_preliminary_analysis_runs
    where id = selected_job.run_id;

    final_processing_notes := case
        when jsonb_typeof(p_payload->'systemProcessingNotes') = 'array'
            then p_payload->'systemProcessingNotes'
        else '[]'::jsonb
    end;

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
        selected_run.prompt_version,
        coalesce(nullif(btrim(p_payload->>'caseSummary'), ''),
            'The model output was preserved without a case summary.'),
        case when jsonb_typeof(p_payload->'unassignedCodeNumbers') = 'array'
            then p_payload->'unassignedCodeNumbers' else '[]'::jsonb end,
        case when jsonb_typeof(p_payload->'unassignedCategoryNumbers') = 'array'
            then p_payload->'unassignedCategoryNumbers' else '[]'::jsonb end,
        coalesce(p_payload->'audit', '{}'::jsonb),
        p_input_token_count, p_output_token_count,
        coalesce(p_payload->>'rawModelOutputText', ''),
        p_payload->'rawModelOutput', final_processing_notes
    ) returning id into new_report_id;

    begin
        for item, item_ordinal in
            select value, ordinality::integer
            from jsonb_array_elements(
                case when jsonb_typeof(p_payload->'meaningUnits') = 'array'
                    then p_payload->'meaningUnits' else '[]'::jsonb end
            ) with ordinality
        loop
            item_number := coalesce((item->>'unitNumber')::integer, item_ordinal);
            insert into public.advanced_preliminary_meaning_units (
                report_id, unit_number, message_id, exact_source_text,
                source_language, start_offset, end_offset, occurrence_index,
                context_note
            ) values (
                new_report_id, item_number, (item->>'messageId')::uuid,
                coalesce(item->>'exactSourceText', ''), item->>'sourceLanguage',
                (item->>'startOffset')::integer, (item->>'endOffset')::integer,
                coalesce((item->>'occurrenceIndex')::integer, 1),
                item->>'contextNote'
            );
        end loop;

        for item, item_ordinal in
            select value, ordinality::integer
            from jsonb_array_elements(
                case when jsonb_typeof(p_payload->'codes') = 'array'
                    then p_payload->'codes' else '[]'::jsonb end
            ) with ordinality
        loop
            item_number := coalesce((item->>'codeNumber')::integer, item_ordinal);
            insert into public.advanced_preliminary_codes (
                report_id, code_number, code_label, definition, rationale,
                meaning_unit_count, occurrence_count
            ) values (
                new_report_id, item_number, coalesce(item->>'label', ''),
                coalesce(item->>'definition', ''), coalesce(item->>'rationale', ''),
                jsonb_array_length(coalesce(item->'meaningUnitNumbers', '[]'::jsonb)),
                jsonb_array_length(coalesce(item->'meaningUnitNumbers', '[]'::jsonb))
            ) returning id into new_code_id;

            insert into public.advanced_preliminary_code_meaning_units (
                report_id, code_id, meaning_unit_id
            )
            select new_report_id, new_code_id, meaning_unit.id
            from jsonb_array_elements_text(
                coalesce(item->'meaningUnitNumbers', '[]'::jsonb)
            ) as number(value)
            join public.advanced_preliminary_meaning_units as meaning_unit
              on meaning_unit.report_id = new_report_id
             and meaning_unit.unit_number = number.value::integer;
        end loop;

        for item, item_ordinal in
            select value, ordinality::integer
            from jsonb_array_elements(
                case when jsonb_typeof(p_payload->'categories') = 'array'
                    then p_payload->'categories' else '[]'::jsonb end
            ) with ordinality
        loop
            item_number := coalesce((item->>'categoryNumber')::integer, item_ordinal);
            insert into public.advanced_preliminary_categories (
                report_id, category_number, category_label, definition,
                rationale, code_count
            ) values (
                new_report_id, item_number, coalesce(item->>'label', ''),
                coalesce(item->>'definition', ''), coalesce(item->>'rationale', ''),
                jsonb_array_length(coalesce(item->'codeNumbers', '[]'::jsonb))
            ) returning id into new_category_id;

            insert into public.advanced_preliminary_category_codes (
                report_id, category_id, code_id
            )
            select new_report_id, new_category_id, code.id
            from jsonb_array_elements_text(
                coalesce(item->'codeNumbers', '[]'::jsonb)
            ) as number(value)
            join public.advanced_preliminary_codes as code
              on code.report_id = new_report_id
             and code.code_number = number.value::integer;
        end loop;

        for item, item_ordinal in
            select value, ordinality::integer
            from jsonb_array_elements(
                case when jsonb_typeof(p_payload->'tentativeThemes') = 'array'
                    then p_payload->'tentativeThemes' else '[]'::jsonb end
            ) with ordinality
        loop
            item_number := coalesce((item->>'themeNumber')::integer, item_ordinal);
            insert into public.advanced_preliminary_themes (
                report_id, theme_number, theme_label, rationale, category_count
            ) values (
                new_report_id, item_number, coalesce(item->>'label', ''),
                coalesce(item->>'rationale', ''),
                jsonb_array_length(coalesce(item->'categoryNumbers', '[]'::jsonb))
            ) returning id into new_theme_id;

            insert into public.advanced_preliminary_theme_categories (
                report_id, theme_id, category_id
            )
            select new_report_id, new_theme_id, category.id
            from jsonb_array_elements_text(
                coalesce(item->'categoryNumbers', '[]'::jsonb)
            ) as number(value)
            join public.advanced_preliminary_categories as category
              on category.report_id = new_report_id
             and category.category_number = number.value::integer;
        end loop;
    exception when others then
        final_processing_notes := final_processing_notes || jsonb_build_array(
            jsonb_build_object(
                'code', 'RELATIONAL_PROJECTION_STORAGE_UNAVAILABLE',
                'detail', 'The model output could not be fully represented in normalized display tables. The exact output remains preserved and the case remains completed.',
                'databaseErrorCode', sqlstate,
                'databaseError', sqlerrm
            )
        );
        update public.advanced_preliminary_case_reports
        set system_processing_notes = final_processing_notes
        where id = new_report_id;
    end;

    update public.advanced_preliminary_analysis_jobs
    set status = 'completed', completed_at = now(), lease_expires_at = null,
        next_retry_at = null, last_error = null,
        raw_model_output_text = coalesce(p_payload->>'rawModelOutputText', ''),
        parsed_model_output = p_payload->'rawModelOutput',
        system_processing_notes = final_processing_notes,
        updated_at = now()
    where id = selected_job.id;

    perform public.refresh_advanced_preliminary_analysis_run(selected_job.run_id);
    return new_report_id;
end;
$function$;

revoke all on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) to service_role;

comment on function public.complete_advanced_preliminary_analysis(
    uuid, text, text, integer, integer, jsonb
) is 'Completes Stage 1 from the preserved provider output. MU/CO/CA/TH normalization is a best-effort display projection and cannot reject the report, transcript, or participant.';
