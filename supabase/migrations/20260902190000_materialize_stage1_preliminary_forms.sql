create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to service_role;

create table public.stage1_preliminary_materialization_runs (
    id uuid primary key default gen_random_uuid(),
    source_run_id uuid not null references public.advanced_preliminary_analysis_runs(id),
    status text not null default 'processing'
        check (status in ('processing', 'completed', 'failed')),
    source_case_count integer not null default 0,
    participant_form_case_count integer not null default 0,
    meaning_unit_form_case_count integer not null default 0,
    code_form_case_count integer not null default 0,
    category_form_case_count integer not null default 0,
    implied_theme_form_case_count integer not null default 0,
    exception_case_count integer not null default 0,
    new_ai_api_call_count integer not null default 0
        check (new_ai_api_call_count = 0),
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    last_error text,
    unique (source_run_id)
);

create table public.stage1_preliminary_case_forms (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_run_id uuid not null references public.advanced_preliminary_analysis_runs(id),
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    source_report_id uuid references public.advanced_preliminary_case_reports(id),
    session_id text not null,
    participant_id text not null,
    participant_code text not null,
    case_number text not null,
    session_sequence integer,
    language text,
    current_country text,
    current_region text,
    country_of_origin text,
    diaspora_status text,
    gender text,
    age smallint,
    birth_year smallint,
    birth_cohort text,
    youth_status text,
    education_level text,
    social_identity text,
    additional_descriptors jsonb not null default '{}'::jsonb,
    descriptor_sources jsonb not null default '{}'::jsonb,
    raw_response_provenance jsonb not null,
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id),
    unique (materialization_run_id, case_number)
);

create table public.stage1_preliminary_meaning_units (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    source_report_id uuid references public.advanced_preliminary_case_reports(id),
    participant_code text not null,
    case_number text not null,
    position integer not null check (position > 0),
    source_identifier text,
    exact_text text not null,
    source_message_id text,
    occurrence_index integer,
    source_language text,
    linked_code_references text[] not null default '{}'::text[],
    source_object jsonb not null,
    source_locator text not null,
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id, position)
);

create table public.stage1_preliminary_codes (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    source_report_id uuid references public.advanced_preliminary_case_reports(id),
    participant_code text not null,
    case_number text not null,
    position integer not null check (position > 0),
    source_identifier text,
    code_label text not null,
    definition text,
    rationale text,
    meaning_unit_references text[] not null default '{}'::text[],
    linked_category_references text[] not null default '{}'::text[],
    source_object jsonb not null,
    source_locator text not null,
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id, position)
);

create table public.stage1_preliminary_categories (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    source_report_id uuid references public.advanced_preliminary_case_reports(id),
    participant_code text not null,
    case_number text not null,
    position integer not null check (position > 0),
    source_identifier text,
    category_label text not null,
    definition text,
    rationale text,
    code_references text[] not null default '{}'::text[],
    linked_theme_references text[] not null default '{}'::text[],
    source_object jsonb not null,
    source_locator text not null,
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id, position)
);

create table public.stage1_preliminary_implied_themes (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    source_report_id uuid references public.advanced_preliminary_case_reports(id),
    participant_code text not null,
    case_number text not null,
    position integer not null check (position > 0),
    source_identifier text,
    theme_label text not null,
    definition text,
    rationale text,
    category_references text[] not null default '{}'::text[],
    source_object jsonb not null,
    source_locator text not null,
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id, position)
);

create table public.stage1_preliminary_materialization_exceptions (
    id uuid primary key default gen_random_uuid(),
    materialization_run_id uuid not null
        references public.stage1_preliminary_materialization_runs(id)
        on delete cascade,
    source_job_id uuid not null references public.advanced_preliminary_analysis_jobs(id),
    participant_code text not null,
    case_number text not null,
    raw_format text not null,
    reason text not null,
    materialized_components jsonb not null default '{}'::jsonb,
    raw_response_preserved_in text not null
        default 'advanced_preliminary_analysis_jobs.raw_model_output_text',
    created_at timestamptz not null default now(),
    unique (materialization_run_id, source_job_id)
);

create index stage1_preliminary_case_forms_participant_idx
on public.stage1_preliminary_case_forms(materialization_run_id, participant_code);
create index stage1_preliminary_mu_case_idx
on public.stage1_preliminary_meaning_units(materialization_run_id, participant_code, position);
create index stage1_preliminary_codes_case_idx
on public.stage1_preliminary_codes(materialization_run_id, participant_code, position);
create index stage1_preliminary_categories_case_idx
on public.stage1_preliminary_categories(materialization_run_id, participant_code, position);
create index stage1_preliminary_themes_case_idx
on public.stage1_preliminary_implied_themes(materialization_run_id, participant_code, position);

alter table public.stage1_preliminary_materialization_runs enable row level security;
alter table public.stage1_preliminary_case_forms enable row level security;
alter table public.stage1_preliminary_meaning_units enable row level security;
alter table public.stage1_preliminary_codes enable row level security;
alter table public.stage1_preliminary_categories enable row level security;
alter table public.stage1_preliminary_implied_themes enable row level security;
alter table public.stage1_preliminary_materialization_exceptions enable row level security;

revoke all on table public.stage1_preliminary_materialization_runs from anon, authenticated;
revoke all on table public.stage1_preliminary_case_forms from anon, authenticated;
revoke all on table public.stage1_preliminary_meaning_units from anon, authenticated;
revoke all on table public.stage1_preliminary_codes from anon, authenticated;
revoke all on table public.stage1_preliminary_categories from anon, authenticated;
revoke all on table public.stage1_preliminary_implied_themes from anon, authenticated;
revoke all on table public.stage1_preliminary_materialization_exceptions from anon, authenticated;

grant select, insert, update, delete on table public.stage1_preliminary_materialization_runs to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_case_forms to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_meaning_units to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_codes to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_categories to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_implied_themes to service_role;
grant select, insert, update, delete on table public.stage1_preliminary_materialization_exceptions to service_role;

create or replace function private.stage1_try_parse_json(p_raw text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
    candidate text;
begin
    if p_raw is null then return null; end if;
    if pg_catalog.pg_input_is_valid(p_raw, 'jsonb') then
        return p_raw::jsonb;
    end if;
    if p_raw ~ '^\s*```json' then
        candidate := pg_catalog.regexp_replace(p_raw, '^\s*```json\s*', '', 'i');
        candidate := pg_catalog.regexp_replace(candidate, '\s*```\s*$', '');
        if pg_catalog.pg_input_is_valid(candidate, 'jsonb') then
            return candidate::jsonb;
        end if;
    end if;
    return null;
end;
$$;

create or replace function private.stage1_json_text_array(p_value jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
    select case
        when pg_catalog.jsonb_typeof(p_value) = 'array' then
            coalesce((
                select pg_catalog.array_agg(element #>> '{}' order by ordinal)
                from pg_catalog.jsonb_array_elements(p_value)
                    with ordinality as item(element, ordinal)
            ), '{}'::text[])
        when pg_catalog.jsonb_typeof(p_value) in ('string', 'number') then
            array[p_value #>> '{}']
        else '{}'::text[]
    end;
$$;

create or replace function private.stage1_clean_markdown(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
    select nullif(
        pg_catalog.btrim(
            pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(
                    pg_catalog.regexp_replace(coalesce(p_value, ''), '\\([|])', '\1', 'g'),
                    '^\s*(\*\*|__|`)+', ''
                ),
                '(\*\*|__|`)+\s*$', ''
            )
        ),
        ''
    );
$$;

create or replace function private.stage1_clean_heading_label(
    p_value text,
    p_kind text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
    result text := private.stage1_clean_markdown(p_value);
begin
    if p_kind = 'category' then
        result := pg_catalog.regexp_replace(
            result,
            '^\s*(category|ca|c)\s*[a-z0-9]+\s*[:.\-]\s*',
            '', 'i'
        );
    elsif p_kind = 'theme' then
        result := pg_catalog.regexp_replace(
            result,
            '^\s*(tentative\s+theme|theme|th)\s*[a-z0-9]+\s*[:.\-]\s*',
            '', 'i'
        );
    end if;
    result := pg_catalog.regexp_replace(result, '^\s*[0-9]+\s*[.:]\s*', '');
    return private.stage1_clean_markdown(result);
end;
$$;

create or replace function private.materialize_stage1_preliminary_forms(
    p_source_run_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    materialization_id uuid;
    v_source_case_count integer;
    job record;
    document jsonb;
    root jsonb;
    item jsonb;
    item_ordinal bigint;
    participant_code text;
    raw_format text;
    parse_failed boolean;
    parse_reason text;
    line_record record;
    line_text text;
    heading_text text;
    current_section text;
    headers text[];
    cells text[];
    header_text text;
    header_index integer;
    identifier_index integer;
    label_index integer;
    reference_index integer;
    code_index integer;
    next_position integer;
    mu_position integer;
    v_source_identifier text;
    extracted_text text;
    extracted_label text;
    references_text text;
    code_piece text;
    existing_code_position integer;
begin
    select count(*) into v_source_case_count
    from public.advanced_preliminary_analysis_jobs
    where run_id = p_source_run_id;

    if v_source_case_count = 0 then
        raise exception 'The requested Stage 1 run has no case responses.';
    end if;

    select id into materialization_id
    from public.stage1_preliminary_materialization_runs
    where source_run_id = p_source_run_id;

    if materialization_id is null then
        insert into public.stage1_preliminary_materialization_runs (
            source_run_id, status, source_case_count
        ) values (
            p_source_run_id, 'processing', v_source_case_count
        ) returning id into materialization_id;
    else
        delete from public.stage1_preliminary_case_forms
        where materialization_run_id = materialization_id;
        delete from public.stage1_preliminary_meaning_units
        where materialization_run_id = materialization_id;
        delete from public.stage1_preliminary_codes
        where materialization_run_id = materialization_id;
        delete from public.stage1_preliminary_categories
        where materialization_run_id = materialization_id;
        delete from public.stage1_preliminary_implied_themes
        where materialization_run_id = materialization_id;
        delete from public.stage1_preliminary_materialization_exceptions
        where materialization_run_id = materialization_id;
        update public.stage1_preliminary_materialization_runs
        set status = 'processing', source_case_count = v_source_case_count,
            participant_form_case_count = 0,
            meaning_unit_form_case_count = 0,
            code_form_case_count = 0,
            category_form_case_count = 0,
            implied_theme_form_case_count = 0,
            exception_case_count = 0,
            new_ai_api_call_count = 0,
            started_at = now(), completed_at = null, last_error = null
        where id = materialization_id;
    end if;

    for job in
        select j.*, s.language as session_language,
            d.current_country, d.current_region, d.country_of_origin,
            d.diaspora_status, d.gender, d.age, d.birth_year,
            d.birth_cohort, d.youth_status, d.education_level,
            d.social_identity, d.additional_descriptors,
            d.descriptor_sources
        from public.advanced_preliminary_analysis_jobs j
        join public.interview_sessions s on s.session_id = j.session_id
        left join public.participant_descriptors d on d.session_id = j.session_id
        where j.run_id = p_source_run_id
        order by j.case_number, j.session_id
    loop
        participant_code := pg_catalog.regexp_replace(job.case_number, '-S[0-9]+$', '');
        insert into public.stage1_preliminary_case_forms (
            materialization_run_id, source_run_id, source_job_id,
            source_report_id, session_id, participant_id,
            participant_code, case_number, session_sequence, language,
            current_country, current_region, country_of_origin,
            diaspora_status, gender, age, birth_year, birth_cohort,
            youth_status, education_level, social_identity,
            additional_descriptors, descriptor_sources,
            raw_response_provenance
        ) values (
            materialization_id, p_source_run_id, job.id,
            job.source_report_id, job.session_id, job.participant_id,
            participant_code, job.case_number,
            ((pg_catalog.regexp_match(job.case_number, '-S([0-9]+)$'))[1])::integer,
            job.session_language,
            job.current_country, job.current_region, job.country_of_origin,
            job.diaspora_status, job.gender, job.age, job.birth_year,
            job.birth_cohort, job.youth_status, job.education_level,
            job.social_identity,
            coalesce(job.additional_descriptors, '{}'::jsonb),
            coalesce(job.descriptor_sources, '{}'::jsonb),
            pg_catalog.jsonb_build_object(
                'table', 'advanced_preliminary_analysis_jobs',
                'job_id', job.id,
                'run_id', p_source_run_id,
                'raw_column', 'raw_model_output_text',
                'source_report_id', job.source_report_id
            )
        );

        parse_failed := false;
        parse_reason := null;
        document := private.stage1_try_parse_json(job.raw_model_output_text);

        if document is not null then
            raw_format := case
                when job.raw_model_output_text ~ '^\s*```json' then 'fenced_json'
                else 'json'
            end;
            root := document;
            if pg_catalog.jsonb_typeof(root -> 'meaning_units') <> 'array'
                and pg_catalog.jsonb_typeof(document -> 'case_report') = 'object'
                and pg_catalog.jsonb_typeof(document -> 'case_report' -> 'meaning_units') = 'array'
            then
                root := document -> 'case_report';
            elsif pg_catalog.jsonb_typeof(root -> 'meaning_units') <> 'array'
                and pg_catalog.jsonb_typeof(document -> 'analysis_record') = 'object'
                and pg_catalog.jsonb_typeof(document -> 'analysis_record' -> 'meaning_units') = 'array'
            then
                root := document -> 'analysis_record';
            end if;

            if pg_catalog.jsonb_typeof(root -> 'meaning_units') <> 'array'
                or pg_catalog.jsonb_typeof(coalesce(root -> 'preliminary_codes', root -> 'codes')) <> 'array'
                or pg_catalog.jsonb_typeof(coalesce(root -> 'preliminary_categories', root -> 'categories')) <> 'array'
                or pg_catalog.jsonb_typeof(coalesce(root -> 'preliminary_tentative_themes', root -> 'tentative_themes')) <> 'array'
            then
                parse_failed := true;
                parse_reason := 'The JSON response does not contain all four required analytical arrays in a supported deterministic location.';
            else
                for item, item_ordinal in
                    select value, ordinality
                    from pg_catalog.jsonb_array_elements(root -> 'meaning_units')
                        with ordinality
                loop
                    extracted_text := coalesce(
                        item ->> 'exact_source_text', item ->> 'meaning_unit',
                        item ->> 'text', item ->> 'transcript_segment'
                    );
                    if extracted_text is null then
                        parse_failed := true;
                        parse_reason := 'A JSON Meaning Unit is missing its text field.';
                        exit;
                    end if;
                    v_source_identifier := coalesce(
                        item ->> 'meaning_unit_number', item ->> 'number',
                        item ->> 'display_id', 'MU' || item_ordinal::text
                    );
                    insert into public.stage1_preliminary_meaning_units (
                        materialization_run_id, source_job_id, source_report_id,
                        participant_code, case_number, position,
                        source_identifier, exact_text, source_message_id,
                        occurrence_index, source_language, linked_code_references,
                        source_object, source_locator
                    ) values (
                        materialization_id, job.id, job.source_report_id,
                        participant_code, job.case_number, item_ordinal::integer,
                        v_source_identifier, extracted_text,
                        coalesce(item ->> 'message_id', item ->> 'source_message_id'),
                        case when coalesce(item ->> 'occurrence_index', '') ~ '^[0-9]+$'
                            then (item ->> 'occurrence_index')::integer end,
                        coalesce(item ->> 'source_language', item ->> 'language', item ->> 'original_language'),
                        private.stage1_json_text_array(coalesce(
                            item -> 'linked_code_numbers', item -> 'preliminary_code_numbers',
                            item -> 'code_numbers'
                        )),
                        item, '$.meaning_units[' || (item_ordinal - 1)::text || ']'
                    );
                end loop;

                if not parse_failed then
                    for item, item_ordinal in
                        select value, ordinality
                        from pg_catalog.jsonb_array_elements(
                            coalesce(root -> 'preliminary_codes', root -> 'codes')
                        ) with ordinality
                    loop
                        extracted_label := coalesce(item ->> 'code', item ->> 'label');
                        if extracted_label is null then
                            parse_failed := true;
                            parse_reason := 'A JSON preliminary Code is missing its label field.';
                            exit;
                        end if;
                        insert into public.stage1_preliminary_codes (
                            materialization_run_id, source_job_id, source_report_id,
                            participant_code, case_number, position,
                            source_identifier, code_label, definition, rationale,
                            meaning_unit_references, linked_category_references,
                            source_object, source_locator
                        ) values (
                            materialization_id, job.id, job.source_report_id,
                            participant_code, job.case_number, item_ordinal::integer,
                            coalesce(item ->> 'code_number', item ->> 'number', item ->> 'display_id', 'CO' || item_ordinal::text),
                            extracted_label, item ->> 'definition', item ->> 'rationale',
                            private.stage1_json_text_array(item -> 'meaning_unit_numbers'),
                            private.stage1_json_text_array(coalesce(item -> 'linked_category_numbers', item -> 'category_numbers')),
                            item, '$.preliminary_codes[' || (item_ordinal - 1)::text || ']'
                        );
                    end loop;
                end if;

                if not parse_failed then
                    for item, item_ordinal in
                        select value, ordinality
                        from pg_catalog.jsonb_array_elements(
                            coalesce(root -> 'preliminary_categories', root -> 'categories')
                        ) with ordinality
                    loop
                        extracted_label := coalesce(item ->> 'category', item ->> 'label');
                        if extracted_label is null then
                            parse_failed := true;
                            parse_reason := 'A JSON preliminary Category is missing its label field.';
                            exit;
                        end if;
                        insert into public.stage1_preliminary_categories (
                            materialization_run_id, source_job_id, source_report_id,
                            participant_code, case_number, position,
                            source_identifier, category_label, definition, rationale,
                            code_references, linked_theme_references,
                            source_object, source_locator
                        ) values (
                            materialization_id, job.id, job.source_report_id,
                            participant_code, job.case_number, item_ordinal::integer,
                            coalesce(item ->> 'category_number', item ->> 'number', item ->> 'display_id', 'CA' || item_ordinal::text),
                            extracted_label, item ->> 'definition', item ->> 'rationale',
                            private.stage1_json_text_array(item -> 'code_numbers'),
                            private.stage1_json_text_array(coalesce(item -> 'linked_theme_numbers', item -> 'tentative_theme_numbers', item -> 'theme_numbers')),
                            item, '$.preliminary_categories[' || (item_ordinal - 1)::text || ']'
                        );
                    end loop;
                end if;

                if not parse_failed then
                    for item, item_ordinal in
                        select value, ordinality
                        from pg_catalog.jsonb_array_elements(
                            coalesce(root -> 'preliminary_tentative_themes', root -> 'tentative_themes')
                        ) with ordinality
                    loop
                        extracted_label := coalesce(
                            item ->> 'tentative_theme', item ->> 'theme', item ->> 'label'
                        );
                        if extracted_label is null then
                            parse_failed := true;
                            parse_reason := 'A JSON preliminary implied Theme is missing its label field.';
                            exit;
                        end if;
                        insert into public.stage1_preliminary_implied_themes (
                            materialization_run_id, source_job_id, source_report_id,
                            participant_code, case_number, position,
                            source_identifier, theme_label, definition, rationale,
                            category_references, source_object, source_locator
                        ) values (
                            materialization_id, job.id, job.source_report_id,
                            participant_code, job.case_number, item_ordinal::integer,
                            coalesce(item ->> 'theme_number', item ->> 'tentative_theme_number', item ->> 'number', item ->> 'display_id', 'TH' || item_ordinal::text),
                            extracted_label, item ->> 'definition', item ->> 'rationale',
                            private.stage1_json_text_array(item -> 'category_numbers'),
                            item, '$.preliminary_tentative_themes[' || (item_ordinal - 1)::text || ']'
                        );
                    end loop;
                end if;
            end if;
        elsif job.raw_model_output_text ~ '^\s*#' then
            raw_format := 'structured_markdown';
            current_section := null;
            headers := null;
            identifier_index := null;
            label_index := null;
            reference_index := null;
            code_index := null;

            for line_record in
                select line, ordinality
                from pg_catalog.regexp_split_to_table(job.raw_model_output_text, E'\n')
                    with ordinality as source(line, ordinality)
            loop
                line_text := line_record.line;

                if line_text ~ '^##\s+' and line_text !~ '^###\s+' then
                    heading_text := lower(pg_catalog.regexp_replace(line_text, '^##\s+', ''));
                    if heading_text like '%meaning unit%' then
                        current_section := 'meaning_units';
                    elsif heading_text like '%tentative theme%' then
                        current_section := 'themes';
                    elsif heading_text like '%categor%' then
                        current_section := 'categories';
                    elsif heading_text like '%preliminary code%' then
                        current_section := 'codes';
                    else
                        current_section := null;
                    end if;
                    headers := null;
                    identifier_index := null;
                    label_index := null;
                    reference_index := null;
                    code_index := null;
                    continue;
                end if;

                if line_text ~ '^###\s+' and current_section in ('categories', 'themes') then
                    heading_text := pg_catalog.regexp_replace(line_text, '^###\s+', '');
                    if current_section = 'categories' then
                        select coalesce(max(position), 0) + 1 into next_position
                        from public.stage1_preliminary_categories
                        where materialization_run_id = materialization_id
                          and source_job_id = job.id;
                        extracted_label := private.stage1_clean_heading_label(heading_text, 'category');
                        if extracted_label is not null then
                            insert into public.stage1_preliminary_categories (
                                materialization_run_id, source_job_id, source_report_id,
                                participant_code, case_number, position,
                                source_identifier, category_label,
                                source_object, source_locator
                            ) values (
                                materialization_id, job.id, job.source_report_id,
                                participant_code, job.case_number, next_position,
                                'CA' || next_position::text, extracted_label,
                                pg_catalog.jsonb_build_object('markdown_heading', heading_text),
                                'markdown:line:' || line_record.ordinality::text
                            );
                        end if;
                    else
                        select coalesce(max(position), 0) + 1 into next_position
                        from public.stage1_preliminary_implied_themes
                        where materialization_run_id = materialization_id
                          and source_job_id = job.id;
                        extracted_label := private.stage1_clean_heading_label(heading_text, 'theme');
                        if extracted_label is not null then
                            insert into public.stage1_preliminary_implied_themes (
                                materialization_run_id, source_job_id, source_report_id,
                                participant_code, case_number, position,
                                source_identifier, theme_label,
                                source_object, source_locator
                            ) values (
                                materialization_id, job.id, job.source_report_id,
                                participant_code, job.case_number, next_position,
                                'TH' || next_position::text, extracted_label,
                                pg_catalog.jsonb_build_object('markdown_heading', heading_text),
                                'markdown:line:' || line_record.ordinality::text
                            );
                        end if;
                    end if;
                    continue;
                end if;

                if current_section is null or line_text !~ '^\s*\|' then
                    continue;
                end if;
                if line_text ~ '^\s*\|\s*:?-{3,}' then
                    continue;
                end if;

                cells := pg_catalog.regexp_split_to_array(
                    pg_catalog.btrim(line_text, '|'), '\s*\|\s*'
                );
                if headers is null then
                    headers := cells;
                    for header_index in 1..pg_catalog.array_length(headers, 1) loop
                        header_text := lower(pg_catalog.btrim(headers[header_index]));
                        if header_text in ('mu', 'meaning unit', 'code', 'category', 'theme') then
                            identifier_index := header_index;
                        end if;
                        if header_text = 'label' then
                            label_index := header_index;
                        elsif current_section = 'meaning_units'
                            and label_index is null
                            and (header_text like '%exact_source_text%'
                                or header_text like '%transcript segment%'
                                or header_text like '%meaning unit grounded%'
                                or header_text like '%condensed meaning unit%')
                        then
                            label_index := header_index;
                        end if;
                        if header_text like '%meaning unit%' and current_section = 'codes' then
                            reference_index := header_index;
                        elsif header_text = 'codes' and current_section = 'categories' then
                            reference_index := header_index;
                        elsif header_text = 'categories' and current_section = 'themes' then
                            reference_index := header_index;
                        end if;
                        if current_section = 'meaning_units'
                            and header_text like '%preliminary code%'
                        then
                            code_index := header_index;
                        end if;
                    end loop;
                    if label_index is null then
                        if current_section = 'meaning_units' then
                            label_index := case
                                when pg_catalog.array_length(headers, 1) >= 2 then 2
                                else 1 end;
                        else
                            label_index := case
                                when pg_catalog.array_length(headers, 1) >= 2 then 2
                                else 1 end;
                        end if;
                    end if;
                    continue;
                end if;

                if pg_catalog.array_length(cells, 1) <> pg_catalog.array_length(headers, 1) then
                    parse_failed := true;
                    parse_reason := 'A structured Markdown table row has an ambiguous number of cells.';
                    exit;
                end if;

                if current_section = 'meaning_units' then
                    select coalesce(max(position), 0) + 1 into mu_position
                    from public.stage1_preliminary_meaning_units
                    where materialization_run_id = materialization_id
                      and source_job_id = job.id;
                    extracted_text := private.stage1_clean_markdown(cells[label_index]);
                    if label_index = identifier_index then
                        extracted_text := pg_catalog.regexp_replace(
                            extracted_text,
                            '^\s*(MU\s*)?[0-9]+(?:\s*\([^)]*\))?\s*[.:\-]\s*',
                            '', 'i'
                        );
                    end if;
                    v_source_identifier := case
                        when identifier_index is not null then
                            private.stage1_clean_markdown(cells[identifier_index])
                        else 'MU' || mu_position::text end;
                    if extracted_text is null then
                        parse_failed := true;
                        parse_reason := 'A structured Markdown Meaning Unit row has no extractable text.';
                        exit;
                    end if;
                    insert into public.stage1_preliminary_meaning_units (
                        materialization_run_id, source_job_id, source_report_id,
                        participant_code, case_number, position,
                        source_identifier, exact_text, source_object, source_locator
                    ) values (
                        materialization_id, job.id, job.source_report_id,
                        participant_code, job.case_number, mu_position,
                        v_source_identifier, extracted_text,
                        pg_catalog.jsonb_build_object('markdown_row', line_text, 'headers', headers),
                        'markdown:line:' || line_record.ordinality::text
                    );

                    if code_index is not null then
                        for code_piece in
                            select private.stage1_clean_markdown(value)
                            from pg_catalog.regexp_split_to_table(cells[code_index], '\s*;\s*') value
                        loop
                            if code_piece is null then continue; end if;
                            select position into existing_code_position
                            from public.stage1_preliminary_codes
                            where materialization_run_id = materialization_id
                              and source_job_id = job.id
                              and code_label = code_piece
                            order by position limit 1;
                            if existing_code_position is null then
                                select coalesce(max(position), 0) + 1 into next_position
                                from public.stage1_preliminary_codes
                                where materialization_run_id = materialization_id
                                  and source_job_id = job.id;
                                insert into public.stage1_preliminary_codes (
                                    materialization_run_id, source_job_id, source_report_id,
                                    participant_code, case_number, position,
                                    source_identifier, code_label, meaning_unit_references,
                                    source_object, source_locator
                                ) values (
                                    materialization_id, job.id, job.source_report_id,
                                    participant_code, job.case_number, next_position,
                                    'CO' || next_position::text, code_piece,
                                    array[v_source_identifier],
                                    pg_catalog.jsonb_build_object(
                                        'markdown_code_cell', cells[code_index],
                                        'markdown_row', line_text
                                    ),
                                    'markdown:line:' || line_record.ordinality::text
                                );
                            else
                                update public.stage1_preliminary_codes as preliminary_code
                                set meaning_unit_references = pg_catalog.array_append(
                                    preliminary_code.meaning_unit_references,
                                    v_source_identifier
                                )
                                where preliminary_code.materialization_run_id = materialization_id
                                  and preliminary_code.source_job_id = job.id
                                  and preliminary_code.position = existing_code_position
                                  and not (v_source_identifier = any(preliminary_code.meaning_unit_references));
                            end if;
                            existing_code_position := null;
                        end loop;
                    end if;
                elsif current_section = 'codes' then
                    select coalesce(max(position), 0) + 1 into next_position
                    from public.stage1_preliminary_codes
                    where materialization_run_id = materialization_id
                      and source_job_id = job.id;
                    extracted_label := private.stage1_clean_markdown(cells[label_index]);
                    references_text := case when reference_index is not null
                        then cells[reference_index] else null end;
                    insert into public.stage1_preliminary_codes (
                        materialization_run_id, source_job_id, source_report_id,
                        participant_code, case_number, position,
                        source_identifier, code_label, meaning_unit_references,
                        source_object, source_locator
                    ) values (
                        materialization_id, job.id, job.source_report_id,
                        participant_code, job.case_number, next_position,
                        case when identifier_index is not null
                            then private.stage1_clean_markdown(cells[identifier_index])
                            else 'CO' || next_position::text end,
                        extracted_label,
                        case when references_text is null then '{}'::text[] else
                            pg_catalog.regexp_split_to_array(
                                pg_catalog.regexp_replace(references_text, '\s+', '', 'g'), ','
                            ) end,
                        pg_catalog.jsonb_build_object('markdown_row', line_text, 'headers', headers),
                        'markdown:line:' || line_record.ordinality::text
                    );
                elsif current_section = 'categories' then
                    select coalesce(max(position), 0) + 1 into next_position
                    from public.stage1_preliminary_categories
                    where materialization_run_id = materialization_id
                      and source_job_id = job.id;
                    extracted_label := private.stage1_clean_markdown(cells[label_index]);
                    references_text := case when reference_index is not null
                        then cells[reference_index] else null end;
                    insert into public.stage1_preliminary_categories (
                        materialization_run_id, source_job_id, source_report_id,
                        participant_code, case_number, position,
                        source_identifier, category_label, code_references,
                        source_object, source_locator
                    ) values (
                        materialization_id, job.id, job.source_report_id,
                        participant_code, job.case_number, next_position,
                        case when identifier_index is not null
                            then private.stage1_clean_markdown(cells[identifier_index])
                            else 'CA' || next_position::text end,
                        extracted_label,
                        case when references_text is null then '{}'::text[] else
                            pg_catalog.regexp_split_to_array(
                                pg_catalog.regexp_replace(references_text, '\s+', '', 'g'), ','
                            ) end,
                        pg_catalog.jsonb_build_object('markdown_row', line_text, 'headers', headers),
                        'markdown:line:' || line_record.ordinality::text
                    );
                elsif current_section = 'themes' then
                    select coalesce(max(position), 0) + 1 into next_position
                    from public.stage1_preliminary_implied_themes
                    where materialization_run_id = materialization_id
                      and source_job_id = job.id;
                    extracted_label := private.stage1_clean_markdown(cells[label_index]);
                    references_text := case when reference_index is not null
                        then cells[reference_index] else null end;
                    insert into public.stage1_preliminary_implied_themes (
                        materialization_run_id, source_job_id, source_report_id,
                        participant_code, case_number, position,
                        source_identifier, theme_label, category_references,
                        source_object, source_locator
                    ) values (
                        materialization_id, job.id, job.source_report_id,
                        participant_code, job.case_number, next_position,
                        case when identifier_index is not null
                            then private.stage1_clean_markdown(cells[identifier_index])
                            else 'TH' || next_position::text end,
                        extracted_label,
                        case when references_text is null then '{}'::text[] else
                            pg_catalog.regexp_split_to_array(
                                pg_catalog.regexp_replace(references_text, '\s+', '', 'g'), ','
                            ) end,
                        pg_catalog.jsonb_build_object('markdown_row', line_text, 'headers', headers),
                        'markdown:line:' || line_record.ordinality::text
                    );
                end if;
            end loop;
        else
            raw_format := 'incomplete_or_unsupported';
            parse_failed := true;
            parse_reason := 'The preserved response is neither complete JSON, fenced JSON, nor supported structured Markdown.';
        end if;

        if not parse_failed and (
            not exists (select 1 from public.stage1_preliminary_meaning_units where materialization_run_id = materialization_id and source_job_id = job.id)
            or not exists (select 1 from public.stage1_preliminary_codes where materialization_run_id = materialization_id and source_job_id = job.id)
            or not exists (select 1 from public.stage1_preliminary_categories where materialization_run_id = materialization_id and source_job_id = job.id)
            or not exists (select 1 from public.stage1_preliminary_implied_themes where materialization_run_id = materialization_id and source_job_id = job.id)
        ) then
            parse_failed := true;
            parse_reason := 'One or more required analytical forms could not be extracted completely from the preserved response.';
        end if;

        if parse_failed then
            delete from public.stage1_preliminary_meaning_units
            where materialization_run_id = materialization_id and source_job_id = job.id;
            delete from public.stage1_preliminary_codes
            where materialization_run_id = materialization_id and source_job_id = job.id;
            delete from public.stage1_preliminary_categories
            where materialization_run_id = materialization_id and source_job_id = job.id;
            delete from public.stage1_preliminary_implied_themes
            where materialization_run_id = materialization_id and source_job_id = job.id;
            insert into public.stage1_preliminary_materialization_exceptions (
                materialization_run_id, source_job_id, participant_code,
                case_number, raw_format, reason, materialized_components
            ) values (
                materialization_id, job.id, participant_code,
                job.case_number, coalesce(raw_format, 'unknown'),
                coalesce(parse_reason, 'Deterministic extraction failed.'),
                pg_catalog.jsonb_build_object('participant_form', true,
                    'meaning_units', false, 'codes', false,
                    'categories', false, 'implied_themes', false)
            );
        end if;
    end loop;

    update public.stage1_preliminary_materialization_runs run
    set status = 'completed',
        participant_form_case_count = (
            select count(*) from public.stage1_preliminary_case_forms
            where materialization_run_id = materialization_id
        ),
        meaning_unit_form_case_count = (
            select count(distinct source_job_id) from public.stage1_preliminary_meaning_units
            where materialization_run_id = materialization_id
        ),
        code_form_case_count = (
            select count(distinct source_job_id) from public.stage1_preliminary_codes
            where materialization_run_id = materialization_id
        ),
        category_form_case_count = (
            select count(distinct source_job_id) from public.stage1_preliminary_categories
            where materialization_run_id = materialization_id
        ),
        implied_theme_form_case_count = (
            select count(distinct source_job_id) from public.stage1_preliminary_implied_themes
            where materialization_run_id = materialization_id
        ),
        exception_case_count = (
            select count(*) from public.stage1_preliminary_materialization_exceptions
            where materialization_run_id = materialization_id
        ),
        new_ai_api_call_count = 0,
        completed_at = now(),
        last_error = null
    where run.id = materialization_id;

    return materialization_id;
exception when others then
    if materialization_id is not null then
        update public.stage1_preliminary_materialization_runs
        set status = 'failed', last_error = sqlerrm
        where id = materialization_id;
    end if;
    raise;
end;
$$;

revoke all on function private.stage1_try_parse_json(text) from public;
revoke all on function private.stage1_json_text_array(jsonb) from public;
revoke all on function private.stage1_clean_markdown(text) from public;
revoke all on function private.stage1_clean_heading_label(text, text) from public;
revoke all on function private.materialize_stage1_preliminary_forms(uuid) from public;
grant execute on function private.stage1_try_parse_json(text) to service_role;
grant execute on function private.stage1_json_text_array(jsonb) to service_role;
grant execute on function private.stage1_clean_markdown(text) to service_role;
grant execute on function private.stage1_clean_heading_label(text, text) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms(uuid) to service_role;

create view public.stage1_preliminary_form_1_participant_information
with (security_invoker = true)
as
select participant_code as "P#", session_sequence as "S#", language,
    current_country, current_region, country_of_origin, diaspora_status,
    gender, age, birth_year, birth_cohort, youth_status,
    education_level, social_identity, additional_descriptors,
    source_run_id, source_job_id, source_report_id, session_id, participant_id
from public.stage1_preliminary_case_forms;

create view public.stage1_preliminary_form_2_meaning_units
with (security_invoker = true)
as
select materialization_run_id, participant_code as "P#", case_number,
    pg_catalog.jsonb_object_agg('MU' || position::text, exact_text order by position)
        as meaning_units
from public.stage1_preliminary_meaning_units
group by materialization_run_id, participant_code, case_number;

create view public.stage1_preliminary_form_3_codes
with (security_invoker = true)
as
select materialization_run_id, participant_code as "P#", case_number,
    pg_catalog.jsonb_object_agg('CO' || position::text, code_label order by position)
        as preliminary_codes
from public.stage1_preliminary_codes
group by materialization_run_id, participant_code, case_number;

create view public.stage1_preliminary_form_4_categories
with (security_invoker = true)
as
select materialization_run_id, participant_code as "P#", case_number,
    pg_catalog.jsonb_object_agg('CA' || position::text, category_label order by position)
        as preliminary_categories
from public.stage1_preliminary_categories
group by materialization_run_id, participant_code, case_number;

create view public.stage1_preliminary_form_5_implied_themes
with (security_invoker = true)
as
select materialization_run_id, participant_code as "P#", case_number,
    pg_catalog.jsonb_object_agg('TH' || position::text, theme_label order by position)
        as preliminary_implied_themes
from public.stage1_preliminary_implied_themes
group by materialization_run_id, participant_code, case_number;

revoke all on table public.stage1_preliminary_form_1_participant_information from anon, authenticated;
revoke all on table public.stage1_preliminary_form_2_meaning_units from anon, authenticated;
revoke all on table public.stage1_preliminary_form_3_codes from anon, authenticated;
revoke all on table public.stage1_preliminary_form_4_categories from anon, authenticated;
revoke all on table public.stage1_preliminary_form_5_implied_themes from anon, authenticated;
grant select on table public.stage1_preliminary_form_1_participant_information to service_role;
grant select on table public.stage1_preliminary_form_2_meaning_units to service_role;
grant select on table public.stage1_preliminary_form_3_codes to service_role;
grant select on table public.stage1_preliminary_form_4_categories to service_role;
grant select on table public.stage1_preliminary_form_5_implied_themes to service_role;
