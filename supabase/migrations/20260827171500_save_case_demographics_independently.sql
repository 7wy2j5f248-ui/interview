create or replace function public.save_automatic_case_demographics(
    p_session_id text,
    p_analysis_version text,
    p_demographics jsonb,
    p_descriptor_sources jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    job public.automatic_case_analysis_jobs%rowtype;
begin
    select *
    into job
    from public.automatic_case_analysis_jobs
    where session_id = p_session_id
    for update;

    if not found
       or job.status <> 'processing'
       or job.analysis_version <> p_analysis_version then
        raise exception 'Automatic case job is not active for demographics.';
    end if;

    if jsonb_typeof(coalesce(p_demographics, '{}'::jsonb)) <> 'object'
       or jsonb_typeof(coalesce(p_descriptor_sources, '{}'::jsonb))
            <> 'object' then
        raise exception 'Automatic case demographics are invalid.';
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
        nullif(p_demographics ->> 'current_country', ''),
        nullif(p_demographics ->> 'current_region', ''),
        nullif(p_demographics ->> 'country_of_origin', ''),
        nullif(p_demographics ->> 'diaspora_status', ''),
        nullif(p_demographics ->> 'gender', ''),
        case when jsonb_typeof(p_demographics -> 'age') = 'number'
            then (p_demographics ->> 'age')::smallint end,
        case when jsonb_typeof(p_demographics -> 'birth_year') = 'number'
            then (p_demographics ->> 'birth_year')::smallint end,
        nullif(p_demographics ->> 'birth_cohort', ''),
        nullif(p_demographics ->> 'youth_status', ''),
        nullif(p_demographics ->> 'education_level', ''),
        nullif(p_demographics ->> 'social_identity', ''),
        case
            when jsonb_typeof(p_demographics -> 'additional_descriptors')
                = 'object'
                then p_demographics -> 'additional_descriptors'
            else '{}'::jsonb
        end,
        coalesce(p_descriptor_sources, '{}'::jsonb)
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

    return true;
end;
$function$;

revoke all on function public.save_automatic_case_demographics(
    text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_automatic_case_demographics(
    text, text, jsonb, jsonb
) to service_role;
