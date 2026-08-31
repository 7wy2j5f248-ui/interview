create table public.qualitative_case_meaning_units (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    unit_number integer not null,
    message_id uuid not null
        references public.interview_messages(id) on delete restrict,
    exact_text text not null,
    start_offset integer not null,
    end_offset integer not null,
    anchor_expressions jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    constraint qualitative_case_meaning_units_report_number_unique
        unique (report_id, unit_number),
    constraint qualitative_case_meaning_units_occurrence_unique
        unique (report_id, message_id, start_offset, end_offset),
    constraint qualitative_case_meaning_units_number_positive
        check (unit_number > 0),
    constraint qualitative_case_meaning_units_text_not_blank
        check (btrim(exact_text) <> ''),
    constraint qualitative_case_meaning_units_offsets_valid
        check (start_offset >= 0 and end_offset > start_offset),
    constraint qualitative_case_meaning_units_anchors_array
        check (jsonb_typeof(anchor_expressions) = 'array')
);

comment on table public.qualitative_case_meaning_units is
    'Exact coherent transcript passages. Boundaries follow meaning rather than punctuation; optional anchor expressions remain nested inside the highlighted passage.';

create index qualitative_case_meaning_units_message_idx
on public.qualitative_case_meaning_units(message_id, start_offset);

create table public.qualitative_case_code_meaning_units (
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    code_id uuid not null
        references public.qualitative_case_codes(id) on delete restrict,
    meaning_unit_id uuid not null
        references public.qualitative_case_meaning_units(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (code_id, meaning_unit_id)
);

create table public.qualitative_case_categories (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    category_number integer not null,
    category_label text not null,
    rationale text not null,
    created_at timestamptz not null default now(),
    constraint qualitative_case_categories_report_number_unique
        unique (report_id, category_number),
    constraint qualitative_case_categories_number_positive
        check (category_number > 0),
    constraint qualitative_case_categories_label_not_blank
        check (btrim(category_label) <> ''),
    constraint qualitative_case_categories_rationale_not_blank
        check (btrim(rationale) <> '')
);

create table public.qualitative_case_category_codes (
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    category_id uuid not null
        references public.qualitative_case_categories(id) on delete restrict,
    code_id uuid not null
        references public.qualitative_case_codes(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (category_id, code_id)
);

create table public.qualitative_case_theme_categories (
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    theme_id uuid not null
        references public.qualitative_case_themes(id) on delete restrict,
    category_id uuid not null
        references public.qualitative_case_categories(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (theme_id, category_id)
);

comment on table public.qualitative_case_categories is
    'Firm case-scoped descriptive groupings that answer what is being described across related common-vocabulary codes.';

comment on table public.qualitative_case_theme_categories is
    'Traceable category-to-theme links. Themes state the completed interpretive patterned meaning connecting categories.';

alter table public.qualitative_case_meaning_units enable row level security;
alter table public.qualitative_case_code_meaning_units enable row level security;
alter table public.qualitative_case_categories enable row level security;
alter table public.qualitative_case_category_codes enable row level security;
alter table public.qualitative_case_theme_categories enable row level security;

revoke all on table
    public.qualitative_case_meaning_units,
    public.qualitative_case_code_meaning_units,
    public.qualitative_case_categories,
    public.qualitative_case_category_codes,
    public.qualitative_case_theme_categories
from public, anon, authenticated;

grant select, insert on table
    public.qualitative_case_meaning_units,
    public.qualitative_case_code_meaning_units,
    public.qualitative_case_categories,
    public.qualitative_case_category_codes,
    public.qualitative_case_theme_categories
to service_role;

create or replace function public.persist_case_meaning_unit_category_hierarchy(
    p_report_id uuid,
    p_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    code_entry record;
    unit_entry record;
    category_entry record;
    theme_entry record;
    referenced_number integer;
    stored_code_id uuid;
    stored_unit_id uuid;
    stored_category_id uuid;
    stored_theme_id uuid;
    next_unit_number integer := 0;
    exact_match_count integer;
begin
    if jsonb_typeof(p_payload -> 'codes') <> 'array'
       or jsonb_array_length(p_payload -> 'codes') = 0
       or jsonb_typeof(p_payload -> 'categories') <> 'array'
       or jsonb_typeof(p_payload -> 'themes') <> 'array' then
        raise exception 'The meaning-unit/category hierarchy is incomplete.';
    end if;

    for code_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'codes') with ordinality
    loop
        select id into stored_code_id
        from public.qualitative_case_codes
        where report_id = p_report_id
          and code_number = code_entry.position;

        if stored_code_id is null
           or jsonb_typeof(code_entry.value -> 'meaningUnits') <> 'array'
           or jsonb_array_length(code_entry.value -> 'meaningUnits') = 0 then
            raise exception 'Every stored code requires at least one meaning unit.';
        end if;

        for unit_entry in
            select value
            from jsonb_array_elements(code_entry.value -> 'meaningUnits')
        loop
            select count(*) into exact_match_count
            from public.interview_messages as message
            join public.qualitative_case_reports as report
              on report.id = p_report_id
             and message."Session" = report.session_id
            where message.id = (unit_entry.value ->> 'messageId')::uuid
              and (unit_entry.value ->> 'startOffset')::integer >= 0
              and (unit_entry.value ->> 'endOffset')::integer
                    > (unit_entry.value ->> 'startOffset')::integer
              and substring(
                    message."Message"
                    from (unit_entry.value ->> 'startOffset')::integer + 1
                    for (unit_entry.value ->> 'endOffset')::integer
                        - (unit_entry.value ->> 'startOffset')::integer
                  ) = unit_entry.value ->> 'exactText';

            if exact_match_count <> 1 then
                raise exception 'A meaning unit is not an exact passage in the preserved case transcript.';
            end if;

            select id into stored_unit_id
            from public.qualitative_case_meaning_units
            where report_id = p_report_id
              and message_id = (unit_entry.value ->> 'messageId')::uuid
              and start_offset = (unit_entry.value ->> 'startOffset')::integer
              and end_offset = (unit_entry.value ->> 'endOffset')::integer;

            if stored_unit_id is null then
                next_unit_number := next_unit_number + 1;
                insert into public.qualitative_case_meaning_units (
                    report_id, unit_number, message_id, exact_text,
                    start_offset, end_offset, anchor_expressions
                ) values (
                    p_report_id,
                    next_unit_number,
                    (unit_entry.value ->> 'messageId')::uuid,
                    unit_entry.value ->> 'exactText',
                    (unit_entry.value ->> 'startOffset')::integer,
                    (unit_entry.value ->> 'endOffset')::integer,
                    coalesce(unit_entry.value -> 'anchors', '[]'::jsonb)
                ) returning id into stored_unit_id;
            end if;

            insert into public.qualitative_case_code_meaning_units (
                report_id, code_id, meaning_unit_id
            ) values (p_report_id, stored_code_id, stored_unit_id)
            on conflict (code_id, meaning_unit_id) do nothing;
        end loop;
    end loop;

    for category_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'categories') with ordinality
    loop
        if jsonb_typeof(category_entry.value -> 'codeNumbers') <> 'array'
           or jsonb_array_length(category_entry.value -> 'codeNumbers') < 2 then
            raise exception 'Every category requires at least two related codes.';
        end if;

        insert into public.qualitative_case_categories (
            report_id, category_number, category_label, rationale
        ) values (
            p_report_id,
            category_entry.position,
            category_entry.value ->> 'label',
            category_entry.value ->> 'rationale'
        ) returning id into stored_category_id;

        for referenced_number in
            select value::integer
            from jsonb_array_elements_text(category_entry.value -> 'codeNumbers')
        loop
            select id into stored_code_id
            from public.qualitative_case_codes
            where report_id = p_report_id
              and code_number = referenced_number;
            if stored_code_id is null then
                raise exception 'A category references an unavailable code number.';
            end if;
            insert into public.qualitative_case_category_codes (
                report_id, category_id, code_id
            ) values (p_report_id, stored_category_id, stored_code_id);
        end loop;
    end loop;

    for theme_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'themes') with ordinality
    loop
        if jsonb_typeof(theme_entry.value -> 'categoryNumbers') <> 'array'
           or jsonb_array_length(theme_entry.value -> 'categoryNumbers') < 2 then
            raise exception 'Every theme requires at least two supporting categories.';
        end if;

        select id into stored_theme_id
        from public.qualitative_case_themes
        where report_id = p_report_id
          and theme_number = theme_entry.position;
        if stored_theme_id is null then
            raise exception 'The stored theme was not found.';
        end if;

        for referenced_number in
            select value::integer
            from jsonb_array_elements_text(theme_entry.value -> 'categoryNumbers')
        loop
            select id into stored_category_id
            from public.qualitative_case_categories
            where report_id = p_report_id
              and category_number = referenced_number;
            if stored_category_id is null then
                raise exception 'A theme references an unavailable category number.';
            end if;
            insert into public.qualitative_case_theme_categories (
                report_id, theme_id, category_id
            ) values (p_report_id, stored_theme_id, stored_category_id);
        end loop;
    end loop;
end;
$function$;

revoke all on function public.persist_case_meaning_unit_category_hierarchy(
    uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_case_meaning_unit_category_hierarchy(
    uuid, jsonb
) to service_role;

create or replace function public.complete_automatic_case_analysis_v5(
    p_session_id text,
    p_model text,
    p_analysis_version text,
    p_input_token_count integer,
    p_payload jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    stored_report_id uuid;
begin
    stored_report_id := public.complete_automatic_case_analysis(
        p_session_id,
        p_model,
        p_analysis_version,
        p_input_token_count,
        p_payload
    );
    perform public.persist_case_meaning_unit_category_hierarchy(
        stored_report_id,
        p_payload
    );
    return stored_report_id;
end;
$function$;

revoke all on function public.complete_automatic_case_analysis_v5(
    text, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_automatic_case_analysis_v5(
    text, text, text, integer, jsonb
) to service_role;

alter table public.automatic_case_analysis_jobs
alter column analysis_version
set default 'case-analysis-v5-meaning-units-categories-completed';

update public.automatic_case_analysis_jobs
set analysis_version = 'case-analysis-v5-meaning-units-categories-completed',
    status = 'pending',
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = null,
    last_error = null,
    updated_at = now()
where archived_at is null;

alter table public.automatic_case_reanalysis_requests
drop constraint automatic_case_reanalysis_status_valid;

alter table public.automatic_case_reanalysis_requests
add constraint automatic_case_reanalysis_status_valid
check (status in (
    'queued', 'processing', 'proposal_ready', 'approved', 'rejected',
    'completed', 'failed', 'cancelled'
));

alter table public.automatic_case_reanalysis_requests
add column analysis_completed_at timestamptz;

comment on column public.automatic_case_reanalysis_requests.analysis_completed_at is
    'When PLI finished and published the feedback-driven analysis version. No researcher approval is part of automation.';

create or replace function public.complete_automatic_case_reanalysis(
    p_request_id uuid
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
    unit_entry record;
    theme_entry record;
    stored_code_id uuid;
    stored_theme_id uuid;
    referenced_code_number integer;
    invalid_unit_count integer;
begin
    select * into reanalysis_request
    from public.automatic_case_reanalysis_requests
    where id = p_request_id
    for update;

    if not found or reanalysis_request.status <> 'processing' then
        raise exception 'This feedback analysis is not processing.';
    end if;

    select * into proposal
    from public.automatic_case_reanalysis_proposals
    where request_id = p_request_id;

    if not found or proposal.source_report_id <> reanalysis_request.source_report_id then
        raise exception 'The completed analysis lineage does not match its source report.';
    end if;

    select * into source_report
    from public.qualitative_case_reports
    where id = reanalysis_request.source_report_id
      and session_id = reanalysis_request.session_id
      and superseded_at is null
    for update;

    if not found then
        raise exception 'The source report is no longer current.';
    end if;

    if jsonb_typeof(proposal.proposed_report -> 'codes') <> 'array'
       or jsonb_array_length(proposal.proposed_report -> 'codes') = 0
       or jsonb_typeof(proposal.proposed_report -> 'categories') <> 'array'
       or jsonb_typeof(proposal.proposed_report -> 'themes') <> 'array'
       or btrim(coalesce(proposal.proposed_report ->> 'caseInterpretation', '')) = '' then
        raise exception 'The feedback analysis result is incomplete.';
    end if;

    select count(*) into invalid_unit_count
    from jsonb_array_elements(proposal.proposed_report -> 'codes') as code(value)
    cross join lateral jsonb_array_elements(code.value -> 'meaningUnits') as unit(value)
    left join public.interview_messages as message
      on message.id = (unit.value ->> 'messageId')::uuid
     and message."Session" = reanalysis_request.session_id
    where message.id is null
       or (unit.value ->> 'startOffset')::integer < 0
       or (unit.value ->> 'endOffset')::integer
            <= (unit.value ->> 'startOffset')::integer
       or substring(
            message."Message"
            from (unit.value ->> 'startOffset')::integer + 1
            for (unit.value ->> 'endOffset')::integer
                - (unit.value ->> 'startOffset')::integer
          ) <> unit.value ->> 'exactText';

    if invalid_unit_count > 0 then
        raise exception 'The completed analysis contains a meaning unit that is not exact transcript evidence.';
    end if;

    insert into public.qualitative_case_reports (
        session_id, case_number, participant_id, participant_code, language,
        analysis_version, model, demographics, case_interpretation,
        source_completed_at, input_token_count, source_report_id,
        reanalysis_request_id, project_id, analysis_framework_id,
        analysis_hierarchy_audit
    ) values (
        source_report.session_id,
        source_report.case_number,
        source_report.participant_id,
        source_report.participant_code,
        source_report.language,
        proposal.proposal_version,
        proposal.model,
        coalesce(proposal.proposed_report -> 'demographics', source_report.demographics),
        proposal.proposed_report ->> 'caseInterpretation',
        source_report.source_completed_at,
        proposal.input_token_count,
        source_report.id,
        p_request_id,
        reanalysis_request.project_id,
        reanalysis_request.analysis_framework_id,
        coalesce(proposal.proposed_report -> 'analysisHierarchyAudit', '{}'::jsonb)
    ) returning id into stored_report_id;

    update public.qualitative_case_reports
    set superseded_reason =
        'Replaced by completed feedback analysis request '
        || p_request_id::text || '. Prior report retained for lineage.'
    where id = source_report.id;

    for code_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(proposal.proposed_report -> 'codes') with ordinality
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

        for unit_entry in
            select value, ordinality::integer as position
            from jsonb_array_elements(code_entry.value -> 'highlights') with ordinality
        loop
            insert into public.qualitative_case_keyword_highlights (
                report_id, code_id, keyword_number, message_id, exact_text,
                start_offset, end_offset
            ) values (
                stored_report_id,
                stored_code_id,
                unit_entry.position,
                (unit_entry.value ->> 'messageId')::uuid,
                unit_entry.value ->> 'exactText',
                (unit_entry.value ->> 'startOffset')::integer,
                (unit_entry.value ->> 'endOffset')::integer
            );
        end loop;
    end loop;

    for theme_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(proposal.proposed_report -> 'themes') with ordinality
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
            from jsonb_array_elements_text(theme_entry.value -> 'codeNumbers')
        loop
            select id into stored_code_id
            from public.qualitative_case_codes
            where report_id = stored_report_id
              and code_number = referenced_code_number;
            if stored_code_id is null then
                raise exception 'A theme references an unavailable code number.';
            end if;
            insert into public.qualitative_case_theme_codes (
                report_id, theme_id, code_id
            ) values (stored_report_id, stored_theme_id, stored_code_id);
        end loop;
    end loop;

    perform public.persist_case_meaning_unit_category_hierarchy(
        stored_report_id,
        proposal.proposed_report
    );

    update public.automatic_case_reanalysis_requests
    set status = 'completed',
        proposal_ready_at = now(),
        analysis_completed_at = now(),
        last_error = null
    where id = p_request_id;

    insert into public.automatic_case_reanalysis_events (
        request_id, event_type, actor, details
    ) values (
        p_request_id,
        'analysis_completed',
        'system',
        jsonb_build_object(
            'sourceReportId', source_report.id,
            'newReportId', stored_report_id,
            'relevanceCheckCount', jsonb_array_length(
                coalesce(proposal.relevance_audit -> 'checks', '[]'::jsonb)
            ),
            'labelQualityCheckCount', jsonb_array_length(
                coalesce(
                    proposal.relevance_audit #> '{labelQualityAudit,checks}',
                    '[]'::jsonb
                )
            ),
            'rejectedLabelCount', jsonb_array_length(
                coalesce(
                    proposal.relevance_audit #> '{labelQualityAudit,rejectedLabels}',
                    '[]'::jsonb
                )
            ),
            'researcherApprovalRequired', false,
            'feedbackStartsNewVersion', true
        )
    );

    return stored_report_id;
end;
$function$;

revoke all on function public.complete_automatic_case_reanalysis(uuid)
from public, anon, authenticated;
grant execute on function public.complete_automatic_case_reanalysis(uuid)
to service_role;

create or replace function public.sync_project_wide_reanalysis_batch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    batch_id_to_sync uuid := new.project_reanalysis_batch_id;
    queued_count integer;
    processing_count integer;
    completed_count integer;
    approved_count integer;
    rejected_count integer;
    failed_count integer;
    cancelled_count integer;
    total_count integer;
    cancellation_time timestamptz;
begin
    if batch_id_to_sync is null then return new; end if;

    select batch.cancellation_requested_at into cancellation_time
    from public.analysis_framework_reanalysis_batches as batch
    where batch.id = batch_id_to_sync;

    select
        count(*) filter (where request.status = 'queued')::integer,
        count(*) filter (where request.status = 'processing')::integer,
        count(*) filter (where request.status in ('completed', 'proposal_ready'))::integer,
        count(*) filter (where request.status = 'approved')::integer,
        count(*) filter (where request.status = 'rejected')::integer,
        count(*) filter (where request.status = 'failed')::integer,
        count(*) filter (where request.status = 'cancelled')::integer,
        count(*)::integer
    into queued_count, processing_count, completed_count,
         approved_count, rejected_count, failed_count, cancelled_count,
         total_count
    from public.automatic_case_reanalysis_requests as request
    where request.project_reanalysis_batch_id = batch_id_to_sync;

    update public.analysis_framework_reanalysis_batches as batch
    set queued_case_count = queued_count,
        processing_case_count = processing_count,
        proposal_ready_case_count = completed_count,
        approved_case_count = approved_count,
        rejected_case_count = rejected_count,
        failed_case_count = failed_count,
        cancelled_case_count = cancelled_count,
        status = case
            when cancellation_time is not null then 'cancelled'
            when total_count = 0 then 'empty'
            when processing_count > 0 then 'processing'
            when queued_count > 0 then 'queued'
            when failed_count > 0 then 'completed_with_failures'
            else 'completed'
        end,
        completed_at = case
            when cancellation_time is not null
              or total_count = 0
              or (queued_count = 0 and processing_count = 0)
            then coalesce(batch.completed_at, now())
            else null
        end,
        updated_at = now()
    where batch.id = batch_id_to_sync;

    return new;
end;
$function$;

comment on function public.sync_project_wide_reanalysis_batch() is
    'Marks autonomous feedback analysis complete when every case is terminal. Researcher approval is not part of automation.';
