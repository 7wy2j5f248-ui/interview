alter function private.materialize_stage1_preliminary_forms(uuid)
rename to materialize_stage1_preliminary_forms_without_table_label_corrections;

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
        current_priority := 999;
        if p_kind = 'meaning_unit' then
            if header_text like '%exact_source_text%' then current_priority := 1;
            elsif header_text like '%transcript segment%' then current_priority := 2;
            elsif header_text like '%meaning unit grounded%' then current_priority := 3;
            elsif header_text like '%condensed meaning unit%' then current_priority := 4;
            elsif header_text = 'meaning unit' then current_priority := 5;
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
begin
    materialization_id := private.materialize_stage1_preliminary_forms_without_table_label_corrections(
        p_source_run_id
    );

    update public.stage1_preliminary_meaning_units as unit
    set exact_text = private.stage1_markdown_table_label(
        unit.source_object, 'meaning_unit'
    )
    where unit.materialization_run_id = materialization_id
      and unit.source_object ? 'headers'
      and private.stage1_markdown_table_label(
          unit.source_object, 'meaning_unit'
      ) is not null;

    update public.stage1_preliminary_codes as code
    set code_label = private.stage1_markdown_table_label(
        code.source_object, 'code'
    )
    where code.materialization_run_id = materialization_id
      and code.source_object ? 'headers'
      and private.stage1_markdown_table_label(
          code.source_object, 'code'
      ) is not null;

    update public.stage1_preliminary_categories as category
    set category_label = private.stage1_markdown_table_label(
        category.source_object, 'category'
    )
    where category.materialization_run_id = materialization_id
      and category.source_object ? 'headers'
      and private.stage1_markdown_table_label(
          category.source_object, 'category'
      ) is not null;

    update public.stage1_preliminary_implied_themes as theme
    set theme_label = private.stage1_markdown_table_label(
        theme.source_object, 'theme'
    )
    where theme.materialization_run_id = materialization_id
      and theme.source_object ? 'headers'
      and private.stage1_markdown_table_label(
          theme.source_object, 'theme'
      ) is not null;

    return materialization_id;
end;
$$;

revoke all on function private.stage1_markdown_table_label(jsonb, text) from public;
revoke all on function private.materialize_stage1_preliminary_forms_without_table_label_corrections(uuid) from public;
revoke all on function private.materialize_stage1_preliminary_forms(uuid) from public;
grant execute on function private.stage1_markdown_table_label(jsonb, text) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms_without_table_label_corrections(uuid) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms(uuid) to service_role;
