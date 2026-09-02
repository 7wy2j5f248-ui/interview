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
            case
                when coalesce(form.language, 'en') <> 'en'
                then private.stage1_inline_english_translation(unit.exact_text)
            end as inline_translation,
            private.stage1_markdown_english_meaning_unit(unit.source_object)
                as markdown_english_text,
            private.stage1_markdown_source_reference(unit.source_object)
                as markdown_source_reference,
            unit.exact_text ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                or unit.exact_text ~* '^[0-9a-f]{8}$'
                as exact_is_source_reference,
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
    set english_text = case
            when coalesce(resolved.language, 'en') = 'en'
                then resolved.exact_text
            else coalesce(
                resolved.inline_translation,
                case when resolved.exact_is_source_reference
                    then resolved.markdown_english_text end,
                resolved.stored_message_translation,
                resolved.markdown_english_text,
                resolved.exact_text
            )
        end,
        english_text_source = case
            when coalesce(resolved.language, 'en') = 'en'
                then 'stage1_english_text'
            when resolved.inline_translation is not null
                then 'stage1_inline_translation'
            when resolved.exact_is_source_reference
             and resolved.markdown_english_text is not null
                then 'stage1_english_meaning_unit'
            when resolved.stored_message_translation is not null
                then 'stored_message_translation'
            when resolved.markdown_english_text is not null
                then 'stage1_english_meaning_unit'
            else 'stage1_text_without_separate_translation'
        end,
        english_source_message_id = resolved.resolved_message_id
    from resolved
    where unit.id = resolved.id;

    get diagnostics affected_rows = row_count;
    return affected_rows;
end;
$$;

revoke all on function private.populate_stage1_english_meaning_units(uuid) from public;
grant execute on function private.populate_stage1_english_meaning_units(uuid) to service_role;
