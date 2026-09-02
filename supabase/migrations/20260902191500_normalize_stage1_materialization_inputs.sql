create or replace function private.stage1_try_parse_json(p_raw text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
    candidate text;
    document jsonb;
    meaning_units jsonb;
    preliminary_codes jsonb;
    preliminary_categories jsonb;
    preliminary_themes jsonb;
begin
    if p_raw is null then return null; end if;

    if pg_catalog.pg_input_is_valid(p_raw, 'jsonb') then
        document := p_raw::jsonb;
    elsif p_raw ~ '^\s*```json' then
        candidate := pg_catalog.regexp_replace(p_raw, '^\s*```json\s*', '', 'i');
        candidate := pg_catalog.regexp_replace(candidate, '\s*```\s*$', '');
        if pg_catalog.pg_input_is_valid(candidate, 'jsonb') then
            document := candidate::jsonb;
        end if;
    end if;

    if document is not null then
        if pg_catalog.jsonb_typeof(document -> 'meaning_units') is distinct from 'array'
            and pg_catalog.jsonb_typeof(document -> 'case_report') = 'object'
            and pg_catalog.jsonb_typeof(document -> 'case_report' -> 'meaning_units') = 'array'
        then
            document := document || (document -> 'case_report');
        elsif pg_catalog.jsonb_typeof(document -> 'meaning_units') is distinct from 'array'
            and pg_catalog.jsonb_typeof(document -> 'analysis_record') = 'object'
            and pg_catalog.jsonb_typeof(document -> 'analysis_record' -> 'meaning_units') = 'array'
        then
            document := document || (document -> 'analysis_record');
        end if;
        return document;
    end if;

    if p_raw ~ '(?m)^\s*[0-9]+\.\s+\*\*exact_source_text:\*\*\s+`' then
        select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'meaning_unit_number', match[1],
                'exact_source_text', match[2]
            ) order by match[1]::integer
        ) into meaning_units
        from pg_catalog.regexp_matches(
            p_raw,
            '(?m)^\s*([0-9]+)\.\s+\*\*exact_source_text:\*\*\s+`([^`]*)`',
            'g'
        ) as match;

        select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'code_number', private.stage1_clean_markdown(match[1]),
                'code', private.stage1_clean_markdown(match[2]),
                'definition', private.stage1_clean_markdown(match[3]),
                'meaning_unit_numbers', to_jsonb(pg_catalog.regexp_split_to_array(
                    pg_catalog.regexp_replace(match[4], '\s+', '', 'g'), ','
                )),
                'rationale', private.stage1_clean_markdown(match[5])
            ) order by (pg_catalog.regexp_match(match[1], '[0-9]+'))[1]::integer
        ) into preliminary_codes
        from pg_catalog.regexp_matches(
            p_raw,
            '(?m)^\|\s*(CO[0-9]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$',
            'g'
        ) as match;

        select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'category_number', private.stage1_clean_markdown(match[1]),
                'category', private.stage1_clean_markdown(match[2]),
                'definition', private.stage1_clean_markdown(match[3]),
                'code_numbers', to_jsonb(pg_catalog.regexp_split_to_array(
                    pg_catalog.regexp_replace(match[4], '\s+', '', 'g'), ','
                )),
                'rationale', private.stage1_clean_markdown(match[5])
            ) order by (pg_catalog.regexp_match(match[1], '[0-9]+'))[1]::integer
        ) into preliminary_categories
        from pg_catalog.regexp_matches(
            p_raw,
            '(?m)^\|\s*(CA[0-9]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$',
            'g'
        ) as match;

        select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'theme_number', private.stage1_clean_markdown(match[1]),
                'tentative_theme', private.stage1_clean_markdown(match[2]),
                'definition', private.stage1_clean_markdown(match[3]),
                'category_numbers', to_jsonb(pg_catalog.regexp_split_to_array(
                    pg_catalog.regexp_replace(match[4], '\s+', '', 'g'), ','
                )),
                'rationale', private.stage1_clean_markdown(match[5])
            ) order by (pg_catalog.regexp_match(match[1], '[0-9]+'))[1]::integer
        ) into preliminary_themes
        from pg_catalog.regexp_matches(
            p_raw,
            '(?m)^\|\s*(TH[0-9]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$',
            'g'
        ) as match;

        if pg_catalog.jsonb_typeof(meaning_units) = 'array'
            and pg_catalog.jsonb_typeof(preliminary_codes) = 'array'
            and pg_catalog.jsonb_typeof(preliminary_categories) = 'array'
            and pg_catalog.jsonb_typeof(preliminary_themes) = 'array'
        then
            return pg_catalog.jsonb_build_object(
                'meaning_units', meaning_units,
                'preliminary_codes', preliminary_codes,
                'preliminary_categories', preliminary_categories,
                'preliminary_tentative_themes', preliminary_themes
            );
        end if;
    end if;

    return null;
end;
$$;

revoke all on function private.stage1_try_parse_json(text) from public;
grant execute on function private.stage1_try_parse_json(text) to service_role;
