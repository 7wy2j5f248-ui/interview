create table public.automatic_case_reanalysis_requests (
    id uuid primary key default gen_random_uuid(),
    session_id text not null
        references public.automatic_case_analysis_jobs(session_id)
        on delete restrict,
    source_report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    request_number integer not null,
    reason_code text not null,
    researcher_notes text not null,
    requested_by text not null default 'researcher',
    status text not null default 'queued',
    analysis_version text not null,
    model text,
    attempt_count integer not null default 0,
    requested_at timestamptz not null default now(),
    processing_started_at timestamptz,
    proposal_ready_at timestamptz,
    reviewed_at timestamptz,
    last_error text,
    constraint automatic_case_reanalysis_request_number_positive
        check (request_number > 0),
    constraint automatic_case_reanalysis_reason_valid
        check (reason_code in (
            'keywords_unrelated_to_theme',
            'evidence_theme_mismatch',
            'other'
        )),
    constraint automatic_case_reanalysis_notes_not_blank
        check (btrim(researcher_notes) <> ''),
    constraint automatic_case_reanalysis_status_valid
        check (status in (
            'queued', 'processing', 'proposal_ready',
            'approved', 'rejected', 'failed'
        )),
    constraint automatic_case_reanalysis_attempts_nonnegative
        check (attempt_count >= 0),
    constraint automatic_case_reanalysis_session_request_unique
        unique (session_id, request_number)
);

comment on table public.automatic_case_reanalysis_requests is
    'Researcher-authored, versioned requests to re-run one preserved individual case report. Requests never overwrite source reports.';

create unique index automatic_case_reanalysis_one_open_request_idx
on public.automatic_case_reanalysis_requests(session_id)
where status in ('queued', 'processing', 'proposal_ready');

create index automatic_case_reanalysis_source_report_idx
on public.automatic_case_reanalysis_requests(source_report_id);

create index automatic_case_reanalysis_status_time_idx
on public.automatic_case_reanalysis_requests(status, requested_at desc);

create table public.automatic_case_reanalysis_proposals (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null unique
        references public.automatic_case_reanalysis_requests(id)
        on delete restrict,
    source_report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    proposal_version text not null,
    model text not null,
    proposed_report jsonb not null,
    relevance_audit jsonb not null,
    source_quality_flags jsonb not null default '[]'::jsonb,
    input_token_count integer,
    created_at timestamptz not null default now(),
    constraint automatic_case_reanalysis_proposed_report_object
        check (jsonb_typeof(proposed_report) = 'object'),
    constraint automatic_case_reanalysis_audit_object
        check (jsonb_typeof(relevance_audit) = 'object'),
    constraint automatic_case_reanalysis_quality_flags_array
        check (jsonb_typeof(source_quality_flags) = 'array'),
    constraint automatic_case_reanalysis_input_tokens_positive
        check (input_token_count is null or input_token_count > 0)
);

comment on table public.automatic_case_reanalysis_proposals is
    'Immutable proposed replacement reports, semantic relevance checks, and source-quality flags awaiting explicit researcher review.';

create index automatic_case_reanalysis_proposal_source_idx
on public.automatic_case_reanalysis_proposals(source_report_id);

alter table public.qualitative_case_reports
add column source_report_id uuid
    references public.qualitative_case_reports(id) on delete restrict,
add column reanalysis_request_id uuid unique
    references public.automatic_case_reanalysis_requests(id)
    on delete restrict;

comment on column public.qualitative_case_reports.source_report_id is
    'The preserved report version from which this approved re-analysis was proposed.';

comment on column public.qualitative_case_reports.reanalysis_request_id is
    'The researcher request that authorized this report version; null for ordinary automatic reports.';

create index qualitative_case_reports_source_report_idx
on public.qualitative_case_reports(source_report_id)
where source_report_id is not null;

create table public.automatic_case_reanalysis_reviews (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null unique
        references public.automatic_case_reanalysis_requests(id)
        on delete restrict,
    proposal_id uuid not null unique
        references public.automatic_case_reanalysis_proposals(id)
        on delete restrict,
    decision text not null,
    reviewer_notes text,
    reviewed_by text not null default 'researcher',
    new_report_id uuid unique
        references public.qualitative_case_reports(id) on delete restrict,
    reviewed_at timestamptz not null default now(),
    constraint automatic_case_reanalysis_review_decision_valid
        check (decision in ('approved', 'rejected')),
    constraint automatic_case_reanalysis_review_report_matches_decision
        check (
            (decision = 'approved' and new_report_id is not null)
            or (decision = 'rejected' and new_report_id is null)
        )
);

comment on table public.automatic_case_reanalysis_reviews is
    'Explicit researcher approval or rejection of one preserved AI proposal.';

create table public.automatic_case_reanalysis_events (
    id bigint generated always as identity primary key,
    request_id uuid not null
        references public.automatic_case_reanalysis_requests(id)
        on delete restrict,
    event_type text not null,
    actor text not null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint automatic_case_reanalysis_event_type_not_blank
        check (btrim(event_type) <> ''),
    constraint automatic_case_reanalysis_event_actor_not_blank
        check (btrim(actor) <> ''),
    constraint automatic_case_reanalysis_event_details_object
        check (jsonb_typeof(details) = 'object')
);

comment on table public.automatic_case_reanalysis_events is
    'Append-only status and lineage log for every researcher re-analysis request.';

create index automatic_case_reanalysis_events_request_time_idx
on public.automatic_case_reanalysis_events(request_id, created_at);

create or replace function public.create_automatic_case_reanalysis_request(
    p_session_id text,
    p_reason_code text,
    p_researcher_notes text,
    p_analysis_version text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    job public.automatic_case_analysis_jobs%rowtype;
    active_report_id uuid;
    next_request_number integer;
    stored_request_id uuid;
begin
    select *
    into job
    from public.automatic_case_analysis_jobs
    where session_id = p_session_id
    for update;

    if not found or job.status <> 'completed' or job.archived_at is not null then
        raise exception 'Only an active completed case can be re-analysed.';
    end if;

    select id
    into active_report_id
    from public.qualitative_case_reports
    where session_id = p_session_id
      and superseded_at is null;

    if active_report_id is null then
        raise exception 'The active source report was not found.';
    end if;

    if p_reason_code not in (
        'keywords_unrelated_to_theme',
        'evidence_theme_mismatch',
        'other'
    ) or btrim(coalesce(p_researcher_notes, '')) = ''
       or btrim(coalesce(p_analysis_version, '')) = '' then
        raise exception 'A valid reason, notes, and analysis version are required.';
    end if;

    select coalesce(max(request_number), 0) + 1
    into next_request_number
    from public.automatic_case_reanalysis_requests
    where session_id = p_session_id;

    insert into public.automatic_case_reanalysis_requests (
        session_id,
        source_report_id,
        request_number,
        reason_code,
        researcher_notes,
        analysis_version
    ) values (
        p_session_id,
        active_report_id,
        next_request_number,
        p_reason_code,
        btrim(p_researcher_notes),
        p_analysis_version
    )
    returning id into stored_request_id;

    insert into public.automatic_case_reanalysis_events (
        request_id, event_type, actor, details
    ) values (
        stored_request_id,
        'requested',
        'researcher',
        jsonb_build_object(
            'sourceReportId', active_report_id,
            'reasonCode', p_reason_code,
            'researcherNotes', btrim(p_researcher_notes)
        )
    );

    return stored_request_id;
end;
$function$;

create or replace function public.review_automatic_case_reanalysis(
    p_request_id uuid,
    p_decision text,
    p_reviewer_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    reanalysis_request public.automatic_case_reanalysis_requests%rowtype;
    proposal public.automatic_case_reanalysis_proposals%rowtype;
    source_report public.qualitative_case_reports%rowtype;
    stored_report_id uuid;
    code_entry record;
    keyword_entry record;
    theme_entry record;
    stored_code_id uuid;
    stored_theme_id uuid;
    referenced_code_number integer;
    invalid_highlight_count integer;
begin
    if p_decision not in ('approved', 'rejected') then
        raise exception 'The review decision must be approved or rejected.';
    end if;

    select *
    into reanalysis_request
    from public.automatic_case_reanalysis_requests
    where id = p_request_id
    for update;

    if not found or reanalysis_request.status <> 'proposal_ready' then
        raise exception 'This re-analysis proposal is not awaiting review.';
    end if;

    select *
    into proposal
    from public.automatic_case_reanalysis_proposals
    where request_id = p_request_id;

    if not found or proposal.source_report_id <> reanalysis_request.source_report_id then
        raise exception 'The proposal lineage does not match its source report.';
    end if;

    if p_decision = 'rejected' then
        insert into public.automatic_case_reanalysis_reviews (
            request_id, proposal_id, decision, reviewer_notes
        ) values (
            p_request_id, proposal.id, 'rejected', nullif(btrim(p_reviewer_notes), '')
        );

        update public.automatic_case_reanalysis_requests
        set status = 'rejected', reviewed_at = now()
        where id = p_request_id;

        insert into public.automatic_case_reanalysis_events (
            request_id, event_type, actor, details
        ) values (
            p_request_id,
            'rejected',
            'researcher',
            jsonb_build_object('reviewerNotes', p_reviewer_notes)
        );

        return null;
    end if;

    select *
    into source_report
    from public.qualitative_case_reports
    where id = reanalysis_request.source_report_id
      and session_id = reanalysis_request.session_id
      and superseded_at is null
    for update;

    if not found then
        raise exception 'The source report is no longer current. Review the newer version first.';
    end if;

    if jsonb_typeof(proposal.proposed_report -> 'codes') <> 'array'
       or jsonb_array_length(proposal.proposed_report -> 'codes') = 0
       or jsonb_typeof(proposal.proposed_report -> 'themes') <> 'array'
       or jsonb_array_length(proposal.proposed_report -> 'themes') = 0
       or btrim(coalesce(proposal.proposed_report ->> 'caseInterpretation', '')) = '' then
        raise exception 'The proposed report is incomplete.';
    end if;

    select count(*)
    into invalid_highlight_count
    from jsonb_array_elements(proposal.proposed_report -> 'codes') as code(value)
    cross join lateral jsonb_array_elements(code.value -> 'highlights') as highlight(value)
    left join public.interview_messages as message
      on message.id = (highlight.value ->> 'messageId')::uuid
     and message."Session" = reanalysis_request.session_id
    where message.id is null
       or (highlight.value ->> 'startOffset')::integer < 0
       or (highlight.value ->> 'endOffset')::integer
            <= (highlight.value ->> 'startOffset')::integer
       or substring(
            message."Message"
            from (highlight.value ->> 'startOffset')::integer + 1
            for (highlight.value ->> 'endOffset')::integer
                - (highlight.value ->> 'startOffset')::integer
          ) <> highlight.value ->> 'exactText';

    if invalid_highlight_count > 0 then
        raise exception 'The proposal contains evidence that is not an exact occurrence in the preserved transcript.';
    end if;

    insert into public.qualitative_case_reports (
        session_id, case_number, participant_id, participant_code, language,
        analysis_version, model, demographics, case_interpretation,
        source_completed_at, input_token_count, source_report_id,
        reanalysis_request_id
    ) values (
        source_report.session_id,
        source_report.case_number,
        source_report.participant_id,
        source_report.participant_code,
        source_report.language,
        proposal.proposal_version,
        proposal.model,
        coalesce(
            proposal.proposed_report -> 'demographics',
            source_report.demographics
        ),
        proposal.proposed_report ->> 'caseInterpretation',
        source_report.source_completed_at,
        proposal.input_token_count,
        source_report.id,
        p_request_id
    )
    returning id into stored_report_id;

    update public.qualitative_case_reports
    set superseded_reason =
        'Replaced only after researcher approval of re-analysis request '
        || p_request_id::text || '. Prior report retained for lineage.'
    where id = source_report.id;

    for code_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(proposal.proposed_report -> 'codes')
             with ordinality
    loop
        insert into public.qualitative_case_codes (
            report_id, code_number, code_label, rationale, color_slot
        ) values (
            stored_report_id,
            code_entry.position,
            code_entry.value ->> 'label',
            code_entry.value ->> 'rationale',
            ((code_entry.position - 1) % 12) + 1
        ) returning id into stored_code_id;

        for keyword_entry in
            select value, ordinality::integer as position
            from jsonb_array_elements(code_entry.value -> 'highlights')
                 with ordinality
        loop
            insert into public.qualitative_case_keyword_highlights (
                report_id, code_id, keyword_number, message_id, exact_text,
                start_offset, end_offset
            ) values (
                stored_report_id,
                stored_code_id,
                keyword_entry.position,
                (keyword_entry.value ->> 'messageId')::uuid,
                keyword_entry.value ->> 'exactText',
                (keyword_entry.value ->> 'startOffset')::integer,
                (keyword_entry.value ->> 'endOffset')::integer
            );
        end loop;
    end loop;

    for theme_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(proposal.proposed_report -> 'themes')
             with ordinality
    loop
        insert into public.qualitative_case_themes (
            report_id, theme_number, theme_label, rationale
        ) values (
            stored_report_id,
            theme_entry.position,
            theme_entry.value ->> 'label',
            theme_entry.value ->> 'rationale'
        ) returning id into stored_theme_id;

        for referenced_code_number in
            select value::integer
            from jsonb_array_elements_text(
                theme_entry.value -> 'codeNumbers'
            )
        loop
            select id
            into stored_code_id
            from public.qualitative_case_codes
            where report_id = stored_report_id
              and code_number = referenced_code_number;

            if stored_code_id is null then
                raise exception 'A proposed theme references an unavailable code number.';
            end if;

            insert into public.qualitative_case_theme_codes (
                report_id, theme_id, code_id
            ) values (
                stored_report_id, stored_theme_id, stored_code_id
            );
        end loop;
    end loop;

    insert into public.automatic_case_reanalysis_reviews (
        request_id, proposal_id, decision, reviewer_notes, new_report_id
    ) values (
        p_request_id,
        proposal.id,
        'approved',
        nullif(btrim(p_reviewer_notes), ''),
        stored_report_id
    );

    update public.automatic_case_reanalysis_requests
    set status = 'approved', reviewed_at = now()
    where id = p_request_id;

    insert into public.automatic_case_reanalysis_events (
        request_id, event_type, actor, details
    ) values (
        p_request_id,
        'approved',
        'researcher',
        jsonb_build_object(
            'sourceReportId', source_report.id,
            'newReportId', stored_report_id,
            'reviewerNotes', p_reviewer_notes
        )
    );

    return stored_report_id;
end;
$function$;

alter table public.automatic_case_reanalysis_requests enable row level security;
alter table public.automatic_case_reanalysis_proposals enable row level security;
alter table public.automatic_case_reanalysis_reviews enable row level security;
alter table public.automatic_case_reanalysis_events enable row level security;

revoke all on table
    public.automatic_case_reanalysis_requests,
    public.automatic_case_reanalysis_proposals,
    public.automatic_case_reanalysis_reviews,
    public.automatic_case_reanalysis_events
from public, anon, authenticated;

grant select, insert, update on table
    public.automatic_case_reanalysis_requests
to service_role;
grant select, insert on table
    public.automatic_case_reanalysis_proposals,
    public.automatic_case_reanalysis_reviews,
    public.automatic_case_reanalysis_events
to service_role;
grant usage, select on sequence
    public.automatic_case_reanalysis_events_id_seq
to service_role;

revoke all on function public.create_automatic_case_reanalysis_request(
    text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_automatic_case_reanalysis_request(
    text, text, text, text
) to service_role;

revoke all on function public.review_automatic_case_reanalysis(
    uuid, text, text
) from public, anon, authenticated;
grant execute on function public.review_automatic_case_reanalysis(
    uuid, text, text
) to service_role;
