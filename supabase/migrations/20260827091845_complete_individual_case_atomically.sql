create or replace function public.complete_ai_analysis_case(
    p_analysis_run_id uuid,
    p_batch_id uuid,
    p_items jsonb,
    p_input_token_count integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    case_batch public.qualitative_analysis_batches%rowtype;
    item_entry jsonb;
    stored_item_id uuid;
    stored_item_count integer := 0;
begin
    select *
    into case_batch
    from public.qualitative_analysis_batches
    where id = p_batch_id
      and analysis_run_id = p_analysis_run_id
    for update;

    if not found then
        raise exception 'The individual case does not belong to the analysis run.';
    end if;

    if case_batch.input_token_count is not null then
        raise exception 'The individual case report is already complete.';
    end if;

    if case_batch.session_count <> 1
       or case_batch.grouping_criteria ->> 'strategy'
            <> 'individual_case_report'
       or coalesce(
            (case_batch.grouping_criteria ->> 'oneSessionPerUnit')::boolean,
            false
       ) is not true then
        raise exception 'A case report must contain exactly one transcript session.';
    end if;

    if jsonb_typeof(p_items) <> 'array'
       or jsonb_array_length(p_items) = 0 then
        raise exception 'A complete individual case report requires analytical items.';
    end if;

    if exists (
        select 1
        from public.qualitative_analysis_item_batches
        where batch_id = p_batch_id
    ) then
        raise exception 'Partial analytical items already exist for this individual case.';
    end if;

    for item_entry in
        select value from jsonb_array_elements(p_items)
    loop
        select public.create_ai_analysis_item_with_batch(
            p_analysis_run_id => p_analysis_run_id,
            p_batch_id => p_batch_id,
            p_theme => item_entry ->> 'theme',
            p_codes => array(
                select jsonb_array_elements_text(
                    coalesce(item_entry -> 'codes', '[]'::jsonb)
                )
            ),
            p_coded_phrases => array(
                select jsonb_array_elements_text(
                    coalesce(item_entry -> 'coded_phrases', '[]'::jsonb)
                )
            ),
            p_keywords => array(
                select jsonb_array_elements_text(
                    coalesce(item_entry -> 'keywords', '[]'::jsonb)
                )
            ),
            p_rationale => item_entry ->> 'rationale',
            p_evidence => coalesce(
                item_entry -> 'evidence',
                '[]'::jsonb
            ),
            p_suggestion_sources => coalesce(
                item_entry -> 'suggestion_sources',
                '[]'::jsonb
            )
        ) into stored_item_id;

        if stored_item_id is null then
            raise exception 'An analytical item could not be stored.';
        end if;

        stored_item_count := stored_item_count + 1;
    end loop;

    update public.qualitative_analysis_batches
    set input_token_count = greatest(coalesce(p_input_token_count, 1), 1)
    where id = p_batch_id
      and analysis_run_id = p_analysis_run_id
      and input_token_count is null;

    if not found then
        raise exception 'Individual case completion could not be recorded.';
    end if;

    return stored_item_count;
end;
$$;

comment on function public.complete_ai_analysis_case(
    uuid,
    uuid,
    jsonb,
    integer
) is
    'Atomically stores one complete transcript-scoped case report and only then marks that case complete.';

revoke all on function public.complete_ai_analysis_case(
    uuid,
    uuid,
    jsonb,
    integer
) from public, anon, authenticated;

grant execute on function public.complete_ai_analysis_case(
    uuid,
    uuid,
    jsonb,
    integer
) to service_role;
