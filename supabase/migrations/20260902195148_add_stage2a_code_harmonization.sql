create table public.stage2a_code_harmonization_runs (
    id uuid primary key default gen_random_uuid(),
    run_number bigint generated always as identity unique,
    stage1_run_id uuid not null
        references public.advanced_preliminary_analysis_runs(id) on delete restrict,
    project_id uuid not null
        references public.research_projects(id) on delete restrict,
    status text not null default 'queued',
    provider text not null,
    model text not null,
    resolved_model text not null,
    reasoning_effort text not null,
    analysis_version text not null,
    prompt_version text not null,
    stop_layer text not null default 'harmonized_codes',
    rules_snapshot jsonb not null,
    pre_call_snapshot jsonb not null default '{}'::jsonb,
    source_case_count integer not null,
    preliminary_code_count integer not null,
    code_meaning_unit_link_count integer not null,
    context_window_tokens integer,
    reserved_output_tokens integer,
    input_token_count integer,
    output_token_count integer,
    provider_response_id text,
    raw_model_output_text text,
    parsed_model_output jsonb,
    system_processing_notes jsonb not null default '[]'::jsonb,
    requested_by text not null default 'researcher-dashboard',
    requested_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    last_error text
);

create table public.stage2a_harmonized_codes (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null
        references public.stage2a_code_harmonization_runs(id) on delete cascade,
    hco_number integer not null,
    harmonized_code_label text not null,
    definition text,
    semantic_basis text,
    model_payload jsonb not null,
    created_at timestamptz not null default now(),
    unique (run_id, hco_number)
);

create table public.stage2a_preliminary_code_mappings (
    run_id uuid not null
        references public.stage2a_code_harmonization_runs(id) on delete cascade,
    harmonized_code_id uuid not null
        references public.stage2a_harmonized_codes(id) on delete cascade,
    preliminary_code_id uuid not null
        references public.advanced_preliminary_codes(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (run_id, preliminary_code_id)
);

create index stage2a_mapping_hco_idx
on public.stage2a_preliminary_code_mappings(harmonized_code_id);

alter table public.stage2a_code_harmonization_runs enable row level security;
alter table public.stage2a_harmonized_codes enable row level security;
alter table public.stage2a_preliminary_code_mappings enable row level security;

revoke all on table public.stage2a_code_harmonization_runs
from public, anon, authenticated;
revoke all on table public.stage2a_harmonized_codes
from public, anon, authenticated;
revoke all on table public.stage2a_preliminary_code_mappings
from public, anon, authenticated;

grant select, insert, update on table public.stage2a_code_harmonization_runs
to service_role;
grant select, insert on table public.stage2a_harmonized_codes
to service_role;
grant select, insert on table public.stage2a_preliminary_code_mappings
to service_role;

create or replace function public.get_stage2a_harmonization_corpus(
    p_stage1_run_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
    with reports as (
        select report.id, report.case_number, report.session_id
        from public.advanced_preliminary_case_reports as report
        where report.run_id = p_stage1_run_id
    ),
    codes as (
        select code.id, code.report_id, code.code_number, code.code_label,
               code.definition, code.rationale
        from public.advanced_preliminary_codes as code
        join reports as report on report.id = code.report_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_id', report.case_number,
        'session_id', report.session_id,
        'preliminary_code_id', code.id,
        'preliminary_code_position', 'CO' || code.code_number,
        'preliminary_code', code.code_label,
        'definition', code.definition,
        'rationale', code.rationale,
        'meaning_units', coalesce((
            select jsonb_agg(jsonb_build_object(
                'meaning_unit_id', unit.id,
                'meaning_unit_position', 'MU' || unit.unit_number,
                'message_id', unit.message_id,
                'exact_source_text', unit.exact_source_text,
                'source_language', unit.source_language,
                'context_note', unit.context_note
            ) order by unit.unit_number)
            from public.advanced_preliminary_code_meaning_units as link
            join public.advanced_preliminary_meaning_units as unit
              on unit.id = link.meaning_unit_id
            where link.code_id = code.id
        ), '[]'::jsonb)
    ) order by report.case_number, code.code_number), '[]'::jsonb)
    from codes as code
    join reports as report on report.id = code.report_id;
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
    stage1_id uuid;
    hco_item jsonb;
    hco_ordinal bigint;
    stored_hco_id uuid;
    preliminary_id_text text;
begin
    select run.stage1_run_id
    into stage1_id
    from public.stage2a_code_harmonization_runs as run
    where run.id = p_run_id;

    if stage1_id is null then
        return false;
    end if;

    delete from public.stage2a_preliminary_code_mappings as mapping
    where mapping.run_id = p_run_id;
    delete from public.stage2a_harmonized_codes as code
    where code.run_id = p_run_id;

    for hco_item, hco_ordinal in
        select item.value, item.ordinality
        from jsonb_array_elements(
            coalesce(p_output -> 'harmonized_codes', '[]'::jsonb)
        ) with ordinality as item(value, ordinality)
    loop
        insert into public.stage2a_harmonized_codes (
            run_id, hco_number, harmonized_code_label, definition,
            semantic_basis, model_payload
        ) values (
            p_run_id,
            hco_ordinal::integer,
            coalesce(nullif(btrim(hco_item ->> 'label'), ''),
                     'Unnamed harmonized code'),
            nullif(btrim(hco_item ->> 'definition'), ''),
            nullif(btrim(hco_item ->> 'semantic_basis'), ''),
            hco_item
        ) returning id into stored_hco_id;

        for preliminary_id_text in
            select value
            from jsonb_array_elements_text(
                coalesce(hco_item -> 'preliminary_code_ids', '[]'::jsonb)
            )
        loop
            insert into public.stage2a_preliminary_code_mappings (
                run_id, harmonized_code_id, preliminary_code_id
            )
            select p_run_id, stored_hco_id, preliminary.id
            from public.advanced_preliminary_codes as preliminary
            join public.advanced_preliminary_case_reports as report
              on report.id = preliminary.report_id
            where preliminary.id::text = preliminary_id_text
              and report.run_id = stage1_id
            on conflict (run_id, preliminary_code_id) do nothing;
        end loop;
    end loop;

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
    with case_hcos as (
        select report.case_number,
               hco.id,
               hco.harmonized_code_label,
               min(preliminary.code_number) as first_code_position
        from public.stage2a_preliminary_code_mappings as mapping
        join public.stage2a_harmonized_codes as hco
          on hco.id = mapping.harmonized_code_id
        join public.advanced_preliminary_codes as preliminary
          on preliminary.id = mapping.preliminary_code_id
        join public.advanced_preliminary_case_reports as report
          on report.id = preliminary.report_id
        where mapping.run_id = p_run_id
        group by report.case_number, hco.id, hco.harmonized_code_label
    )
    select case_hcos.case_number,
           jsonb_agg(jsonb_build_object(
               'harmonized_code_id', case_hcos.id,
               'label', case_hcos.harmonized_code_label
           ) order by case_hcos.first_code_position, case_hcos.id)
    from case_hcos
    group by case_hcos.case_number
    order by case_hcos.case_number;
$function$;

create or replace function public.get_stage2a_harmonization_provenance(
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
    message_id uuid,
    exact_source_text text,
    source_language text,
    context_note text
)
language sql
security invoker
set search_path = ''
as $function$
    select report.case_number,
           report.session_id,
           report.id,
           preliminary.id,
           preliminary.code_number,
           preliminary.code_label,
           preliminary.definition,
           preliminary.rationale,
           hco.id,
           hco.hco_number,
           hco.harmonized_code_label,
           hco.definition,
           hco.semantic_basis,
           unit.id,
           unit.unit_number,
           unit.message_id,
           unit.exact_source_text,
           unit.source_language,
           unit.context_note
    from public.stage2a_preliminary_code_mappings as mapping
    join public.stage2a_harmonized_codes as hco
      on hco.id = mapping.harmonized_code_id
    join public.advanced_preliminary_codes as preliminary
      on preliminary.id = mapping.preliminary_code_id
    join public.advanced_preliminary_case_reports as report
      on report.id = preliminary.report_id
    left join public.advanced_preliminary_code_meaning_units as link
      on link.code_id = preliminary.id
    left join public.advanced_preliminary_meaning_units as unit
      on unit.id = link.meaning_unit_id
    where mapping.run_id = p_run_id
    order by report.case_number, preliminary.code_number,
             hco.hco_number, unit.unit_number
    offset greatest(coalesce(p_offset, 0), 0)
    limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
$function$;

revoke all on function public.get_stage2a_harmonization_corpus(uuid)
from public, anon, authenticated;
revoke all on function public.complete_stage2a_code_harmonization(uuid,jsonb,text,integer,integer)
from public, anon, authenticated;
revoke all on function public.get_stage2a_harmonized_code_form(uuid)
from public, anon, authenticated;
revoke all on function public.get_stage2a_harmonization_provenance(uuid,integer,integer)
from public, anon, authenticated;

grant execute on function public.get_stage2a_harmonization_corpus(uuid)
to service_role;
grant execute on function public.complete_stage2a_code_harmonization(uuid,jsonb,text,integer,integer)
to service_role;
grant execute on function public.get_stage2a_harmonized_code_form(uuid)
to service_role;
grant execute on function public.get_stage2a_harmonization_provenance(uuid,integer,integer)
to service_role;

comment on table public.stage2a_code_harmonization_runs is
    'One whole-corpus Cross-Case Code Harmonization response. No batching, category generation, theme generation, validator, audit, repair, approval, or case exclusion occurs here.';
comment on table public.stage2a_harmonized_codes is
    'Harmonized Codes produced by one whole-corpus Stage 2A comparison.';
comment on table public.stage2a_preliminary_code_mappings is
    'Preserved Preliminary Code to Harmonized Code lineage; Meaning Unit and transcript provenance remain linked through the Stage 1 Code.';
