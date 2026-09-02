-- Researcher directive: Stage 1 has no analytical validator or rejection gate.
-- Preserve the model response first. Relational tables are a non-rejecting
-- projection for display; projection limitations are system-owned notes.

alter table public.advanced_preliminary_analysis_jobs
    add column if not exists raw_model_output_text text not null default '',
    add column if not exists parsed_model_output jsonb,
    add column if not exists system_processing_notes jsonb not null default '[]'::jsonb;

alter table public.advanced_preliminary_case_reports
    add column if not exists raw_model_output_text text not null default '',
    add column if not exists parsed_model_output jsonb,
    add column if not exists system_processing_notes jsonb not null default '[]'::jsonb;

comment on column public.advanced_preliminary_case_reports.raw_model_output_text is
    'Exact provider output preserved before any relational projection. It is never rejected by an analytical validator.';
comment on column public.advanced_preliminary_case_reports.system_processing_notes is
    'System-owned projection or processing issues. These notes have no participant consequence and do not reject the report.';

alter table public.advanced_preliminary_codes
    drop constraint if exists advanced_preliminary_codes_meaning_unit_count_check,
    drop constraint if exists advanced_preliminary_codes_occurrence_count_check;

alter table public.advanced_preliminary_categories
    drop constraint if exists advanced_preliminary_categories_code_count_check;

alter table public.advanced_preliminary_themes
    drop constraint if exists advanced_preliminary_themes_theme_label_check,
    drop constraint if exists advanced_preliminary_themes_rationale_check,
    drop constraint if exists advanced_preliminary_themes_category_count_check;

do $$
declare
    selected_constraint record;
begin
    for selected_constraint in
        select constraint_record.conname
        from pg_constraint as constraint_record
        where constraint_record.conrelid =
            'public.advanced_preliminary_meaning_units'::regclass
          and constraint_record.contype = 'u'
          and pg_get_constraintdef(constraint_record.oid) like
              '%message_id, start_offset, end_offset%'
    loop
        execute format(
            'alter table public.advanced_preliminary_meaning_units drop constraint %I',
            selected_constraint.conname
        );
    end loop;
end;
$$;

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
        parsed_model_output = p_parsed_model_output,
        system_processing_notes = coalesce(
            p_system_processing_notes, '[]'::jsonb
        ),
        updated_at = now()
    where id = p_job_id
      and status = 'processing';

    if not found then
        raise exception 'The Stage 1 job is unavailable for model-output preservation.';
    end if;
end;
$function$;

revoke all on function public.save_advanced_preliminary_model_output(
    uuid, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_advanced_preliminary_model_output(
    uuid, text, jsonb, jsonb
) to service_role;

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
        coalesce(p_payload->'unassignedCodeNumbers', '[]'::jsonb),
        coalesce(p_payload->'unassignedCategoryNumbers', '[]'::jsonb),
        coalesce(p_payload->'audit', '{}'::jsonb),
        p_input_token_count, p_output_token_count,
        coalesce(p_payload->>'rawModelOutputText', ''),
        p_payload->'rawModelOutput',
        coalesce(p_payload->'systemProcessingNotes', '[]'::jsonb)
    ) returning id into new_report_id;

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

    update public.advanced_preliminary_analysis_jobs
    set status = 'completed', completed_at = now(), lease_expires_at = null,
        next_retry_at = null, last_error = null,
        raw_model_output_text = coalesce(p_payload->>'rawModelOutputText', ''),
        parsed_model_output = p_payload->'rawModelOutput',
        system_processing_notes = coalesce(
            p_payload->'systemProcessingNotes', '[]'::jsonb
        ),
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

do $$
declare
    selected_rules public.global_analysis_rules%rowtype;
    next_version integer;
    inserted_rule_id uuid;
begin
    lock table public.global_analysis_rules in share row exclusive mode;

    select rules.*
    into selected_rules
    from public.active_global_analysis_rules as active
    join public.global_analysis_rules as rules on rules.id = active.rule_id
    where active.singleton = true;

    if selected_rules.id is not null
       and position('GOV-PART-002' in selected_rules.rules_text) = 0 then
        select coalesce(max(rules.version_number), 0) + 1
        into next_version
        from public.global_analysis_rules as rules;

        insert into public.global_analysis_rules (
            version_number, predecessor_id, rules_text, version_notes, created_by
        ) values (
            next_version,
            selected_rules.id,
            'GOV-PART-002 — Stage 1 has no analytical validator. Preserve the exact completed model response before any relational display projection. No application, schema, prompt, model, or database validator may accept or reject Meaning Units, Codes, Categories, Themes, relationships, counts, summaries, reports, participants, or transcripts. Anything the platform cannot project remains in the preserved output with a visible system-owned processing note. Researchers judge analytical usefulness; the platform and its experts resolve technical problems.'
                || E'\n\n'
                || selected_rules.rules_text,
            'Researcher-directed withdrawal of the system-derived Stage-1 validator and whole-report rejection behavior.',
            'researcher-governance-GOV-PART-002'
        ) returning id into inserted_rule_id;

        update public.active_global_analysis_rules
        set rule_id = inserted_rule_id,
            activated_at = now(),
            activated_by = 'researcher-governance-GOV-PART-002'
        where singleton = true;
    end if;
end;
$$;
