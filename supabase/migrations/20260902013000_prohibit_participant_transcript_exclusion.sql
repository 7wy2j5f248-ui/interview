-- GOV-PART-001: participant contributions cannot be administratively excluded.
-- Preserve the prior mechanism as audit history, restore every affected job to
-- an included state, and make future exclusion dispositions impossible.

alter table public.advanced_preliminary_analysis_jobs
add column if not exists disposition_history jsonb not null default '[]'::jsonb;

alter table public.advanced_preliminary_analysis_jobs
drop constraint if exists advanced_preliminary_jobs_disposition_history_array;

alter table public.advanced_preliminary_analysis_jobs
add constraint advanced_preliminary_jobs_disposition_history_array
check (jsonb_typeof(disposition_history) = 'array');

update public.advanced_preliminary_analysis_jobs as job
set disposition_history = job.disposition_history || jsonb_build_array(
        jsonb_build_object(
            'priorDisposition', job.disposition,
            'priorReason', job.disposition_reason,
            'priorEvidence', job.disposition_evidence,
            'priorAt', job.disposition_at,
            'priorBy', job.disposition_by,
            'withdrawnAt', now(),
            'withdrawnBy', 'researcher-governance-GOV-PART-001',
            'withdrawalReason',
                'Participant and transcript exclusion is prohibited; system outcomes have no exclusion authority.'
        )
    ),
    disposition = 'active',
    disposition_reason = null,
    disposition_evidence = '{}'::jsonb,
    disposition_at = null,
    disposition_by = null,
    status = case when exists (
        select 1
        from public.advanced_preliminary_case_reports as report
        where report.job_id = job.id
    ) then 'completed' else 'pending' end,
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = case when exists (
        select 1
        from public.advanced_preliminary_case_reports as report
        where report.job_id = job.id
    ) then coalesce(
        job.completed_at,
        (
            select report.completed_at
            from public.advanced_preliminary_case_reports as report
            where report.job_id = job.id
            limit 1
        )
    ) else null end,
    last_error = null,
    updated_at = now()
where job.disposition <> 'active';

alter table public.advanced_preliminary_analysis_jobs
drop constraint if exists advanced_preliminary_analysis_jobs_disposition_valid;

alter table public.advanced_preliminary_analysis_jobs
add constraint advanced_preliminary_analysis_jobs_disposition_valid
check (disposition = 'active');

comment on column public.advanced_preliminary_analysis_jobs.disposition_history is
    'Append-only audit of withdrawn historical administrative dispositions. Entries have no authority over participant or transcript inclusion or processibility.';

create or replace function public.set_advanced_preliminary_case_disposition(
    p_job_id uuid,
    p_disposition text,
    p_reason text,
    p_actor text,
    p_evidence jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    raise exception using
        errcode = 'P0001',
        message = 'Participant or transcript exclusion is prohibited by GOV-PART-001. Record analysis and computational failures as system-owned attention states.';
end;
$$;

revoke all on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text, jsonb
) to service_role;

create or replace function public.set_advanced_preliminary_case_disposition(
    p_job_id uuid,
    p_disposition text,
    p_reason text,
    p_actor text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    raise exception using
        errcode = 'P0001',
        message = 'Participant or transcript exclusion is prohibited by GOV-PART-001. Record analysis and computational failures as system-owned attention states.';
end;
$$;

revoke all on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) to service_role;

do $$
declare
    selected_rules public.global_analysis_rules%rowtype;
    next_version integer;
    inserted_rule_id uuid;
begin
    lock table public.global_analysis_rules in share row exclusive mode;

    select rules.*
    into selected_rules
    from public.active_global_analysis_rules as active
    join public.global_analysis_rules as rules on rules.id = active.rule_id
    where active.singleton = true;

    if selected_rules.id is not null
       and position('GOV-PART-001' in selected_rules.rules_text) = 0 then
        select coalesce(max(rules.version_number), 0) + 1
        into next_version
        from public.global_analysis_rules as rules;

        insert into public.global_analysis_rules (
            version_number,
            predecessor_id,
            rules_text,
            version_notes,
            created_by
        ) values (
            next_version,
            selected_rules.id,
            'GOV-PART-001 — Human rights and each participant''s right to be heard take precedence over analytical, administrative, technical, and operational convenience. No participant transcript may be administratively excluded or permanently rendered non-processible. Participant contributions are research source material. AI outputs, model judgments, parsing, validation, numbering, evidence-link, persistence, database, and worker failures have no authority to disqualify a participant, classify a transcript as unusable, or remove it from future processing. Formal completion controls readiness for complete-case analysis only; incomplete sessions remain retained and reviewable as not ready yet. All computational failures are system-owned attention states with a reason, a retry or reprocessing path, and escalation to researchers or system experts when unresolved.'
                || E'\n\n'
                || selected_rules.rules_text,
            'Researcher-directed top global non-exclusion rule. Applies to future analysis and withdraws the prior administrative exclusion mechanism.',
            'researcher-governance-GOV-PART-001'
        ) returning id into inserted_rule_id;

        update public.active_global_analysis_rules
        set rule_id = inserted_rule_id,
            activated_at = now(),
            activated_by = 'researcher-governance-GOV-PART-001'
        where singleton = true;
    end if;
end;
$$;

do $$
declare
    selected_run record;
begin
    for selected_run in
        select distinct job.run_id
        from public.advanced_preliminary_analysis_jobs as job
    loop
        perform public.refresh_advanced_preliminary_analysis_run(selected_run.run_id);
    end loop;
end;
$$;
