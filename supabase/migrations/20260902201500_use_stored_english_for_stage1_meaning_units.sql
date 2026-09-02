alter table public.stage1_preliminary_meaning_units
add column english_text text,
add column english_text_source text,
add column english_source_message_id uuid
    references public.interview_messages(id) on delete restrict;

create index stage1_preliminary_mu_english_message_idx
on public.stage1_preliminary_meaning_units(english_source_message_id)
where english_source_message_id is not null;

comment on column public.stage1_preliminary_meaning_units.exact_text is
    'Original Stage 1 Meaning Unit text retained unchanged for provenance.';
comment on column public.stage1_preliminary_meaning_units.english_text is
    'Researcher-facing English text taken only from the preserved Stage 1 response or the stored English translation of its linked transcript message.';
comment on column public.stage1_preliminary_meaning_units.english_text_source is
    'Deterministic provenance for english_text; no translation or analysis model is called during materialization.';

create or replace function private.stage1_inline_english_translation(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
    parts text[];
    matched text[];
    result text;
begin
    if nullif(pg_catalog.btrim(p_value), '') is null then
        return null;
    end if;

    if p_value ~ '\s+/\s+' then
        parts := pg_catalog.regexp_split_to_array(p_value, '\s+/\s+');
        if pg_catalog.array_length(parts, 1) >= 2 then
            result := parts[pg_catalog.array_length(parts, 1)];
        end if;
    end if;

    if result is null then
        matched := pg_catalog.regexp_match(
            p_value,
            '[（(]\s*[“"]?([A-Za-z][^）)]*)[”"]?\s*[）)]\s*$'
        );
        if matched is not null then
            result := matched[1];
        end if;
    end if;

    if result is null then
        return null;
    end if;

    result := pg_catalog.regexp_replace(result, '^\s*[“"]|[”"]\s*$', '', 'g');
    return nullif(pg_catalog.btrim(result), '');
end;
$$;

create or replace function private.stage1_markdown_english_meaning_unit(
    p_source_object jsonb
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
    header_text text;
    chosen_index integer;
    chosen_priority integer := 999;
    current_priority integer;
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
        if header_text like '%english translation%'
            or header_text = 'translation'
        then
            current_priority := 1;
        elsif header_text like '%preliminary interpretation%'
            or header_text like '%interpreted meaning unit%'
            or header_text = 'interpreted meaning'
        then
            current_priority := 2;
        elsif header_text like '%condensed meaning unit%'
            or header_text = 'condensed meaning'
            or header_text like '%condensed participant%'
            or header_text like '%meaning unit / condensed account%'
        then
            current_priority := 3;
        end if;

        if current_priority < chosen_priority then
            chosen_priority := current_priority;
            chosen_index := item.position;
        end if;
    end loop;

    if chosen_index is null then
        return null;
    end if;

    result := private.stage1_clean_markdown(cells[chosen_index]);
    result := pg_catalog.regexp_replace(
        result,
        '^\s*(MU\s*)?[0-9]+(?:\s*\([^)]*\))?\s*[.:\-]\s*',
        '',
        'i'
    );
    return nullif(pg_catalog.btrim(result), '');
end;
$$;

create or replace function private.stage1_markdown_source_reference(
    p_source_object jsonb
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
    header_text text;
    chosen_index integer;
    chosen_priority integer := 999;
    current_priority integer;
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
        if header_text like '%source message id%'
            or header_text = 'message id'
        then
            current_priority := 1;
        elsif header_text like '%transcript location%'
            or header_text = 'source'
        then
            current_priority := 2;
        end if;

        if current_priority < chosen_priority then
            chosen_priority := current_priority;
            chosen_index := item.position;
        end if;
    end loop;

    if chosen_index is null then
        return null;
    end if;

    result := lower(private.stage1_clean_markdown(cells[chosen_index]));
    if result ~ '^[0-9a-f]{8}$'
        or result ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
        return result;
    end if;
    return null;
end;
$$;

create or replace function private.populate_stage1_english_meaning_units(
    p_materialization_run_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    affected_rows integer;
begin
    with unit_context as (
        select
            unit.id,
            unit.exact_text,
            unit.source_message_id,
            form.session_id,
            form.language,
            private.stage1_inline_english_translation(unit.exact_text)
                as inline_translation,
            private.stage1_markdown_english_meaning_unit(unit.source_object)
                as markdown_english_text,
            private.stage1_markdown_source_reference(unit.source_object)
                as markdown_source_reference,
            lower(pg_catalog.btrim(pg_catalog.regexp_replace(
                unit.exact_text,
                '^[\s“"]+|[\s”"]+$',
                '',
                'g'
            ))) as normalized_exact_text
        from public.stage1_preliminary_meaning_units as unit
        join public.stage1_preliminary_case_forms as form
          on form.materialization_run_id = unit.materialization_run_id
         and form.source_job_id = unit.source_job_id
        where unit.materialization_run_id = p_materialization_run_id
    ), resolved as (
        select
            context.*,
            message.id as resolved_message_id,
            nullif(pg_catalog.btrim(message."EnglishTranslation"), '')
                as stored_message_translation
        from unit_context as context
        left join lateral (
            select candidate.id, candidate."EnglishTranslation"
            from public.interview_messages as candidate
            where candidate."Session" = context.session_id
              and lower(candidate."Speaker") in ('participant', 'user')
              and nullif(pg_catalog.btrim(candidate."EnglishTranslation"), '') is not null
              and (
                    candidate.id::text = context.source_message_id
                 or (
                        context.source_message_id ~ '^[0-9a-f]{8}$'
                    and candidate.id::text like context.source_message_id || '%'
                 )
                 or candidate.id::text = context.markdown_source_reference
                 or (
                        context.markdown_source_reference ~ '^[0-9a-f]{8}$'
                    and candidate.id::text like context.markdown_source_reference || '%'
                 )
                 or (
                        pg_catalog.length(context.normalized_exact_text) >= 8
                    and pg_catalog.strpos(
                        lower(candidate."Message"),
                        context.normalized_exact_text
                    ) > 0
                 )
              )
            order by
                case
                    when candidate.id::text = context.source_message_id then 1
                    when context.source_message_id ~ '^[0-9a-f]{8}$'
                     and candidate.id::text like context.source_message_id || '%' then 2
                    when candidate.id::text = context.markdown_source_reference then 3
                    when context.markdown_source_reference ~ '^[0-9a-f]{8}$'
                     and candidate.id::text like context.markdown_source_reference || '%' then 4
                    else 5
                end,
                candidate.id
            limit 1
        ) as message on true
    )
    update public.stage1_preliminary_meaning_units as unit
    set english_text = coalesce(
            resolved.inline_translation,
            resolved.markdown_english_text,
            resolved.stored_message_translation,
            resolved.exact_text
        ),
        english_text_source = case
            when resolved.inline_translation is not null
                then 'stage1_inline_translation'
            when resolved.markdown_english_text is not null
                then 'stage1_english_meaning_unit'
            when resolved.stored_message_translation is not null
                then 'stored_message_translation'
            when coalesce(resolved.language, 'en') = 'en'
                then 'stage1_english_text'
            else 'stage1_text_without_separate_translation'
        end,
        english_source_message_id = resolved.resolved_message_id
    from resolved
    where unit.id = resolved.id;

    get diagnostics affected_rows = row_count;
    return affected_rows;
end;
$$;

alter function private.materialize_stage1_preliminary_forms(uuid)
rename to materialize_stage1_preliminary_forms_without_english_text;

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
    materialization_id := private.materialize_stage1_preliminary_forms_without_english_text(
        p_source_run_id
    );
    perform private.populate_stage1_english_meaning_units(materialization_id);
    return materialization_id;
end;
$$;

do $$
declare
    existing_run record;
begin
    for existing_run in
        select id from public.stage1_preliminary_materialization_runs
    loop
        perform private.populate_stage1_english_meaning_units(existing_run.id);
    end loop;
end;
$$;

create or replace view public.stage1_preliminary_form_2_meaning_units
with (security_invoker = true)
as
select materialization_run_id, participant_code as "P#", case_number,
    pg_catalog.jsonb_object_agg(
        'MU' || position::text,
        coalesce(english_text, exact_text)
        order by position
    ) as meaning_units
from public.stage1_preliminary_meaning_units
group by materialization_run_id, participant_code, case_number;

revoke all on function private.stage1_inline_english_translation(text) from public;
revoke all on function private.stage1_markdown_english_meaning_unit(jsonb) from public;
revoke all on function private.stage1_markdown_source_reference(jsonb) from public;
revoke all on function private.populate_stage1_english_meaning_units(uuid) from public;
revoke all on function private.materialize_stage1_preliminary_forms_without_english_text(uuid) from public;
revoke all on function private.materialize_stage1_preliminary_forms(uuid) from public;
grant execute on function private.stage1_inline_english_translation(text) to service_role;
grant execute on function private.stage1_markdown_english_meaning_unit(jsonb) to service_role;
grant execute on function private.stage1_markdown_source_reference(jsonb) to service_role;
grant execute on function private.populate_stage1_english_meaning_units(uuid) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms_without_english_text(uuid) to service_role;
grant execute on function private.materialize_stage1_preliminary_forms(uuid) to service_role;
revoke all on table public.stage1_preliminary_form_2_meaning_units from anon, authenticated;
grant select on table public.stage1_preliminary_form_2_meaning_units to service_role;
