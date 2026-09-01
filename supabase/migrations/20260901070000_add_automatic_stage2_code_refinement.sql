create table public.stage2_code_refinement_runs (
    id uuid primary key default gen_random_uuid(),
    stage1_run_id uuid not null unique
        references public.advanced_preliminary_analysis_runs(id) on delete restrict,
    project_id uuid not null references public.research_projects(id) on delete restrict,
    status text not null default 'preliminary_coding'
        check (status in (
            'preliminary_coding', 'refining_codes',
            'completed', 'completed_with_failures', 'failed'
        )),
    provider text not null,
    model text not null,
    resolved_model text,
    reasoning_effort text not null,
    analysis_version text not null,
    prompt_version text not null,
    source_case_count integer not null default 0 check (source_case_count >= 0),
    preliminary_completed_count integer not null default 0 check (preliminary_completed_count >= 0),
    preliminary_failed_count integer not null default 0 check (preliminary_failed_count >= 0),
    refinement_completed_count integer not null default 0 check (refinement_completed_count >= 0),
    refinement_failed_count integer not null default 0 check (refinement_failed_count >= 0),
    requested_by text not null default 'automatic-after-stage1',
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    last_error text
);

create table public.stage2_preliminary_code_case_jobs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.stage2_code_refinement_runs(id) on delete cascade,
    stage1_report_id uuid not null unique
        references public.advanced_preliminary_case_reports(id) on delete restrict,
    session_id text not null,
    case_number text not null,
    source_completed_at timestamptz not null,
    status text not null default 'pending'
        check (status in ('pending', 'processing', 'completed', 'failed')),
    attempt_count integer not null default 0 check (attempt_count >= 0),
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    next_retry_at timestamptz,
    completed_at timestamptz,
    last_error text,
    input_token_count integer,
    output_token_count integer,
    updated_at timestamptz not null default now(),
    unique (run_id, case_number)
);

create table public.stage2_preliminary_codes (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.stage2_code_refinement_runs(id) on delete cascade,
    case_job_id uuid not null references public.stage2_preliminary_code_case_jobs(id) on delete cascade,
    stage1_report_id uuid not null references public.advanced_preliminary_case_reports(id) on delete restrict,
    case_number text not null,
    code_number integer not null check (code_number > 0),
    code_label text not null check (btrim(code_label) <> ''),
    definition text not null check (btrim(definition) <> ''),
    rationale text not null check (btrim(rationale) <> ''),
    created_at timestamptz not null default now(),
    unique (case_job_id, code_number)
);

create table public.stage2_preliminary_code_evidence (
    preliminary_code_id uuid not null
        references public.stage2_preliminary_codes(id) on delete cascade,
    meaning_unit_id uuid not null
        references public.advanced_preliminary_meaning_units(id) on delete restrict,
    primary key (preliminary_code_id, meaning_unit_id)
);

create table public.stage2_refined_code_jobs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.stage2_code_refinement_runs(id) on delete cascade,
    preliminary_code_id uuid not null unique
        references public.stage2_preliminary_codes(id) on delete restrict,
    source_completed_at timestamptz not null,
    case_number text not null,
    code_number integer not null,
    status text not null default 'pending'
        check (status in ('pending', 'processing', 'completed', 'failed')),
    attempt_count integer not null default 0 check (attempt_count >= 0),
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    next_retry_at timestamptz,
    completed_at timestamptz,
    last_error text,
    input_token_count integer,
    output_token_count integer,
    updated_at timestamptz not null default now()
);

create table public.stage2_refined_codes (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.stage2_code_refinement_runs(id) on delete cascade,
    refined_code_number integer not null check (refined_code_number > 0),
    refined_code_label text not null check (btrim(refined_code_label) <> ''),
    definition text not null check (btrim(definition) <> ''),
    created_from_preliminary_code_id uuid not null
        references public.stage2_preliminary_codes(id) on delete restrict,
    created_at timestamptz not null default now(),
    unique (run_id, refined_code_number)
);

create table public.stage2_code_assignments (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.stage2_code_refinement_runs(id) on delete cascade,
    preliminary_code_id uuid not null unique
        references public.stage2_preliminary_codes(id) on delete restrict,
    refined_code_id uuid not null
        references public.stage2_refined_codes(id) on delete restrict,
    decision text not null check (decision in ('equivalent', 'distinct')),
    semantic_rationale text not null check (btrim(semantic_rationale) <> ''),
    model text not null,
    created_at timestamptz not null default now()
);

create index if not exists cross_case_case_jobs_fifo_idx
on public.stage2_preliminary_code_case_jobs(run_id, status, source_completed_at, session_id);
create index if not exists cross_case_refinement_jobs_fifo_idx
on public.stage2_refined_code_jobs(run_id, status, source_completed_at, case_number, code_number);
create index if not exists cross_case_assignments_refined_idx
on public.stage2_code_assignments(refined_code_id);

alter table public.stage2_code_refinement_runs enable row level security;
alter table public.stage2_preliminary_code_case_jobs enable row level security;
alter table public.stage2_preliminary_codes enable row level security;
alter table public.stage2_preliminary_code_evidence enable row level security;
alter table public.stage2_refined_code_jobs enable row level security;
alter table public.stage2_refined_codes enable row level security;
alter table public.stage2_code_assignments enable row level security;

revoke all on table
    public.stage2_code_refinement_runs,
    public.stage2_preliminary_code_case_jobs,
    public.stage2_preliminary_codes,
    public.stage2_preliminary_code_evidence,
    public.stage2_refined_code_jobs,
    public.stage2_refined_codes,
    public.stage2_code_assignments
from public, anon, authenticated;
grant select, insert, update, delete on table
    public.stage2_code_refinement_runs,
    public.stage2_preliminary_code_case_jobs,
    public.stage2_preliminary_codes,
    public.stage2_preliminary_code_evidence,
    public.stage2_refined_code_jobs,
    public.stage2_refined_codes,
    public.stage2_code_assignments
to service_role;

create or replace function public.ensure_stage2_code_refinement_run()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    selected_stage1 public.advanced_preliminary_analysis_runs%rowtype;
    selected_project_id uuid;
    new_run_id uuid;
begin
    perform pg_advisory_xact_lock(hashtext('stage2_code_refinement_transition'));

    select id into new_run_id
    from public.stage2_code_refinement_runs
    where status in ('preliminary_coding', 'refining_codes')
    order by created_at
    limit 1;
    if new_run_id is not null then return new_run_id; end if;

    select run.* into selected_stage1
    from public.advanced_preliminary_analysis_runs as run
    order by run.requested_at desc, run.id desc
    limit 1;

    if selected_stage1.id is null
       or selected_stage1.status not in ('completed', 'completed_with_failures')
       or exists (
           select 1 from public.stage2_code_refinement_runs as stage2
           where stage2.stage1_run_id = selected_stage1.id
       ) then return null; end if;

    select (item->>'project_id')::uuid into selected_project_id
    from jsonb_array_elements(selected_stage1.project_snapshot) as item
    limit 1;

    insert into public.stage2_code_refinement_runs (
        stage1_run_id, project_id, provider, model, resolved_model,
        reasoning_effort, analysis_version, prompt_version
    ) values (
        selected_stage1.id, selected_project_id, selected_stage1.provider,
        selected_stage1.model, selected_stage1.resolved_model,
        selected_stage1.reasoning_effort,
        'stage2-cross-case-code-refinement-v1',
        'stage2-semantic-harmonization-v1'
    ) returning id into new_run_id;

    insert into public.stage2_preliminary_code_case_jobs (
        run_id, stage1_report_id, session_id, case_number, source_completed_at
    )
    select new_run_id, report.id, report.session_id, report.case_number,
           job.source_completed_at
    from public.advanced_preliminary_case_reports as report
    join public.advanced_preliminary_analysis_jobs as job on job.id = report.job_id
    where report.run_id = selected_stage1.id
      and job.status = 'completed'
      and job.disposition = 'active'
    order by job.source_completed_at, report.session_id;

    update public.stage2_code_refinement_runs
    set source_case_count = (
        select count(*)::integer
        from public.stage2_preliminary_code_case_jobs
        where run_id = new_run_id
    ), updated_at = now()
    where id = new_run_id;

    return new_run_id;
end;
$$;

create or replace function public.claim_next_stage2_code_refinement()
returns table (
    phase text, job_id uuid, run_id uuid, stage1_report_id uuid,
    preliminary_code_id uuid, provider text, model text,
    reasoning_effort text, analysis_version text, prompt_version text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    active_run public.stage2_code_refinement_runs%rowtype;
    case_job public.stage2_preliminary_code_case_jobs%rowtype;
    refinement_job public.stage2_refined_code_jobs%rowtype;
begin
    perform pg_advisory_xact_lock(hashtext('stage2_code_refinement_worker'));
    perform public.ensure_stage2_code_refinement_run();

    select * into active_run
    from public.stage2_code_refinement_runs
    where status in ('preliminary_coding', 'refining_codes')
    order by created_at
    limit 1
    for update;
    if active_run.id is null then return; end if;

    if active_run.status = 'preliminary_coding' then
        update public.stage2_preliminary_code_case_jobs
        set status = 'failed', lease_expires_at = null, next_retry_at = now(),
            last_error = coalesce(last_error, 'Worker lease expired; retry scheduled.'),
            updated_at = now()
        where run_id = active_run.id and status = 'processing'
          and lease_expires_at < now();

        if exists (
            select 1 from public.stage2_preliminary_code_case_jobs
            where run_id = active_run.id and status = 'processing'
              and lease_expires_at >= now()
        ) then return; end if;

        select * into case_job
        from public.stage2_preliminary_code_case_jobs
        where run_id = active_run.id and (
            status = 'pending' or (
                status = 'failed' and attempt_count < 3
                and coalesce(next_retry_at, '-infinity'::timestamptz) <= now()
            )
        )
        order by source_completed_at, session_id
        for update skip locked limit 1;

        if case_job.id is not null then
            update public.stage2_preliminary_code_case_jobs
            set status='processing', attempt_count=attempt_count+1,
                claimed_at=now(), lease_expires_at=now()+interval '12 minutes',
                next_retry_at=null, updated_at=now()
            where id=case_job.id;
            return query select 'preliminary_code', case_job.id, active_run.id,
                case_job.stage1_report_id, null::uuid, active_run.provider,
                active_run.model, active_run.reasoning_effort,
                active_run.analysis_version, active_run.prompt_version;
            return;
        end if;

        if exists (
            select 1 from public.stage2_preliminary_code_case_jobs
            where run_id=active_run.id and status='failed' and attempt_count < 3
        ) then return; end if;

        insert into public.stage2_refined_code_jobs (
            run_id, preliminary_code_id, source_completed_at, case_number, code_number
        )
        select active_run.id, code.id, case_job_row.source_completed_at,
               code.case_number, code.code_number
        from public.stage2_preliminary_codes as code
        join public.stage2_preliminary_code_case_jobs as case_job_row
          on case_job_row.id=code.case_job_id
        where code.run_id=active_run.id
        order by case_job_row.source_completed_at, code.case_number, code.code_number
        on conflict (preliminary_code_id) do nothing;

        update public.stage2_code_refinement_runs
        set status='refining_codes', updated_at=now()
        where id=active_run.id;
        active_run.status := 'refining_codes';
    end if;

    update public.stage2_refined_code_jobs
    set status='failed', lease_expires_at=null, next_retry_at=now(),
        last_error=coalesce(last_error, 'Worker lease expired; retry scheduled.'),
        updated_at=now()
    where run_id=active_run.id and status='processing' and lease_expires_at < now();

    if exists (
        select 1 from public.stage2_refined_code_jobs
        where run_id=active_run.id and status='processing' and lease_expires_at >= now()
    ) then return; end if;

    select * into refinement_job
    from public.stage2_refined_code_jobs
    where run_id=active_run.id and (
        status='pending' or (
            status='failed' and attempt_count < 3
            and coalesce(next_retry_at, '-infinity'::timestamptz) <= now()
        )
    )
    order by source_completed_at, case_number, code_number
    for update skip locked limit 1;

    if refinement_job.id is null then
        if not exists (
            select 1 from public.stage2_refined_code_jobs
            where run_id=active_run.id and (
                status='processing' or status='pending'
                or (status='failed' and attempt_count < 3)
            )
        ) then
            update public.stage2_code_refinement_runs
            set status=case when exists (
                    select 1 from public.stage2_refined_code_jobs
                    where run_id=active_run.id and status='failed'
                ) or exists (
                    select 1 from public.stage2_preliminary_code_case_jobs
                    where run_id=active_run.id and status='failed'
                ) then 'completed_with_failures' else 'completed' end,
                completed_at=now(), updated_at=now()
            where id=active_run.id;
        end if;
        return;
    end if;

    update public.stage2_refined_code_jobs
    set status='processing', attempt_count=attempt_count+1,
        claimed_at=now(), lease_expires_at=now()+interval '12 minutes',
        next_retry_at=null, updated_at=now()
    where id=refinement_job.id;
    return query select 'refined_code', refinement_job.id, active_run.id,
        null::uuid, refinement_job.preliminary_code_id, active_run.provider,
        active_run.model, active_run.reasoning_effort,
        active_run.analysis_version, active_run.prompt_version;
end;
$$;

create or replace function public.complete_stage2_preliminary_case(
    p_job_id uuid, p_payload jsonb, p_input_tokens integer, p_output_tokens integer
)
returns boolean language plpgsql security definer set search_path='' as $$
declare selected_job public.stage2_preliminary_code_case_jobs%rowtype;
    item jsonb; item_number integer; new_code_id uuid; mu_id_text text;
    inserted_evidence integer;
begin
    select * into selected_job from public.stage2_preliminary_code_case_jobs
    where id=p_job_id for update;
    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The Stage 2 preliminary-code job is not processing.';
    end if;
    for item, item_number in select value, ordinality::integer
        from jsonb_array_elements(p_payload->'preliminaryCodes') with ordinality
    loop
        insert into public.stage2_preliminary_codes (
            run_id, case_job_id, stage1_report_id, case_number, code_number,
            code_label, definition, rationale
        ) values (selected_job.run_id, selected_job.id, selected_job.stage1_report_id,
            selected_job.case_number, item_number, item->>'label',
            item->>'definition', item->>'rationale') returning id into new_code_id;
        for mu_id_text in select jsonb_array_elements_text(item->'meaningUnitIds') loop
            insert into public.stage2_preliminary_code_evidence (
                preliminary_code_id, meaning_unit_id
            )
            select new_code_id, unit.id
            from public.advanced_preliminary_meaning_units as unit
            where unit.id=mu_id_text::uuid
              and unit.report_id=selected_job.stage1_report_id;
            get diagnostics inserted_evidence = row_count;
            if inserted_evidence <> 1 then
                raise exception 'Meaning Unit evidence does not belong to the selected case.';
            end if;
        end loop;
    end loop;
    update public.stage2_preliminary_code_case_jobs
    set status='completed', completed_at=now(), lease_expires_at=null,
        last_error=null, input_token_count=p_input_tokens,
        output_token_count=p_output_tokens, updated_at=now()
    where id=selected_job.id;
    update public.stage2_code_refinement_runs
    set preliminary_completed_count=(select count(*)::integer
        from public.stage2_preliminary_code_case_jobs
        where run_id=selected_job.run_id and status='completed'),
        preliminary_failed_count=(select count(*)::integer
        from public.stage2_preliminary_code_case_jobs
        where run_id=selected_job.run_id and status='failed' and attempt_count>=3),
        updated_at=now()
    where id=selected_job.run_id;
    return true;
end; $$;

create or replace function public.complete_stage2_refined_code(
    p_job_id uuid, p_payload jsonb, p_model text,
    p_input_tokens integer, p_output_tokens integer
)
returns uuid language plpgsql security definer set search_path='' as $$
declare selected_job public.stage2_refined_code_jobs%rowtype;
    selected_code public.stage2_preliminary_codes%rowtype;
    refined_id uuid; next_number integer; selected_decision text;
begin
    select * into selected_job from public.stage2_refined_code_jobs
    where id=p_job_id for update;
    if selected_job.id is null or selected_job.status <> 'processing' then
        raise exception 'The Stage 2 refinement job is not processing.';
    end if;
    select * into selected_code from public.stage2_preliminary_codes
    where id=selected_job.preliminary_code_id;
    selected_decision := p_payload->>'decision';
    if selected_decision='equivalent' then
        refined_id := (p_payload->>'existingRefinedCodeId')::uuid;
        if not exists (select 1 from public.stage2_refined_codes
            where id=refined_id and run_id=selected_job.run_id) then
            raise exception 'The equivalent refined code does not belong to this run.';
        end if;
    elsif selected_decision='distinct' then
        select coalesce(max(refined_code_number),0)+1 into next_number
        from public.stage2_refined_codes where run_id=selected_job.run_id;
        insert into public.stage2_refined_codes (
            run_id, refined_code_number, refined_code_label, definition,
            created_from_preliminary_code_id
        ) values (selected_job.run_id, next_number, p_payload->>'refinedLabel',
            p_payload->>'refinedDefinition', selected_code.id)
        returning id into refined_id;
    else raise exception 'The refinement decision is invalid.';
    end if;
    insert into public.stage2_code_assignments (
        run_id, preliminary_code_id, refined_code_id, decision,
        semantic_rationale, model
    ) values (selected_job.run_id, selected_code.id, refined_id,
        selected_decision, p_payload->>'rationale', p_model);
    update public.stage2_refined_code_jobs
    set status='completed', completed_at=now(), lease_expires_at=null,
        last_error=null, input_token_count=p_input_tokens,
        output_token_count=p_output_tokens, updated_at=now()
    where id=selected_job.id;
    update public.stage2_code_refinement_runs
    set refinement_completed_count=(select count(*)::integer
        from public.stage2_refined_code_jobs
        where run_id=selected_job.run_id and status='completed'),
        refinement_failed_count=(select count(*)::integer
        from public.stage2_refined_code_jobs
        where run_id=selected_job.run_id and status='failed' and attempt_count>=3),
        updated_at=now()
    where id=selected_job.run_id;
    return refined_id;
end; $$;

create or replace function public.fail_stage2_code_refinement(
    p_phase text, p_job_id uuid, p_error text
)
returns void language plpgsql security definer set search_path='' as $$
begin
    if p_phase='preliminary_code' then
        update public.stage2_preliminary_code_case_jobs
        set status='failed', lease_expires_at=null,
            next_retry_at=case when attempt_count<3 then now()+interval '2 minutes' else null end,
            last_error=left(coalesce(p_error,'Unknown Stage 2 failure.'),5000), updated_at=now()
        where id=p_job_id;
        update public.stage2_code_refinement_runs as run
        set preliminary_failed_count=(select count(*)::integer
                from public.stage2_preliminary_code_case_jobs as failed_job
                where failed_job.run_id=run.id
                  and failed_job.status='failed' and failed_job.attempt_count>=3),
            updated_at=now()
        where id=(select failed_job.run_id
            from public.stage2_preliminary_code_case_jobs as failed_job
            where failed_job.id=p_job_id);
    elsif p_phase='refined_code' then
        update public.stage2_refined_code_jobs
        set status='failed', lease_expires_at=null,
            next_retry_at=case when attempt_count<3 then now()+interval '2 minutes' else null end,
            last_error=left(coalesce(p_error,'Unknown Stage 2 failure.'),5000), updated_at=now()
        where id=p_job_id;
        update public.stage2_code_refinement_runs as run
        set refinement_failed_count=(select count(*)::integer
                from public.stage2_refined_code_jobs as failed_job
                where failed_job.run_id=run.id
                  and failed_job.status='failed' and failed_job.attempt_count>=3),
            updated_at=now()
        where id=(select failed_job.run_id
            from public.stage2_refined_code_jobs as failed_job
            where failed_job.id=p_job_id);
    end if;
end; $$;

create or replace function public.get_stage2_refined_code_export(
    p_run_id uuid,
    p_offset integer default 0,
    p_limit integer default 1000
)
returns table (
    assignment_id uuid,
    case_number text,
    session_id text,
    stage1_report_id uuid,
    meaning_unit_id uuid,
    meaning_unit_number integer,
    message_id uuid,
    exact_source_text text,
    source_language text,
    preliminary_code_id uuid,
    preliminary_code_number integer,
    preliminary_code_label text,
    preliminary_code_definition text,
    preliminary_code_rationale text,
    refined_code_id uuid,
    refined_code_number integer,
    refined_code_label text,
    refined_code_definition text,
    semantic_decision text,
    semantic_rationale text,
    assignment_model text,
    assignment_created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select assignment.id, preliminary.case_number, case_job.session_id,
        preliminary.stage1_report_id, unit.id, unit.unit_number,
        unit.message_id, unit.exact_source_text, unit.source_language,
        preliminary.id, preliminary.code_number, preliminary.code_label,
        preliminary.definition, preliminary.rationale,
        refined.id, refined.refined_code_number, refined.refined_code_label,
        refined.definition, assignment.decision, assignment.semantic_rationale,
        assignment.model, assignment.created_at
    from public.stage2_code_assignments as assignment
    join public.stage2_preliminary_codes as preliminary
      on preliminary.id=assignment.preliminary_code_id
    join public.stage2_preliminary_code_case_jobs as case_job
      on case_job.id=preliminary.case_job_id
    join public.stage2_refined_codes as refined
      on refined.id=assignment.refined_code_id
    join public.stage2_preliminary_code_evidence as evidence
      on evidence.preliminary_code_id=preliminary.id
    join public.advanced_preliminary_meaning_units as unit
      on unit.id=evidence.meaning_unit_id
    where assignment.run_id=p_run_id
    order by case_job.source_completed_at, preliminary.case_number,
        preliminary.code_number, unit.unit_number
    offset greatest(coalesce(p_offset,0),0)
    limit least(greatest(coalesce(p_limit,1000),1),1000);
$$;

revoke all on function public.ensure_stage2_code_refinement_run() from public, anon, authenticated;
revoke all on function public.claim_next_stage2_code_refinement() from public, anon, authenticated;
revoke all on function public.complete_stage2_preliminary_case(uuid,jsonb,integer,integer) from public, anon, authenticated;
revoke all on function public.complete_stage2_refined_code(uuid,jsonb,text,integer,integer) from public, anon, authenticated;
revoke all on function public.fail_stage2_code_refinement(text,uuid,text) from public, anon, authenticated;
revoke all on function public.get_stage2_refined_code_export(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.ensure_stage2_code_refinement_run() to service_role;
grant execute on function public.claim_next_stage2_code_refinement() to service_role;
grant execute on function public.complete_stage2_preliminary_case(uuid,jsonb,integer,integer) to service_role;
grant execute on function public.complete_stage2_refined_code(uuid,jsonb,text,integer,integer) to service_role;
grant execute on function public.fail_stage2_code_refinement(text,uuid,text) to service_role;
grant execute on function public.get_stage2_refined_code_export(uuid,integer,integer) to service_role;
