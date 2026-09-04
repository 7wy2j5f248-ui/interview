-- A terminal Stage 2 run remains immutable. A researcher may authorize a
-- separately numbered replacement that reuses the exact frozen corpus and
-- records its lineage to the earlier run. New replacements impose no
-- application-level output-token ceiling.

alter table public.stage2_runs_v2
    add column attempt_number integer not null default 1,
    add column prior_run_id uuid references public.stage2_runs_v2(id) on delete restrict,
    add column researcher_reason text;

alter table public.stage2_runs_v2
    alter column max_output_tokens drop not null;

alter table public.stage2_runs_v2
    drop constraint stage2_runs_v2_cohort_layer_unique;

alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_cohort_layer_attempt_unique
    unique (cohort_id, analysis_layer, attempt_number);

alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_attempt_valid check (attempt_number > 0),
    add constraint stage2_runs_v2_replacement_lineage_consistent check (
        (attempt_number = 1 and prior_run_id is null and researcher_reason is null)
        or (attempt_number > 1 and prior_run_id is not null
            and btrim(researcher_reason) <> '')
    );

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
    with latest as (
        select distinct on (run.analysis_layer)
            run.id, run.status
        from public.stage2_runs_v2 as run
        where run.cohort_id = p_cohort_id
        order by run.analysis_layer, run.attempt_number desc
    )
    select count(*),
        count(*) filter (where latest.status = 'completed'),
        count(*) filter (where latest.status in ('technically_incomplete', 'failed')),
        count(presentation.run_id),
        count(*) filter (where presentation.materialization_error is not null)
    into run_count, completed_count, terminal_problem_count,
        presentation_count, presentation_problem_count
    from latest
    left join public.stage2_presentations_v2 as presentation
      on presentation.run_id = latest.id;

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
                then 'One or more current Stage 2 provider responses did not technically complete.'
            when presentation_problem_count > 0
                then 'One or more current completed Stage 2 responses could not be projected for display.'
            else null
        end
    where id = p_cohort_id;
    return found;
end;
$function$;

create or replace function public.authorize_stage2_v2_replacement(
    p_prior_run_id uuid,
    p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
    prior_run public.stage2_runs_v2%rowtype;
    next_attempt integer;
    new_run_id uuid;
begin
    if nullif(btrim(p_reason), '') is null then
        raise exception 'A researcher reason is required for a Stage 2 replacement';
    end if;

    select * into prior_run
    from public.stage2_runs_v2
    where id = p_prior_run_id
    for update;
    if not found then raise exception 'The prior Stage 2 run does not exist'; end if;
    if prior_run.status not in ('completed', 'technically_incomplete', 'failed') then
        raise exception 'Only a terminal Stage 2 run can receive a replacement';
    end if;

    select coalesce(max(run.attempt_number), 0) + 1 into next_attempt
    from public.stage2_runs_v2 as run
    where run.cohort_id = prior_run.cohort_id
      and run.analysis_layer = prior_run.analysis_layer;

    insert into public.stage2_runs_v2 (
        cohort_id, analysis_layer, attempt_number, prior_run_id,
        researcher_reason, provider, model, reasoning_effort,
        max_output_tokens, corpus_snapshot_json, corpus_snapshot_sha256
    ) values (
        prior_run.cohort_id, prior_run.analysis_layer, next_attempt,
        prior_run.id, btrim(p_reason), prior_run.provider, prior_run.model,
        prior_run.reasoning_effort, null, prior_run.corpus_snapshot_json,
        prior_run.corpus_snapshot_sha256
    ) returning id into new_run_id;

    if prior_run.analysis_layer = '2a' then
        insert into public.stage2_source_code_lineage_v2 (
            run_id, source_ref, case_id, local_code_id
        )
        select new_run_id, source_ref, case_id, local_code_id
        from public.stage2_source_code_lineage_v2
        where run_id = prior_run.id;
    else
        insert into public.stage2_source_item_lineage_v2 (
            run_id, source_ref, case_id, local_source_id
        )
        select new_run_id, source_ref, case_id, local_source_id
        from public.stage2_source_item_lineage_v2
        where run_id = prior_run.id;
    end if;

    update public.analysis_cohorts_v2
    set status = 'stage2_processing', blocked_reason = null
    where id = prior_run.cohort_id;
    return new_run_id;
end;
$function$;

revoke all on function public.authorize_stage2_v2_replacement(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.authorize_stage2_v2_replacement(uuid, text)
to service_role;
