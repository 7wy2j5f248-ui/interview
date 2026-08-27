create table public.case_code_map (
    session_id text primary key
        references public.interview_sessions(session_id) on delete restrict,
    participant_id text not null,
    participant_code text not null,
    session_number integer not null,
    case_number text generated always as (
        participant_code || '-S' || lpad(session_number::text, 2, '0')
    ) stored unique,
    created_at timestamptz not null default now(),
    constraint case_code_map_session_number_positive
        check (session_number > 0),
    constraint case_code_map_participant_session_unique
        unique (participant_id, session_number),
    constraint case_code_map_participant_id_not_blank
        check (btrim(participant_id) <> ''),
    constraint case_code_map_participant_code_format
        check (participant_code ~ '^P[0-9]{4,}$')
);

comment on table public.case_code_map is
    'Private stable mapping from one completed interview session to a researcher-facing case number such as P0001-S01.';

create table public.automatic_case_analysis_jobs (
    session_id text primary key
        references public.case_code_map(session_id) on delete restrict,
    participant_id text not null,
    case_number text not null unique,
    source_completed_at timestamptz not null,
    analysis_version text not null
        default 'case-analysis-v1-keywords-codes-themes',
    status text not null default 'pending',
    attempt_count integer not null default 0,
    queued_at timestamptz not null default now(),
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    next_retry_at timestamptz,
    completed_at timestamptz,
    last_error text,
    updated_at timestamptz not null default now(),
    constraint automatic_case_analysis_jobs_status_valid
        check (status in ('pending', 'processing', 'completed', 'failed')),
    constraint automatic_case_analysis_jobs_attempts_nonnegative
        check (attempt_count >= 0),
    constraint automatic_case_analysis_jobs_participant_not_blank
        check (btrim(participant_id) <> ''),
    constraint automatic_case_analysis_jobs_case_not_blank
        check (btrim(case_number) <> ''),
    constraint automatic_case_analysis_jobs_version_not_blank
        check (btrim(analysis_version) <> '')
);

comment on table public.automatic_case_analysis_jobs is
    'Durable FIFO work record created automatically for every formally completed interview session.';

create index automatic_case_analysis_jobs_fifo_idx
on public.automatic_case_analysis_jobs (
    status,
    source_completed_at,
    queued_at,
    session_id
);

create table public.qualitative_case_reports (
    id uuid primary key default gen_random_uuid(),
    session_id text not null unique
        references public.automatic_case_analysis_jobs(session_id)
        on delete restrict,
    case_number text not null unique,
    participant_id text not null,
    participant_code text not null,
    language text,
    analysis_version text not null,
    model text not null,
    demographics jsonb not null default '{}'::jsonb,
    case_interpretation text not null,
    source_completed_at timestamptz not null,
    input_token_count integer,
    created_at timestamptz not null default now(),
    completed_at timestamptz not null default now(),
    constraint qualitative_case_reports_demographics_object
        check (jsonb_typeof(demographics) = 'object'),
    constraint qualitative_case_reports_interpretation_not_blank
        check (btrim(case_interpretation) <> ''),
    constraint qualitative_case_reports_input_tokens_positive
        check (input_token_count is null or input_token_count > 0)
);

comment on table public.qualitative_case_reports is
    'One atomic, automatically generated individual case report per formally completed transcript.';

create table public.qualitative_case_codes (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    code_number integer not null,
    code_label text not null,
    rationale text not null,
    color_slot integer not null,
    created_at timestamptz not null default now(),
    constraint qualitative_case_codes_report_number_unique
        unique (report_id, code_number),
    constraint qualitative_case_codes_number_positive
        check (code_number > 0),
    constraint qualitative_case_codes_label_not_blank
        check (btrim(code_label) <> ''),
    constraint qualitative_case_codes_rationale_not_blank
        check (btrim(rationale) <> ''),
    constraint qualitative_case_codes_color_positive
        check (color_slot > 0)
);

create table public.qualitative_case_keyword_highlights (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    code_id uuid not null
        references public.qualitative_case_codes(id) on delete restrict,
    keyword_number integer not null,
    message_id uuid not null
        references public.interview_messages(id) on delete restrict,
    exact_text text not null,
    start_offset integer not null,
    end_offset integer not null,
    created_at timestamptz not null default now(),
    constraint qualitative_case_highlights_code_number_unique
        unique (code_id, keyword_number),
    constraint qualitative_case_highlights_number_positive
        check (keyword_number > 0),
    constraint qualitative_case_highlights_exact_not_blank
        check (btrim(exact_text) <> ''),
    constraint qualitative_case_highlights_offsets_valid
        check (start_offset >= 0 and end_offset > start_offset)
);

create index qualitative_case_highlights_message_idx
on public.qualitative_case_keyword_highlights(message_id, start_offset);

create table public.qualitative_case_themes (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    theme_number integer not null,
    theme_label text not null,
    rationale text not null,
    created_at timestamptz not null default now(),
    constraint qualitative_case_themes_report_number_unique
        unique (report_id, theme_number),
    constraint qualitative_case_themes_number_positive
        check (theme_number > 0),
    constraint qualitative_case_themes_label_not_blank
        check (btrim(theme_label) <> ''),
    constraint qualitative_case_themes_rationale_not_blank
        check (btrim(rationale) <> '')
);

create table public.qualitative_case_theme_codes (
    report_id uuid not null
        references public.qualitative_case_reports(id) on delete restrict,
    theme_id uuid not null
        references public.qualitative_case_themes(id) on delete restrict,
    code_id uuid not null
        references public.qualitative_case_codes(id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (theme_id, code_id)
);

with ranked_sessions as (
    select
        session.session_id,
        session.participant_id,
        codes.participant_code,
        row_number() over (
            partition by session.participant_id
            order by
                session.completed_at,
                session.created_at,
                session.session_id
        ) as session_number
    from public.interview_sessions as session
    join public.participant_code_map as codes
      on codes.participant_id = session.participant_id
    where session.completed = true
      and session.completed_at is not null
)
insert into public.case_code_map (
    session_id,
    participant_id,
    participant_code,
    session_number
)
select
    session_id,
    participant_id,
    participant_code,
    session_number
from ranked_sessions
order by participant_code, session_number
on conflict (session_id) do nothing;

insert into public.automatic_case_analysis_jobs (
    session_id,
    participant_id,
    case_number,
    source_completed_at,
    queued_at
)
select
    session.session_id,
    session.participant_id,
    cases.case_number,
    session.completed_at,
    session.completed_at
from public.interview_sessions as session
join public.case_code_map as cases
  on cases.session_id = session.session_id
where session.completed = true
  and session.completed_at is not null
order by session.completed_at, session.session_id
on conflict (session_id) do nothing;

create or replace function public.enqueue_completed_case_analysis()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
    stored_participant_code text;
    next_session_number integer;
    stored_case_number text;
begin
    if new.completed is not true or new.completed_at is null then
        return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.participant_id, 0));

    insert into public.participant_code_map (participant_id)
    values (new.participant_id)
    on conflict (participant_id) do nothing;

    select participant_code
    into stored_participant_code
    from public.participant_code_map
    where participant_id = new.participant_id;

    select coalesce(max(session_number), 0) + 1
    into next_session_number
    from public.case_code_map
    where participant_id = new.participant_id;

    insert into public.case_code_map (
        session_id,
        participant_id,
        participant_code,
        session_number
    ) values (
        new.session_id,
        new.participant_id,
        stored_participant_code,
        next_session_number
    )
    on conflict (session_id) do nothing;

    select case_number
    into stored_case_number
    from public.case_code_map
    where session_id = new.session_id;

    insert into public.automatic_case_analysis_jobs (
        session_id,
        participant_id,
        case_number,
        source_completed_at,
        queued_at
    ) values (
        new.session_id,
        new.participant_id,
        stored_case_number,
        new.completed_at,
        new.completed_at
    )
    on conflict (session_id) do nothing;

    return new;
end;
$$;

revoke all on function public.enqueue_completed_case_analysis()
from public, anon, authenticated, service_role;

create trigger interview_sessions_enqueue_case_analysis
after insert or update of completed, completed_at
on public.interview_sessions
for each row
when (new.completed = true)
execute function public.enqueue_completed_case_analysis();

create or replace function public.claim_next_automatic_case_analysis(
    p_analysis_version text
)
returns table (
    session_id text,
    participant_id text,
    case_number text,
    source_completed_at timestamptz,
    attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
    -- Serialize claims so concurrent wake-ups cannot skip ahead to a later
    -- case while the earliest case is being claimed.
    perform pg_advisory_xact_lock(hashtextextended(
        'automatic_case_analysis_fifo',
        0
    ));

    return query
    with candidate as (
        select job.session_id
        from public.automatic_case_analysis_jobs as job
        where job.analysis_version = p_analysis_version
          and job.status <> 'completed'
        order by
            job.source_completed_at,
            job.queued_at,
            job.session_id
        for update
        limit 1
    )
    update public.automatic_case_analysis_jobs as job
    set
        status = 'processing',
        attempt_count = job.attempt_count + 1,
        claimed_at = now(),
        lease_expires_at = now() + interval '10 minutes',
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    from candidate
    where job.session_id = candidate.session_id
      and (
              job.status = 'pending'
              and coalesce(job.next_retry_at, now()) <= now()
              or (
                  job.status = 'failed'
                  and job.attempt_count < 5
                  and coalesce(job.next_retry_at, now()) <= now()
              )
              or (
                  job.status = 'processing'
                  and coalesce(job.lease_expires_at, now()) <= now()
              )
          )
    returning
        job.session_id,
        job.participant_id,
        job.case_number,
        job.source_completed_at,
        job.attempt_count;
end;
$$;

revoke all on function public.claim_next_automatic_case_analysis(text)
from public, anon, authenticated;
grant execute on function public.claim_next_automatic_case_analysis(text)
to service_role;

create or replace function public.fail_automatic_case_analysis(
    p_session_id text,
    p_error text,
    p_retryable boolean default true
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    update public.automatic_case_analysis_jobs
    set
        status = case
            when p_retryable and attempt_count < 5 then 'pending'
            else 'failed'
        end,
        next_retry_at = case
            when p_retryable and attempt_count < 5
                then now() + make_interval(
                    secs => least(60, greatest(5, attempt_count * 10))
                )
            else null
        end,
        lease_expires_at = null,
        last_error = left(coalesce(p_error, 'Unknown error'), 2000),
        updated_at = now()
    where session_id = p_session_id
      and status = 'processing';
end;
$$;

revoke all on function public.fail_automatic_case_analysis(text, text, boolean)
from public, anon, authenticated;
grant execute on function public.fail_automatic_case_analysis(text, text, boolean)
to service_role;

create or replace function public.complete_automatic_case_analysis(
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
as $$
declare
    job public.automatic_case_analysis_jobs%rowtype;
    stored_report_id uuid;
    code_entry record;
    keyword_entry record;
    theme_entry record;
    code_id uuid;
    theme_id uuid;
    referenced_code_number integer;
begin
    select *
    into job
    from public.automatic_case_analysis_jobs
    where session_id = p_session_id
    for update;

    if not found
       or job.status <> 'processing'
       or job.analysis_version <> p_analysis_version then
        raise exception 'Automatic case job is not claimable for completion.';
    end if;

    if jsonb_typeof(p_payload -> 'codes') <> 'array'
       or jsonb_array_length(p_payload -> 'codes') = 0
       or jsonb_typeof(p_payload -> 'themes') <> 'array'
       or jsonb_array_length(p_payload -> 'themes') = 0 then
        raise exception 'Automatic case report is incomplete.';
    end if;

    insert into public.qualitative_case_reports (
        session_id,
        case_number,
        participant_id,
        participant_code,
        language,
        analysis_version,
        model,
        demographics,
        case_interpretation,
        source_completed_at,
        input_token_count
    ) values (
        job.session_id,
        job.case_number,
        job.participant_id,
        p_payload ->> 'participantCode',
        nullif(p_payload ->> 'language', ''),
        p_analysis_version,
        p_model,
        coalesce(p_payload -> 'demographics', '{}'::jsonb),
        p_payload ->> 'caseInterpretation',
        job.source_completed_at,
        p_input_token_count
    )
    returning id into stored_report_id;

    for code_entry in
        select value, ordinality::integer as position
        from jsonb_array_elements(p_payload -> 'codes')
             with ordinality
    loop
        insert into public.qualitative_case_codes (
            report_id,
            code_number,
            code_label,
            rationale,
            color_slot
        ) values (
            stored_report_id,
            code_entry.position,
            code_entry.value ->> 'label',
            code_entry.value ->> 'rationale',
            ((code_entry.position - 1) % 12) + 1
        )
        returning id into code_id;

        for keyword_entry in
            select value, ordinality::integer as position
            from jsonb_array_elements(code_entry.value -> 'highlights')
                 with ordinality
        loop
            insert into public.qualitative_case_keyword_highlights (
                report_id,
                code_id,
                keyword_number,
                message_id,
                exact_text,
                start_offset,
                end_offset
            ) values (
                stored_report_id,
                code_id,
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
        from jsonb_array_elements(p_payload -> 'themes')
             with ordinality
    loop
        insert into public.qualitative_case_themes (
            report_id,
            theme_number,
            theme_label,
            rationale
        ) values (
            stored_report_id,
            theme_entry.position,
            theme_entry.value ->> 'label',
            theme_entry.value ->> 'rationale'
        )
        returning id into theme_id;

        for referenced_code_number in
            select value::integer
            from jsonb_array_elements_text(
                theme_entry.value -> 'codeNumbers'
            )
        loop
            select id
            into code_id
            from public.qualitative_case_codes
            where report_id = stored_report_id
              and code_number = referenced_code_number;

            if code_id is null then
                raise exception 'Theme references an unavailable code number.';
            end if;

            insert into public.qualitative_case_theme_codes (
                report_id,
                theme_id,
                code_id
            ) values (
                stored_report_id,
                theme_id,
                code_id
            );
        end loop;
    end loop;

    update public.automatic_case_analysis_jobs
    set
        status = 'completed',
        completed_at = now(),
        lease_expires_at = null,
        next_retry_at = null,
        last_error = null,
        updated_at = now()
    where session_id = p_session_id;

    return stored_report_id;
end;
$$;

revoke all on function public.complete_automatic_case_analysis(
    text, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_automatic_case_analysis(
    text, text, text, integer, jsonb
) to service_role;

alter table public.case_code_map enable row level security;
alter table public.automatic_case_analysis_jobs enable row level security;
alter table public.qualitative_case_reports enable row level security;
alter table public.qualitative_case_codes enable row level security;
alter table public.qualitative_case_keyword_highlights enable row level security;
alter table public.qualitative_case_themes enable row level security;
alter table public.qualitative_case_theme_codes enable row level security;

revoke all on table
    public.case_code_map,
    public.automatic_case_analysis_jobs,
    public.qualitative_case_reports,
    public.qualitative_case_codes,
    public.qualitative_case_keyword_highlights,
    public.qualitative_case_themes,
    public.qualitative_case_theme_codes
from public, anon, authenticated, service_role;

grant select, insert on table public.case_code_map to service_role;
grant select, insert, update on table public.automatic_case_analysis_jobs
to service_role;
grant select, insert on table
    public.qualitative_case_reports,
    public.qualitative_case_codes,
    public.qualitative_case_keyword_highlights,
    public.qualitative_case_themes,
    public.qualitative_case_theme_codes
to service_role;
