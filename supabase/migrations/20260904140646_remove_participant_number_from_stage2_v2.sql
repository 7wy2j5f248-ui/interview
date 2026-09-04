-- P# is retained only in the case tables. Stage 2 receives compact source
-- references and preliminary Code labels, while this private lineage table
-- preserves the return path to the case-local Code.

create table public.stage2_source_code_lineage_v2 (
    run_id uuid not null references public.stage2_runs_v2(id) on delete restrict,
    source_ref text not null,
    case_id uuid not null references public.analysis_cases_v2(id) on delete restrict,
    local_code_id text not null,
    created_at timestamptz not null default now(),
    primary key (run_id, source_ref),
    constraint stage2_source_code_lineage_v2_ref_valid
        check (source_ref ~ '^PC[0-9]{6,}$'),
    constraint stage2_source_code_lineage_v2_local_code_not_blank
        check (btrim(local_code_id) <> ''),
    constraint stage2_source_code_lineage_v2_source_unique
        unique (run_id, case_id, local_code_id)
);

comment on table public.stage2_source_code_lineage_v2 is
    'Service-only lineage from compact Stage 2 source references to case-local Codes. P# is never placed in the model request.';

create trigger stage2_source_code_lineage_v2_immutable
before update or delete on public.stage2_source_code_lineage_v2
for each row execute function public.reject_analysis_v2_mutation();

alter table public.stage2_source_code_lineage_v2 enable row level security;
revoke all on table public.stage2_source_code_lineage_v2 from public, anon, authenticated;
grant select on table public.stage2_source_code_lineage_v2 to service_role;

create or replace function public.advance_analysis_cohort_v2(
    p_cohort_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort public.analysis_cohorts_v2%rowtype;
    selected_configuration public.analysis_project_configurations_v2%rowtype;
    member_count integer;
    complete_count integer;
    present_count integer;
    corpus_codes jsonb;
    corpus_snapshot jsonb;
    corpus_hash text;
    new_run_id uuid;
begin
    select * into selected_cohort
    from public.analysis_cohorts_v2
    where id = p_cohort_id
    for update;

    if not found or selected_cohort.status = 'open' then return null; end if;

    select count(*),
        count(*) filter (where analysis_case.stage1_status = 'completed'),
        count(*) filter (where presentation.presentation_json is not null)
    into member_count, complete_count, present_count
    from public.analysis_cohort_cases_v2 as member
    join public.analysis_cases_v2 as analysis_case on analysis_case.id = member.case_id
    left join public.stage1_attempts_v2 as attempt
      on attempt.case_id = analysis_case.id and attempt.status = 'completed'
    left join public.stage1_presentations_v2 as presentation
      on presentation.attempt_id = attempt.id
    where member.cohort_id = p_cohort_id;

    if member_count = 0 or complete_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'closed', blocked_reason = null
        where id = p_cohort_id and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if present_count <> member_count then
        update public.analysis_cohorts_v2
        set status = 'blocked',
            blocked_reason = 'A completed provider response could not be projected into its explicit Stage 1 structure.'
        where id = p_cohort_id and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    if exists (select 1 from public.stage2_runs_v2 where cohort_id = p_cohort_id) then
        select id into new_run_id from public.stage2_runs_v2
        where cohort_id = p_cohort_id;
        return new_run_id;
    end if;

    with source_codes as (
        select analysis_case.id as case_id,
            code.value ->> 'id' as local_code_id,
            code.value ->> 'label' as code_label,
            row_number() over (
                order by analysis_case.case_number, code.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join public.stage1_attempts_v2 as attempt
          on attempt.case_id = analysis_case.id and attempt.status = 'completed'
        join public.stage1_presentations_v2 as presentation
          on presentation.attempt_id = attempt.id
        cross join lateral jsonb_array_elements(
            presentation.presentation_json -> 'preliminary_codes'
        ) with ordinality as code(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    select jsonb_agg(
        jsonb_build_object(
            'source_ref', 'PC' || lpad(source_number::text, 6, '0'),
            'label', code_label
        ) order by source_number
    ) into corpus_codes
    from source_codes;

    if corpus_codes is null or jsonb_array_length(corpus_codes) = 0 then
        update public.analysis_cohorts_v2
        set status = 'blocked',
            blocked_reason = 'The closed cohort has no preliminary Codes for Stage 2A.'
        where id = p_cohort_id and status not in ('stage2_queued', 'stage2_processing', 'completed');
        return null;
    end if;

    corpus_snapshot := jsonb_build_object(
        'cohortId', p_cohort_id,
        'preliminary_codes', corpus_codes
    );
    corpus_hash := encode(
        extensions.digest(convert_to(corpus_snapshot::text, 'UTF8'), 'sha256'),
        'hex'
    );

    select * into selected_configuration
    from public.analysis_project_configurations_v2
    where id = selected_cohort.configuration_id;

    insert into public.stage2_runs_v2 (
        cohort_id, provider, model, reasoning_effort, max_output_tokens,
        corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        p_cohort_id, selected_configuration.provider, selected_configuration.model,
        selected_configuration.reasoning_effort,
        selected_configuration.max_output_tokens,
        corpus_snapshot, corpus_hash
    ) returning id into new_run_id;

    with source_codes as (
        select analysis_case.id as case_id,
            code.value ->> 'id' as local_code_id,
            row_number() over (
                order by analysis_case.case_number, code.ordinality
            ) as source_number
        from public.analysis_cohort_cases_v2 as member
        join public.analysis_cases_v2 as analysis_case
          on analysis_case.id = member.case_id
        join public.stage1_attempts_v2 as attempt
          on attempt.case_id = analysis_case.id and attempt.status = 'completed'
        join public.stage1_presentations_v2 as presentation
          on presentation.attempt_id = attempt.id
        cross join lateral jsonb_array_elements(
            presentation.presentation_json -> 'preliminary_codes'
        ) with ordinality as code(value, ordinality)
        where member.cohort_id = p_cohort_id
    )
    insert into public.stage2_source_code_lineage_v2 (
        run_id, source_ref, case_id, local_code_id
    )
    select new_run_id,
        'PC' || lpad(source_number::text, 6, '0'),
        case_id,
        local_code_id
    from source_codes
    order by source_number;

    update public.analysis_cohorts_v2
    set status = 'stage2_queued', blocked_reason = null
    where id = p_cohort_id;
    return new_run_id;
end;
$function$;
