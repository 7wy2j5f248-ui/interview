create or replace function private.stage1_markdown_table_label(
    p_source_object jsonb,
    p_kind text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
    headers jsonb := p_source_object -> 'headers';
    row_text text := p_source_object ->> 'markdown_row';
    cells text[];
    item record;
    chosen_index integer;
    chosen_priority integer := 999;
    current_priority integer;
    header_text text;
    cell_text text;
    result text;
begin
    if pg_catalog.jsonb_typeof(headers) <> 'array' or row_text is null then
        return null;
    end if;
    cells := pg_catalog.regexp_split_to_array(
        pg_catalog.btrim(row_text, '|'), '\s*\|\s*'
    );
    if pg_catalog.array_length(cells, 1) <> pg_catalog.jsonb_array_length(headers) then
        return null;
    end if;

    for item in
        select value #>> '{}' as header, ordinality::integer as position
        from pg_catalog.jsonb_array_elements(headers) with ordinality
    loop
        header_text := lower(pg_catalog.btrim(item.header));
        cell_text := private.stage1_clean_markdown(cells[item.position]);
        current_priority := 999;
        if p_kind = 'meaning_unit' then
            if header_text like '%exact_source_text%' then current_priority := 1;
            elsif header_text like '%participant statement%'
                or header_text like '%participant data%'
                or header_text like '%transcript segment%'
                or header_text like '%transcript evidence%'
                or header_text like '%transcript grounding%'
                or header_text like '%transcript-grounded content%'
                or header_text like '%meaning unit from transcript%'
                or header_text like '%meaning unit from the transcript%'
                or header_text like '%meaning unit from the interview%'
                or header_text like '%meaning unit from the participant%'
                or header_text like '%transcript-based meaning unit%'
                or header_text like '%transcript-grounded meaning unit%'
                or header_text like '%meaning unit grounded%'
                or header_text like '%meaning unit / evidence%'
                or header_text like '%meaning unit / illustrative extract%'
            then current_priority := 2;
            elsif header_text = 'source' then current_priority := 3;
            elsif header_text like '%condensed meaning unit%'
                or header_text like '%condensed participant%'
                or header_text like '%meaning unit / condensed account%'
                or header_text like '%interpreted meaning unit%'
            then current_priority := 4;
            elsif header_text = 'meaning unit'
                and cell_text !~* '^MU\s*[0-9]+$'
            then current_priority := 5;
            end if;
        elsif p_kind = 'code' then
            if header_text = 'label' then current_priority := 1;
            elsif header_text like '%preliminary code%' then current_priority := 2;
            elsif header_text = 'code' then current_priority := 3;
            end if;
        elsif p_kind = 'category' then
            if header_text = 'label' then current_priority := 1;
            elsif header_text like '%preliminary category%' then current_priority := 2;
            elsif header_text = 'category' then current_priority := 3;
            end if;
        elsif p_kind = 'theme' then
            if header_text = 'label' then current_priority := 1;
            elsif header_text like '%tentative theme%' then current_priority := 2;
            elsif header_text = 'theme' then current_priority := 3;
            end if;
        end if;
        if current_priority < chosen_priority then
            chosen_priority := current_priority;
            chosen_index := item.position;
        end if;
    end loop;

    if chosen_index is null then return null; end if;
    result := private.stage1_clean_markdown(cells[chosen_index]);
    if p_kind = 'meaning_unit' then
        result := pg_catalog.regexp_replace(
            result,
            '^\s*(MU\s*)?[0-9]+(?:\s*\([^)]*\))?\s*[.:\-]\s*',
            '', 'i'
        );
    end if;
    return result;
end;
$$;

revoke all on function private.stage1_markdown_table_label(jsonb, text) from public;
grant execute on function private.stage1_markdown_table_label(jsonb, text) to service_role;
