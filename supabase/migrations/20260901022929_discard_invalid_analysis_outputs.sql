create table if not exists public.invalid_analysis_deletion_events (
    id uuid primary key default gen_random_uuid(),
    reason text not null,
    deleted_corpus_run_count integer not null check (deleted_corpus_run_count >= 0),
    deleted_case_report_count integer not null check (deleted_case_report_count >= 0),
    deleted_advanced_run_count integer not null check (deleted_advanced_run_count >= 0),
    deleted_advanced_report_count integer not null check (deleted_advanced_report_count >= 0),
    deleted_reanalysis_request_count integer not null check (deleted_reanalysis_request_count >= 0),
    deleted_review_thread_count integer not null check (deleted_review_thread_count >= 0),
    cleared_ai_descriptor_row_count integer not null check (cleared_ai_descriptor_row_count >= 0),
    requeued_case_job_count integer not null check (requeued_case_job_count >= 0),
    source_session_count integer not null check (source_session_count >= 0),
    source_message_count integer not null check (source_message_count >= 0),
    source_translation_count integer not null check (source_translation_count >= 0),
    transcripts_preserved boolean not null default true
        check (transcripts_preserved),
    translations_preserved boolean not null default true
        check (translations_preserved),
    created_at timestamptz not null default now()
);

comment on table public.invalid_analysis_deletion_events is
    'Content-free audit counts for permanent deletion of invalid derived analysis. No deleted report text, labels, evidence, IDs, prompts, or model output are retained.';

alter table public.invalid_analysis_deletion_events enable row level security;
revoke all on table public.invalid_analysis_deletion_events
from public, anon, authenticated, service_role;
grant select on table public.invalid_analysis_deletion_events to service_role;

do $cleanup$
declare
    corpus_run_count integer;
    case_report_count integer;
    advanced_run_count integer;
    advanced_report_count integer;
    reanalysis_request_count integer;
    review_thread_count integer;
    ai_descriptor_row_count integer;
    case_job_count integer;
    source_session_count integer;
    source_message_count integer;
    source_translation_count integer;
    optional_cross_case_tables text;
begin
    select count(*) into corpus_run_count
    from public.qualitative_analysis_runs;
    select count(*) into case_report_count
    from public.qualitative_case_reports;
    select count(*) into advanced_run_count
    from public.advanced_preliminary_analysis_runs;
    select count(*) into advanced_report_count
    from public.advanced_preliminary_case_reports;
    select count(*) into reanalysis_request_count
    from public.automatic_case_reanalysis_requests;
    select count(*) into review_thread_count
    from public.automatic_analysis_review_threads;
    select count(*) into ai_descriptor_row_count
    from public.participant_descriptors as descriptor
    where exists (
        select 1
        from jsonb_each(descriptor.descriptor_sources) as source(key, value)
        where coalesce(source.value ->> 'extraction_method', '')
            ~ '^case-(analysis|reanalysis)-'
    );
    select count(*) into case_job_count
    from public.automatic_case_analysis_jobs;
    select count(*) into source_session_count
    from public.interview_sessions;
    select count(*) into source_message_count
    from public.interview_messages;
    select count(*) into source_translation_count
    from public.interview_messages
    where nullif(btrim("EnglishTranslation"), '') is not null;

    insert into public.invalid_analysis_deletion_events (
        reason,
        deleted_corpus_run_count,
        deleted_case_report_count,
        deleted_advanced_run_count,
        deleted_advanced_report_count,
        deleted_reanalysis_request_count,
        deleted_review_thread_count,
        cleared_ai_descriptor_row_count,
        requeued_case_job_count,
        source_session_count,
        source_message_count,
        source_translation_count
    ) values (
        'Invalid one-parent hierarchy rule made all testing-interview analysis unsuitable; researcher authorized permanent derived-output deletion and clean reanalysis.',
        corpus_run_count,
        case_report_count,
        advanced_run_count,
        advanced_report_count,
        reanalysis_request_count,
        review_thread_count,
        ai_descriptor_row_count,
        case_job_count,
        source_session_count,
        source_message_count,
        source_translation_count
    );

    truncate table
        public.advanced_preliminary_analysis_runs,
        public.qualitative_analysis_runs,
        public.qualitative_case_reports,
        public.analysis_framework_reanalysis_batches,
        public.automatic_analysis_review_messages,
        public.automatic_analysis_review_threads,
        public.automatic_analysis_review_workbook_imports,
        public.automatic_case_analysis_archive_events
    restart identity cascade;

    select string_agg(format('%I.%I', schemaname, tablename), ', ')
    into optional_cross_case_tables
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename in (
          'cross_case_code_refinement_assignments',
          'cross_case_code_refinement_buckets',
          'cross_case_code_refinement_evidence',
          'cross_case_code_refinement_runs',
          'cross_case_refined_codes'
      );

    if optional_cross_case_tables is not null then
        execute 'truncate table ' || optional_cross_case_tables
            || ' restart identity cascade';
    end if;

    update public.participant_descriptors as descriptor
    set
        current_country = case when coalesce(
            descriptor.descriptor_sources -> 'current_country'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.current_country end,
        current_region = case when coalesce(
            descriptor.descriptor_sources -> 'current_region'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.current_region end,
        country_of_origin = case when coalesce(
            descriptor.descriptor_sources -> 'country_of_origin'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.country_of_origin end,
        diaspora_status = case when coalesce(
            descriptor.descriptor_sources -> 'diaspora_status'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.diaspora_status end,
        gender = case when coalesce(
            descriptor.descriptor_sources -> 'gender'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.gender end,
        age = case when coalesce(
            descriptor.descriptor_sources -> 'age'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.age end,
        birth_year = case when coalesce(
            descriptor.descriptor_sources -> 'birth_year'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.birth_year end,
        birth_cohort = case when coalesce(
            descriptor.descriptor_sources -> 'birth_cohort'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.birth_cohort end,
        youth_status = case when coalesce(
            descriptor.descriptor_sources -> 'youth_status'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.youth_status end,
        education_level = case when coalesce(
            descriptor.descriptor_sources -> 'education_level'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.education_level end,
        social_identity = case when coalesce(
            descriptor.descriptor_sources -> 'social_identity'
                ->> 'extraction_method', ''
        ) ~ '^case-(analysis|reanalysis)-' then null
            else descriptor.social_identity end,
        additional_descriptors = (
            select coalesce(jsonb_object_agg(item.key, item.value), '{}'::jsonb)
            from jsonb_each(descriptor.additional_descriptors) as item(key, value)
            where coalesce(
                descriptor.descriptor_sources -> item.key
                    ->> 'extraction_method', ''
            ) !~ '^case-(analysis|reanalysis)-'
              and coalesce(
                descriptor.descriptor_sources
                    -> ('additional_descriptors.' || item.key)
                    ->> 'extraction_method', ''
              ) !~ '^case-(analysis|reanalysis)-'
        ),
        descriptor_sources = (
            select coalesce(jsonb_object_agg(source.key, source.value), '{}'::jsonb)
            from jsonb_each(descriptor.descriptor_sources) as source(key, value)
            where coalesce(source.value ->> 'extraction_method', '')
                !~ '^case-(analysis|reanalysis)-'
        ),
        updated_at = now()
    where exists (
        select 1
        from jsonb_each(descriptor.descriptor_sources) as source(key, value)
        where coalesce(source.value ->> 'extraction_method', '')
            ~ '^case-(analysis|reanalysis)-'
    );

    update public.automatic_case_analysis_jobs
    set
        analysis_version = 'case-analysis-v6-overlapping-hierarchy',
        status = 'pending',
        attempt_count = 0,
        queued_at = now(),
        claimed_at = null,
        lease_expires_at = null,
        next_retry_at = null,
        completed_at = null,
        last_error = null,
        archived_at = null,
        archived_by = null,
        archive_note = null,
        updated_at = now();
end;
$cleanup$;

alter table public.automatic_case_analysis_jobs
alter column analysis_version
set default 'case-analysis-v6-overlapping-hierarchy';

alter table public.advanced_preliminary_analysis_runs
alter column prior_analysis_role
set default 'transcript_only_no_prior_analysis';

comment on table public.advanced_preliminary_analysis_runs is
    'Versioned advanced preliminary analyses generated only from source transcripts and stored translations; invalid earlier analytical reports are neither retained nor used.';

comment on table public.advanced_preliminary_case_reports is
    'Transcript-grounded preliminary case-analysis reports ending at categories. New reports do not retain or reference discarded analysis.';

comment on column public.advanced_preliminary_analysis_jobs.source_report_id is
    'Deprecated compatibility column. New runs always store null because earlier analysis is not retained or used.';

comment on column public.advanced_preliminary_case_reports.source_report_id is
    'Deprecated compatibility column. New reports always store null because earlier analysis is not retained or used.';

create or replace function public.create_advanced_preliminary_analysis_run(
    p_provider text,
    p_model text,
    p_resolved_model text,
    p_reasoning_effort text,
    p_analysis_version text,
    p_prompt_version text,
    p_requested_by text default 'researcher'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_run_id uuid;
begin
    perform pg_advisory_xact_lock(hashtext('advanced_preliminary_analysis_run'));

    if exists (
        select 1 from public.advanced_preliminary_analysis_runs
        where status in ('queued', 'processing')
    ) then
        raise exception 'An advanced preliminary analysis run is already active.';
    end if;

    if btrim(coalesce(p_provider, '')) = ''
       or btrim(coalesce(p_model, '')) = ''
       or btrim(coalesce(p_resolved_model, '')) = ''
       or btrim(coalesce(p_analysis_version, '')) = ''
       or btrim(coalesce(p_prompt_version, '')) = '' then
        raise exception 'Model and version provenance are required.';
    end if;

    insert into public.advanced_preliminary_analysis_runs (
        provider, model, resolved_model, reasoning_effort,
        analysis_version, prompt_version, prior_analysis_role, requested_by,
        model_verified_at, project_snapshot
    )
    values (
        btrim(p_provider), btrim(p_model), btrim(p_resolved_model),
        p_reasoning_effort, btrim(p_analysis_version), btrim(p_prompt_version),
        'transcript_only_no_prior_analysis',
        coalesce(nullif(btrim(p_requested_by), ''), 'researcher'), now(),
        coalesce((
            select jsonb_agg(project_record order by project_record->>'project_name')
            from (
                select distinct jsonb_build_object(
                    'project_id', project.id,
                    'project_code', project.project_code,
                    'project_name', project.project_name,
                    'research_topic', project.research_topic
                ) as project_record
                from public.research_projects as project
                join public.research_designs as design
                  on design.project_id = project.id
                join public.interview_sessions as session
                  on session.research_design_id = design.id
                where session.completed = true
                  and session.completed_at is not null
            ) as projects
        ), '[]'::jsonb)
    )
    returning id into new_run_id;

    insert into public.advanced_preliminary_analysis_jobs (
        run_id, session_id, participant_id, case_number,
        source_completed_at, project_id, analysis_framework_id,
        source_report_id, project_binding_status
    )
    select
        new_run_id,
        session.session_id,
        session.participant_id,
        job.case_number,
        session.completed_at,
        job.project_id,
        job.analysis_framework_id,
        null,
        case when job.project_id is null
            then 'historical_unbound' else 'project_bound' end
    from public.interview_sessions as session
    join public.automatic_case_analysis_jobs as job
      on job.session_id = session.session_id
    where session.completed = true
      and session.completed_at is not null
    order by session.completed_at, session.session_id;

    update public.advanced_preliminary_analysis_runs
    set source_case_count = (
            select count(*) from public.advanced_preliminary_analysis_jobs
            where run_id = new_run_id
        ),
        pending_count = (
            select count(*) from public.advanced_preliminary_analysis_jobs
            where run_id = new_run_id and status = 'pending'
        ),
        updated_at = now()
    where id = new_run_id;

    return new_run_id;
end;
$$;
