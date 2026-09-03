alter table public.stage2a_code_harmonization_runs
    add column if not exists materialization_run_id uuid
        references public.stage1_preliminary_materialization_runs(id)
        on delete restrict,
    add column if not exists checkpoint_hash text;

alter table public.stage2a_preliminary_code_mappings
    drop constraint if exists
        stage2a_preliminary_code_mappings_preliminary_code_id_fkey;

alter table public.stage2a_preliminary_code_mappings
    add constraint stage2a_preliminary_code_mappings_preliminary_code_id_fkey
    foreign key (preliminary_code_id)
    references public.stage1_preliminary_codes(id)
    on delete restrict;

create or replace function public.get_stage2a_harmonization_corpus(
    p_stage1_run_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
    with selected_materialization as (
        select run.id
        from public.stage1_preliminary_materialization_runs as run
        where run.source_run_id = p_stage1_run_id
          and run.status = 'completed'
        order by run.completed_at desc nulls last, run.started_at desc
        limit 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'p', form.case_number,
        'co', coalesce((
            select jsonb_agg(code.code_label order by code.position)
            from public.stage1_preliminary_codes as code
            where code.materialization_run_id = form.materialization_run_id
              and code.source_job_id = form.source_job_id
        ), '[]'::jsonb)
    ) order by form.case_number), '[]'::jsonb)
    from public.stage1_preliminary_case_forms as form
    where form.materialization_run_id = (
        select selected_materialization.id from selected_materialization
    );
$function$;

create or replace function public.complete_stage2a_code_harmonization(
    p_run_id uuid,
    p_output jsonb,
    p_raw_output text,
    p_input_tokens integer,
    p_output_tokens integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    selected_run public.stage2a_code_harmonization_runs%rowtype;
    hco_item jsonb;
    hco_ordinal bigint;
    mapped_count integer;
begin
    select run.* into selected_run
    from public.stage2a_code_harmonization_runs as run
    where run.id = p_run_id;

    if selected_run.id is null
       or selected_run.materialization_run_id is null then
        return false;
    end if;

    if jsonb_typeof(p_output -> 'harmonized_codes') <> 'array'
       or jsonb_typeof(p_output -> 'cases') <> 'array'
       or jsonb_array_length(p_output -> 'harmonized_codes') = 0 then
        raise exception 'Stage 2A output is missing its HCO vocabulary or case mappings.';
    end if;

    if (select count(*) from jsonb_array_elements(p_output -> 'harmonized_codes'))
       <> (select count(distinct item ->> 'id')
           from jsonb_array_elements(p_output -> 'harmonized_codes') as item) then
        raise exception 'Stage 2A returned duplicate HCO identifiers.';
    end if;

    if jsonb_array_length(p_output -> 'cases') <> selected_run.source_case_count
       or (select count(distinct item ->> 'p')
           from jsonb_array_elements(p_output -> 'cases') as item)
          <> selected_run.source_case_count then
        raise exception 'Stage 2A did not return every represented P# exactly once.';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(
            selected_run.pre_call_snapshot -> 'modelInput'
        ) as supplied(value)
        left join jsonb_array_elements(p_output -> 'cases') as returned(value)
          on returned.value ->> 'p' = supplied.value ->> 'p'
        where returned.value is null
           or jsonb_typeof(returned.value -> 'hco_ids') <> 'array'
           or jsonb_array_length(returned.value -> 'hco_ids')
              <> jsonb_array_length(supplied.value -> 'co')
    ) then
        raise exception 'Stage 2A case mappings do not align with the persisted P# and CO input.';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_output -> 'cases') as returned(value)
        where not exists (
            select 1
            from jsonb_array_elements(
                selected_run.pre_call_snapshot -> 'modelInput'
            ) as supplied(value)
            where supplied.value ->> 'p' = returned.value ->> 'p'
        )
    ) then
        raise exception 'Stage 2A returned a P# that was not supplied.';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_output -> 'cases') as returned(value)
        cross join lateral jsonb_array_elements_text(
            returned.value -> 'hco_ids'
        ) as mapped(hco_id)
        where not exists (
            select 1
            from jsonb_array_elements(p_output -> 'harmonized_codes') as hco(value)
            where hco.value ->> 'id' = mapped.hco_id
        )
    ) then
        raise exception 'Stage 2A returned an unknown HCO identifier.';
    end if;

    delete from public.stage2a_preliminary_code_mappings as mapping
    where mapping.run_id = p_run_id;
    delete from public.stage2a_harmonized_codes as code
    where code.run_id = p_run_id;

    for hco_item, hco_ordinal in
        select item.value, item.ordinality
        from jsonb_array_elements(
            p_output -> 'harmonized_codes'
        ) with ordinality as item(value, ordinality)
    loop
        insert into public.stage2a_harmonized_codes (
            run_id, hco_number, harmonized_code_label, definition,
            semantic_basis, model_payload
        ) values (
            p_run_id,
            hco_ordinal::integer,
            nullif(btrim(hco_item ->> 'label'), ''),
            nullif(btrim(hco_item ->> 'definition'), ''),
            nullif(btrim(hco_item ->> 'semantic_basis'), ''),
            hco_item
        );
    end loop;

    insert into public.stage2a_preliminary_code_mappings (
        run_id, harmonized_code_id, preliminary_code_id
    )
    select p_run_id, stored_hco.id, preliminary.id
    from jsonb_array_elements(p_output -> 'cases') as returned(value)
    cross join lateral jsonb_array_elements_text(
        returned.value -> 'hco_ids'
    ) with ordinality as mapped(hco_id, code_ordinal)
    join public.stage1_preliminary_codes as preliminary
      on preliminary.materialization_run_id = selected_run.materialization_run_id
     and preliminary.case_number = returned.value ->> 'p'
     and preliminary.position = mapped.code_ordinal::integer
    join public.stage2a_harmonized_codes as stored_hco
      on stored_hco.run_id = p_run_id
     and stored_hco.model_payload ->> 'id' = mapped.hco_id;

    select count(*)::integer into mapped_count
    from public.stage2a_preliminary_code_mappings as mapping
    where mapping.run_id = p_run_id;
    if mapped_count <> selected_run.preliminary_code_count then
        raise exception 'Stage 2A did not map every preliminary CO exactly once.';
    end if;

    update public.stage2a_code_harmonization_runs
    set status = 'completed',
        parsed_model_output = p_output,
        raw_model_output_text = p_raw_output,
        input_token_count = p_input_tokens,
        output_token_count = p_output_tokens,
        completed_at = now(),
        updated_at = now(),
        last_error = null
    where id = p_run_id;

    return found;
end;
$function$;

create or replace function public.get_stage2a_harmonized_code_form(
    p_run_id uuid
)
returns table (
    case_number text,
    harmonized_codes jsonb
)
language sql
security invoker
set search_path = ''
as $function$
    select form.case_number,
           coalesce((
               select jsonb_agg(jsonb_build_object(
                   'harmonized_code_id', case_hco.harmonized_code_id,
                   'stable_hco_identifier', case_hco.stable_hco_identifier,
                   'label', case_hco.harmonized_code_label
               ) order by case_hco.first_code_position,
                          case_hco.harmonized_code_id)
               from (
                   select hco.id as harmonized_code_id,
                          hco.model_payload ->> 'id' as stable_hco_identifier,
                          hco.harmonized_code_label,
                          min(preliminary.position) as first_code_position
                   from public.stage2a_preliminary_code_mappings as mapping
                   join public.stage2a_harmonized_codes as hco
                     on hco.id = mapping.harmonized_code_id
                   join public.stage1_preliminary_codes as preliminary
                     on preliminary.id = mapping.preliminary_code_id
                   where mapping.run_id = p_run_id
                     and preliminary.source_job_id = form.source_job_id
                   group by hco.id, hco.model_payload ->> 'id',
                            hco.harmonized_code_label
               ) as case_hco
           ), '[]'::jsonb)
    from public.stage1_preliminary_case_forms as form
    join public.stage2a_code_harmonization_runs as run
      on run.id = p_run_id
     and run.materialization_run_id = form.materialization_run_id
    order by form.case_number;
$function$;

drop function if exists public.get_stage2a_harmonization_provenance(
    uuid, integer, integer
);

create function public.get_stage2a_harmonization_provenance(
    p_run_id uuid,
    p_offset integer default 0,
    p_limit integer default 1000
)
returns table (
    case_number text,
    session_id text,
    stage1_report_id uuid,
    preliminary_code_id uuid,
    preliminary_code_number integer,
    preliminary_code_label text,
    preliminary_code_definition text,
    preliminary_code_rationale text,
    harmonized_code_id uuid,
    harmonized_code_number integer,
    harmonized_code_label text,
    harmonized_code_definition text,
    semantic_basis text,
    meaning_unit_id uuid,
    meaning_unit_number integer,
    message_id text,
    exact_source_text text,
    source_language text,
    context_note text
)
language sql
security invoker
set search_path = ''
as $function$
    select form.case_number,
           form.session_id,
           preliminary.source_report_id,
           preliminary.id,
           preliminary.position,
           preliminary.code_label,
           preliminary.definition,
           preliminary.rationale,
           hco.id,
           hco.hco_number,
           hco.harmonized_code_label,
           hco.definition,
           hco.semantic_basis,
           unit.id,
           unit.position,
           unit.source_message_id,
           unit.exact_text,
           unit.source_language,
           null::text
    from public.stage2a_preliminary_code_mappings as mapping
    join public.stage2a_harmonized_codes as hco
      on hco.id = mapping.harmonized_code_id
    join public.stage1_preliminary_codes as preliminary
      on preliminary.id = mapping.preliminary_code_id
    join public.stage1_preliminary_case_forms as form
      on form.materialization_run_id = preliminary.materialization_run_id
     and form.source_job_id = preliminary.source_job_id
    left join public.stage1_preliminary_meaning_units as unit
      on unit.materialization_run_id = preliminary.materialization_run_id
     and unit.source_job_id = preliminary.source_job_id
     and (
         unit.source_identifier = any(preliminary.meaning_unit_references)
         or ('MU' || unit.position::text) = any(preliminary.meaning_unit_references)
     )
    where mapping.run_id = p_run_id
    order by form.case_number, preliminary.position,
             hco.hco_number, unit.position
    offset greatest(coalesce(p_offset, 0), 0)
    limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
$function$;

revoke all on function public.get_stage2a_harmonization_corpus(uuid)
from public, anon, authenticated;
revoke all on function public.complete_stage2a_code_harmonization(
    uuid, jsonb, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.get_stage2a_harmonized_code_form(uuid)
from public, anon, authenticated;
revoke all on function public.get_stage2a_harmonization_provenance(
    uuid, integer, integer
) from public, anon, authenticated;

grant execute on function public.get_stage2a_harmonization_corpus(uuid)
to service_role;
grant execute on function public.complete_stage2a_code_harmonization(
    uuid, jsonb, text, integer, integer
) to service_role;
grant execute on function public.get_stage2a_harmonized_code_form(uuid)
to service_role;
grant execute on function public.get_stage2a_harmonization_provenance(
    uuid, integer, integer
) to service_role;

comment on function public.get_stage2a_harmonization_corpus(uuid) is
    'Returns one unpaginated 275-case analytical input containing only P# and preliminary CO labels. Empty CO arrays keep cases visible without inventing Codes.';
comment on column public.stage2a_code_harmonization_runs.pre_call_snapshot is
    'Persisted Stage 2A checkpoint, including exact provider token count and the complete P# plus CO-only model input. Contains no demographic, MU, Category, Theme, transcript, message, raw report, or legacy Stage 2A content.';
comment on column public.stage2a_code_harmonization_runs.checkpoint_hash is
    'Stable hash of the researcher-visible Stage 2A pre-call state. Paid execution remains unavailable until separately authorized.';
