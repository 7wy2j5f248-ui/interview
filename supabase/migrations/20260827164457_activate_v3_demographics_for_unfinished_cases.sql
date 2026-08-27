CREATE OR REPLACE FUNCTION public.complete_automatic_case_analysis(p_session_id text, p_model text, p_analysis_version text, p_input_token_count integer, p_payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
    job public.automatic_case_analysis_jobs%rowtype;
    stored_report_id uuid;
    stored_demographics jsonb;
    extracted_demographics jsonb := coalesce(
        p_payload -> 'demographics',
        '{}'::jsonb
    );
    extracted_sources jsonb := coalesce(
        p_payload -> 'descriptorSources',
        '{}'::jsonb
    );
    code_entry record;
    keyword_entry record;
    theme_entry record;
    code_id uuid;
    theme_id uuid;
    referenced_code_number integer;
begin
    select *
    into job
    from public.automatic_case_analysis_jobs
    where session_id = p_session_id
    for update;

    if not found
       or job.status <> 'processing'
       or job.analysis_version <> p_analysis_version then
        raise exception 'Automatic case job is not claimable for completion.';
    end if;

    if jsonb_typeof(p_payload -> 'codes') <> 'array'
       or jsonb_array_length(p_payload -> 'codes') = 0
       or jsonb_typeof(p_payload -> 'themes') <> 'array'
       or jsonb_array_length(p_payload -> 'themes') = 0
       or jsonb_typeof(extracted_demographics) <> 'object'
       or jsonb_typeof(extracted_sources) <> 'object' then
        raise exception 'Automatic case report is incomplete.';
    end if;

    insert into public.participant_descriptors as descriptor (
        session_id,
        participant_id,
        current_country,
        current_region,
        country_of_origin,
        diaspora_status,
        gender,
        age,
        birth_year,
        birth_cohort,
        youth_status,
        education_level,
        social_identity,
        additional_descriptors,
        descriptor_sources
    ) values (
        job.session_id,
        job.participant_id,
        nullif(extracted_demographics ->> 'current_country', ''),
        nullif(extracted_demographics ->> 'current_region', ''),
        nullif(extracted_demographics ->> 'country_of_origin', ''),
        nullif(extracted_demographics ->> 'diaspora_status', ''),
        nullif(extracted_demographics ->> 'gender', ''),
        case when jsonb_typeof(extracted_demographics -> 'age') = 'number'
            then (extracted_demographics ->> 'age')::smallint end,
        case when jsonb_typeof(extracted_demographics -> 'birth_year') = 'number'
            then (extracted_demographics ->> 'birth_year')::smallint end,
        nullif(extracted_demographics ->> 'birth_cohort', ''),
        nullif(extracted_demographics ->> 'youth_status', ''),
        nullif(extracted_demographics ->> 'education_level', ''),
        nullif(extracted_demographics ->> 'social_identity', ''),
        case
            when jsonb_typeof(
                extracted_demographics -> 'additional_descriptors'
            ) = 'object'
                then extracted_demographics -> 'additional_descriptors'
            else '{}'::jsonb
        end,
        extracted_sources
    )
    on conflict (session_id) do update
    set
        current_country = coalesce(
            descriptor.current_country,
            excluded.current_country
        ),
        current_region = coalesce(
            descriptor.current_region,
            excluded.current_region
        ),
        country_of_origin = coalesce(
            descriptor.country_of_origin,
            excluded.country_of_origin
        ),
        diaspora_status = coalesce(
            descriptor.diaspora_status,
            excluded.diaspora_status
        ),
        gender = coalesce(descriptor.gender, excluded.gender),
        age = coalesce(descriptor.age, excluded.age),
        birth_year = coalesce(descriptor.birth_year, excluded.birth_year),
        birth_cohort = coalesce(
            descriptor.birth_cohort,
            excluded.birth_cohort
        ),
        youth_status = coalesce(
            descriptor.youth_status,
            excluded.youth_status
        ),
        education_level = coalesce(
            descriptor.education_level,
            excluded.education_level
        ),
        social_identity = coalesce(
            descriptor.social_identity,
            excluded.social_identity
        ),
        additional_descriptors =
            excluded.additional_descriptors
            || descriptor.additional_descriptors,
        descriptor_sources =
            excluded.descriptor_sources
            || descriptor.descriptor_sources,
        updated_at = now();

    select jsonb_build_object(
        'current_country', descriptor.current_country,
        'current_region', descriptor.current_region,
        'country_of_origin', descriptor.country_of_origin,
        'diaspora_status', descriptor.diaspora_status,
        'gender', descriptor.gender,
        'age', descriptor.age,
        'birth_year', descriptor.birth_year,
        'birth_cohort', descriptor.birth_cohort,
        'youth_status', descriptor.youth_status,
        'education_level', descriptor.education_level,
        'social_identity', descriptor.social_identity,
        'additional_descriptors', descriptor.additional_descriptors
    )
    into stored_demographics
    from public.participant_descriptors as descriptor
    where descriptor.session_id = job.session_id;

    insert into public.qualitative_case_reports (
        session_id, case_number, participant_id, participant_code, language,
        analysis_version, model, demographics, case_interpretation,
        source_completed_at, input_token_count
    ) values (
        job.session_id,
        job.case_number,
        job.participant_id,
        p_payload ->> 'participantCode',
        nullif(p_payload ->> 'language', ''),
        p_analysis_version,
        p_model,
        stored_demographics,
        p_payload ->> 'caseInterpretation',
        job.source_completed_at,
        p_input_token_count
    )
    returning id into stored_report_id;

    for code_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'codes') with ordinality
    loop
        insert into public.qualitative_case_codes (
            report_id, code_number, code_label, rationale, color_slot
        ) values (
            stored_report_id,
            code_entry.position,
            code_entry.value ->> 'label',
            code_entry.value ->> 'rationale',
            ((code_entry.position - 1) % 12) + 1
        )
        returning id into code_id;

        for keyword_entry in
            select value, ordinality::integer as position
            from jsonb_array_elements(
                code_entry.value -> 'highlights'
            ) with ordinality
        loop
            insert into public.qualitative_case_keyword_highlights (
                report_id, code_id, keyword_number, message_id, exact_text,
                start_offset, end_offset
            ) values (
                stored_report_id,
                code_id,
                keyword_entry.position,
                (keyword_entry.value ->> 'messageId')::uuid,
                keyword_entry.value ->> 'exactText',
                (keyword_entry.value ->> 'startOffset')::integer,
                (keyword_entry.value ->> 'endOffset')::integer
            );
        end loop;
    end loop;

    for theme_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'themes') with ordinality
    loop
        insert into public.qualitative_case_themes (
            report_id, theme_number, theme_label, rationale
        ) values (
            stored_report_id,
            theme_entry.position,
            theme_entry.value ->> 'label',
            theme_entry.value ->> 'rationale'
        )
        returning id into theme_id;

        for referenced_code_number in
            select value::integer
            from jsonb_array_elements_text(
                theme_entry.value -> 'codeNumbers'
            )
        loop
            select id
            into code_id
            from public.qualitative_case_codes
            where report_id = stored_report_id
              and code_number = referenced_code_number;

            if code_id is null then
                raise exception 'Theme references an unavailable code number.';
            end if;

            insert into public.qualitative_case_theme_codes (
                report_id, theme_id, code_id
            ) values (
                stored_report_id, theme_id, code_id
            );
        end loop;
    end loop;

    update public.automatic_case_analysis_jobs
    set
        status = 'completed',
        completed_at = now(),
        lease_expires_at = null,
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    where session_id = p_session_id;

    return stored_report_id;
end;
$function$;

revoke all on function public.complete_automatic_case_analysis(
    text, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_automatic_case_analysis(
    text, text, text, integer, jsonb
) to service_role;

alter table public.automatic_case_analysis_jobs
alter column analysis_version
set default 'case-analysis-v3-evidence-backed-demographics';

update public.automatic_case_analysis_jobs
set
    analysis_version = 'case-analysis-v3-evidence-backed-demographics',
    status = 'pending',
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    last_error = null,
    updated_at = now()
where archived_at is null
  and status <> 'completed';

