-- Researcher-authorized parallel whole-corpus Stage 2 operations:
-- 2A CO -> HCO, 2B CA -> HCA, and 2C TH -> HTH.
-- Each request receives only compact source references plus its own layer's
-- preliminary labels. Participant numbers and other analytical layers remain
-- outside the provider request.

alter table public.stage2_runs_v2
    add column analysis_layer text not null default '2a';

alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_analysis_layer_valid check (
        analysis_layer in ('2a', '2b', '2c')
    );

alter table public.stage2_runs_v2
    drop constraint stage2_runs_v2_cohort_id_key;

alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_cohort_layer_unique
    unique (cohort_id, analysis_layer);

create index stage2_runs_v2_layer_queue_idx
on public.stage2_runs_v2(analysis_layer, status, queued_at);

create table public.stage2_source_item_lineage_v2 (
    run_id uuid not null references public.stage2_runs_v2(id) on delete restrict,
    source_ref text not null,
    case_id uuid not null references public.analysis_cases_v2(id) on delete restrict,
    local_source_id text not null,
    created_at timestamptz not null default now(),
    primary key (run_id, source_ref),
    constraint stage2_source_item_lineage_v2_ref_valid check (
        source_ref ~ '^(PCA|PTH)[0-9]{6,}$'
    ),
    constraint stage2_source_item_lineage_v2_local_id_not_blank check (
        btrim(local_source_id) <> ''
    ),
    unique (run_id, case_id, local_source_id)
);

comment on table public.stage2_source_item_lineage_v2 is
    'Service-only lineage for Stage 2B preliminary CA and Stage 2C preliminary TH compact references. P# is never placed in either model request.';

create trigger stage2_source_item_lineage_v2_immutable
before update or delete on public.stage2_source_item_lineage_v2
for each row execute function public.reject_analysis_v2_mutation();

alter table public.stage2_source_item_lineage_v2 enable row level security;
revoke all on table public.stage2_source_item_lineage_v2
from public, anon, authenticated;
grant select, insert on table public.stage2_source_item_lineage_v2 to service_role;

create or replace function public.claim_next_stage2_v2_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.stage2_runs_v2%rowtype;
    selected_action text;
    selected_request public.stage2_requests_v2%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended('case_bound_stage2_v2_claim', 0));
    select run.* into selected_run
    from public.stage2_runs_v2 as run
    where run.analysis_layer = '2a'
      and (run.status = 'queued'
       or (run.status = 'provider_pending'
           and coalesce(run.next_poll_at, now()) <= now()))
    order by case when run.status = 'queued' then 0 else 1 end,
        run.queued_at, run.id
    for update skip locked limit 1;
    if not found then return null; end if;

    selected_action := case when selected_run.status = 'queued'
        then 'submit' else 'retrieve' end;
    if selected_action = 'submit' then
        update public.stage2_runs_v2
        set status = 'processing', claimed_at = now()
        where id = selected_run.id;
        update public.analysis_cohorts_v2
        set status = 'stage2_processing', blocked_reason = null
        where id = selected_run.cohort_id;
    else
        update public.stage2_runs_v2
        set claimed_at = now(), next_poll_at = now() + interval '15 seconds'
        where id = selected_run.id;
    end if;

    select * into selected_request from public.stage2_requests_v2
    where run_id = selected_run.id;
    return jsonb_build_object(
        'action', selected_action,
        'analysisLayer', selected_run.analysis_layer,
        'runId', selected_run.id,
        'cohortId', selected_run.cohort_id,
        'provider', selected_run.provider,
        'model', selected_run.model,
        'reasoningEffort', selected_run.reasoning_effort,
        'maxOutputTokens', selected_run.max_output_tokens,
        'corpusSnapshotJson', selected_run.corpus_snapshot_json,
        'corpusSnapshotSha256', selected_run.corpus_snapshot_sha256,
        'providerResponseId', selected_run.provider_response_id,
        'frozenRequest', selected_request.request_json
    );
end;
$function$;

create or replace function public.claim_next_parallel_stage2_v2_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_run public.stage2_runs_v2%rowtype;
    selected_action text;
    selected_request public.stage2_requests_v2%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended('case_bound_parallel_stage2_v2_claim', 0));
    select run.* into selected_run
    from public.stage2_runs_v2 as run
    where run.analysis_layer in ('2b', '2c')
      and (run.status = 'queued'
       or (run.status = 'provider_pending'
           and coalesce(run.next_poll_at, now()) <= now()))
    order by case when run.status = 'queued' then 0 else 1 end,
        run.analysis_layer, run.queued_at, run.id
    for update skip locked limit 1;
    if not found then return null; end if;

    selected_action := case when selected_run.status = 'queued'
        then 'submit' else 'retrieve' end;
    if selected_action = 'submit' then
        update public.stage2_runs_v2
        set status = 'processing', claimed_at = now()
        where id = selected_run.id;
        update public.analysis_cohorts_v2
        set status = 'stage2_processing', blocked_reason = null
        where id = selected_run.cohort_id;
    else
        update public.stage2_runs_v2
        set claimed_at = now(), next_poll_at = now() + interval '15 seconds'
        where id = selected_run.id;
    end if;

    select * into selected_request from public.stage2_requests_v2
    where run_id = selected_run.id;
    return jsonb_build_object(
        'action', selected_action,
        'analysisLayer', selected_run.analysis_layer,
        'runId', selected_run.id,
        'cohortId', selected_run.cohort_id,
        'provider', selected_run.provider,
        'model', selected_run.model,
        'reasoningEffort', selected_run.reasoning_effort,
        'maxOutputTokens', selected_run.max_output_tokens,
        'corpusSnapshotJson', selected_run.corpus_snapshot_json,
        'corpusSnapshotSha256', selected_run.corpus_snapshot_sha256,
        'providerResponseId', selected_run.provider_response_id,
        'frozenRequest', selected_request.request_json
    );
end;
$function$;

create or replace function public.refresh_parallel_stage2_cohort_status_v2(
    p_cohort_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    run_count integer;
    completed_count integer;
    terminal_problem_count integer;
    presentation_count integer;
    presentation_problem_count integer;
begin
    select count(*),
        count(*) filter (where run.status = 'completed'),
        count(*) filter (where run.status in ('technically_incomplete', 'failed')),
        count(presentation.run_id),
        count(*) filter (where presentation.materialization_error is not null)
    into run_count, completed_count, terminal_problem_count,
        presentation_count, presentation_problem_count
    from public.stage2_runs_v2 as run
    left join public.stage2_presentations_v2 as presentation
      on presentation.run_id = run.id
    where run.cohort_id = p_cohort_id;

    update public.analysis_cohorts_v2
    set status = case
            when terminal_problem_count > 0 or presentation_problem_count > 0
                then 'blocked'
            when run_count = 3 and completed_count = 3 and presentation_count = 3
                then 'completed'
            else 'stage2_processing'
        end,
        blocked_reason = case
            when terminal_problem_count > 0
                then 'One or more parallel Stage 2 provider responses did not technically complete.'
            when presentation_problem_count > 0
                then 'One or more completed parallel Stage 2 responses could not be projected for display.'
            else null
        end
    where id = p_cohort_id;
    return found;
end;
$function$;

create or replace function public.record_stage2_v2_provider_response(
    p_run_id uuid,
    p_outcome text,
    p_provider_response_id text,
    p_provider_status text,
    p_provider_response_json jsonb,
    p_raw_model_output_text text,
    p_incomplete_details jsonb default null,
    p_technical_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
begin
    if p_outcome not in (
        'provider_pending', 'completed', 'technically_incomplete', 'failed'
    ) then raise exception 'Invalid objective provider outcome'; end if;
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status in ('processing', 'provider_pending')
    for update;
    if selected_cohort_id is null then raise exception 'Stage 2 run is not active'; end if;

    if p_outcome = 'provider_pending' then
        update public.stage2_runs_v2
        set status = 'provider_pending', provider_response_id = p_provider_response_id,
            provider_status = p_provider_status,
            next_poll_at = now() + interval '15 seconds'
        where id = p_run_id;
        return true;
    end if;

    update public.stage2_runs_v2
    set status = p_outcome, provider_response_id = p_provider_response_id,
        provider_status = p_provider_status,
        provider_response_json = p_provider_response_json,
        raw_model_output_text = p_raw_model_output_text,
        incomplete_details = p_incomplete_details,
        technical_error = p_technical_error,
        next_poll_at = null, terminal_at = now()
    where id = p_run_id;
    perform public.refresh_parallel_stage2_cohort_status_v2(selected_cohort_id);
    return true;
end;
$function$;

create or replace function public.fail_stage2_v2_run(
    p_run_id uuid,
    p_technical_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
begin
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status in ('processing', 'provider_pending')
    for update;
    if selected_cohort_id is null then return false; end if;
    update public.stage2_runs_v2
    set status = 'failed', technical_error = p_technical_error,
        terminal_at = now(), next_poll_at = null
    where id = p_run_id;
    perform public.refresh_parallel_stage2_cohort_status_v2(selected_cohort_id);
    return true;
end;
$function$;

create or replace function public.save_stage2_v2_presentation(
    p_run_id uuid,
    p_presentation_json jsonb,
    p_materialization_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    selected_cohort_id uuid;
begin
    select cohort_id into selected_cohort_id
    from public.stage2_runs_v2
    where id = p_run_id and status = 'completed';
    if selected_cohort_id is null then
        raise exception 'Only an objectively completed Stage 2 response can be presented';
    end if;
    insert into public.stage2_presentations_v2 (
        run_id, presentation_json, materialization_error
    ) values (p_run_id, p_presentation_json, p_materialization_error);
    perform public.refresh_parallel_stage2_cohort_status_v2(selected_cohort_id);
    return true;
end;
$function$;

-- Build the current authorized pilot's missing CA and TH corpus from stored
-- Stage 1 materialization, plus the complete arrays preserved in the two raw
-- provider responses that were not materialized earlier.
create or replace function private.extract_complete_json_array_parallel_v2(
    p_source text,
    p_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    key_position integer;
    array_position integer;
    i integer;
    depth integer := 0;
    in_string boolean := false;
    escaped boolean := false;
    character text;
begin
    key_position := strpos(p_source, '"' || p_key || '"');
    if key_position = 0 then raise exception 'Pilot source does not contain %', p_key; end if;
    array_position := strpos(substr(p_source, key_position), '[') + key_position - 1;
    if array_position < key_position then raise exception 'Pilot source has no array for %', p_key; end if;
    for i in array_position..length(p_source) loop
        character := substr(p_source, i, 1);
        if in_string then
            if escaped then escaped := false;
            elsif character = E'\\' then escaped := true;
            elsif character = '"' then in_string := false;
            end if;
        elsif character = '"' then in_string := true;
        elsif character = '[' then depth := depth + 1;
        elsif character = ']' then
            depth := depth - 1;
            if depth = 0 then
                return substr(p_source, array_position, i - array_position + 1)::jsonb;
            end if;
        end if;
    end loop;
    raise exception 'Pilot source contains an incomplete % array', p_key;
end;
$function$;

create temporary table pilot_parallel_stage2_sources_v2 (
    analysis_layer text not null,
    case_id uuid not null,
    local_source_id text not null,
    source_text text not null,
    source_position integer not null,
    primary key (analysis_layer, case_id, local_source_id)
) on commit drop;

insert into pilot_parallel_stage2_sources_v2
select '2b', assumption.case_id,
    'CA' || lpad(category.position::text, 3, '0'),
    category.category_label, category.position
from public.stage1_preliminary_categories as category
join public.pilot_stage1_assumptions_v2 as assumption
  on assumption.source_job_id = category.source_job_id
where category.materialization_run_id = assumption.source_materialization_run_id;

insert into pilot_parallel_stage2_sources_v2
select '2c', assumption.case_id,
    'TH' || lpad(theme.position::text, 3, '0'),
    theme.theme_label, theme.position
from public.stage1_preliminary_implied_themes as theme
join public.pilot_stage1_assumptions_v2 as assumption
  on assumption.source_job_id = theme.source_job_id
where theme.materialization_run_id = assumption.source_materialization_run_id;

insert into pilot_parallel_stage2_sources_v2
select '2b', assumption.case_id,
    'CA' || lpad((item.value ->> 'category_number')::text, 3, '0'),
    item.value ->> 'category',
    (item.value ->> 'category_number')::integer
from public.advanced_preliminary_analysis_jobs as job
join public.pilot_stage1_assumptions_v2 as assumption
  on assumption.source_job_id = job.id
cross join lateral jsonb_array_elements(
    private.extract_complete_json_array_parallel_v2(
        job.raw_model_output_text, 'preliminary_categories'
    )
) as item(value)
where not exists (
    select 1 from public.stage1_preliminary_categories as existing
    where existing.source_job_id = job.id
      and existing.materialization_run_id = assumption.source_materialization_run_id
);

insert into pilot_parallel_stage2_sources_v2
select '2c', assumption.case_id,
    'TH' || lpad((item.value ->> 'theme_number')::text, 3, '0'),
    item.value ->> 'tentative_theme',
    (item.value ->> 'theme_number')::integer
from public.advanced_preliminary_analysis_jobs as job
join public.pilot_stage1_assumptions_v2 as assumption
  on assumption.source_job_id = job.id
cross join lateral jsonb_array_elements(
    private.extract_complete_json_array_parallel_v2(
        job.raw_model_output_text, 'preliminary_tentative_themes'
    )
) as item(value)
where not exists (
    select 1 from public.stage1_preliminary_implied_themes as existing
    where existing.source_job_id = job.id
      and existing.materialization_run_id = assumption.source_materialization_run_id
);

do $parallel_pilot$
declare
    selected_cohort_id uuid;
    selected_configuration public.stage2_runs_v2%rowtype;
    selected_layer text;
    selected_key text;
    selected_prefix text;
    selected_count integer;
    corpus_items jsonb;
    corpus_snapshot jsonb;
    corpus_hash text;
    new_run_id uuid;
begin
    if (select count(*) from pilot_parallel_stage2_sources_v2 where analysis_layer = '2b') <> 1927 then
        raise exception 'Parallel Stage 2B expected exactly 1,927 preliminary CA fixtures';
    end if;
    if (select count(*) from pilot_parallel_stage2_sources_v2 where analysis_layer = '2c') <> 970 then
        raise exception 'Parallel Stage 2C expected exactly 970 preliminary TH fixtures';
    end if;

    select run.cohort_id into selected_cohort_id
    from public.stage2_runs_v2 as run
    where run.analysis_layer = '2a'
      and not exists (
          select 1 from public.analysis_cohort_cases_v2 as member
          left join public.pilot_stage1_assumptions_v2 as assumption
            on assumption.case_id = member.case_id
          where member.cohort_id = run.cohort_id
            and assumption.case_id is null
      )
    order by run.queued_at desc
    limit 1;
    if selected_cohort_id is null then
        raise exception 'The researcher-authorized pilot cohort is missing';
    end if;

    select * into selected_configuration
    from public.stage2_runs_v2
    where cohort_id = selected_cohort_id and analysis_layer = '2a';
    if not found then raise exception 'The authorized Stage 2A pilot run is missing'; end if;

    foreach selected_layer in array array['2b', '2c'] loop
        selected_key := case selected_layer
            when '2b' then 'preliminary_categories' else 'preliminary_themes' end;
        selected_prefix := case selected_layer
            when '2b' then 'PCA' else 'PTH' end;

        with numbered as (
            select source.case_id, source.local_source_id, source.source_text,
                row_number() over (
                    order by analysis_case.case_number, source.source_position
                ) as source_number
            from pilot_parallel_stage2_sources_v2 as source
            join public.analysis_cases_v2 as analysis_case on analysis_case.id = source.case_id
            where source.analysis_layer = selected_layer
        )
        select jsonb_agg(
            jsonb_build_object(
                'source_ref', selected_prefix || lpad(source_number::text, 6, '0'),
                case when selected_layer = '2b' then 'label' else 'statement' end,
                source_text
            ) order by source_number
        ) into corpus_items
        from numbered;

        selected_count := jsonb_array_length(corpus_items);
        corpus_snapshot := jsonb_build_object(
            'cohortId', selected_cohort_id,
            selected_key, corpus_items
        );
        corpus_hash := encode(
            extensions.digest(convert_to(corpus_snapshot::text, 'UTF8'), 'sha256'),
            'hex'
        );

        insert into public.stage2_runs_v2 (
            cohort_id, analysis_layer, provider, model, reasoning_effort,
            max_output_tokens, corpus_snapshot_json, corpus_snapshot_sha256
        ) values (
            selected_cohort_id, selected_layer, selected_configuration.provider,
            selected_configuration.model, selected_configuration.reasoning_effort,
            selected_configuration.max_output_tokens, corpus_snapshot, corpus_hash
        ) returning id into new_run_id;

        with numbered as (
            select source.case_id, source.local_source_id,
                row_number() over (
                    order by analysis_case.case_number, source.source_position
                ) as source_number
            from pilot_parallel_stage2_sources_v2 as source
            join public.analysis_cases_v2 as analysis_case on analysis_case.id = source.case_id
            where source.analysis_layer = selected_layer
        )
        insert into public.stage2_source_item_lineage_v2 (
            run_id, source_ref, case_id, local_source_id
        )
        select new_run_id,
            selected_prefix || lpad(source_number::text, 6, '0'),
            case_id, local_source_id
        from numbered
        order by source_number;

        if (select count(*) from public.stage2_source_item_lineage_v2 where run_id = new_run_id) <> selected_count then
            raise exception 'Parallel Stage 2 lineage count does not match its frozen corpus';
        end if;
    end loop;

    update public.analysis_cohorts_v2
    set status = 'stage2_processing', blocked_reason = null
    where id = selected_cohort_id;
end;
$parallel_pilot$;

drop function private.extract_complete_json_array_parallel_v2(text, text);

revoke all on function public.claim_next_parallel_stage2_v2_run()
from public, anon, authenticated, service_role;
revoke all on function public.refresh_parallel_stage2_cohort_status_v2(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.claim_next_parallel_stage2_v2_run() to service_role;
grant execute on function public.refresh_parallel_stage2_cohort_status_v2(uuid) to service_role;
