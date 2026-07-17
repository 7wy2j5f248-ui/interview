alter table public.qualitative_analysis_items
add column ai_coded_phrases text[] not null default '{}';

alter table public.qualitative_analysis_items
add column researcher_coded_phrases text[] not null default '{}';

alter table public.qualitative_analysis_items
add column confirmed_coded_phrases text[] not null default '{}';

alter table public.qualitative_analysis_items
add constraint qualitative_analysis_items_id_run_key
unique (id, analysis_run_id);

create table public.qualitative_analysis_batches (
    id uuid primary key default gen_random_uuid(),
    analysis_run_id uuid not null
        references public.qualitative_analysis_runs(id) on delete restrict,
    batch_number integer not null,
    total_batches integer not null,
    session_count integer not null,
    message_count integer not null,
    input_token_count bigint,
    grouping_criteria jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint qualitative_analysis_batches_run_number_key
        unique (analysis_run_id, batch_number),
    constraint qualitative_analysis_batches_id_run_key
        unique (id, analysis_run_id),
    constraint qualitative_analysis_batches_number_valid
        check (
            batch_number > 0
            and total_batches > 0
            and batch_number <= total_batches
        ),
    constraint qualitative_analysis_batches_counts_valid
        check (
            session_count >= 0
            and message_count > 0
            and (
                input_token_count is null
                or input_token_count >= 0
            )
        ),
    constraint qualitative_analysis_batches_grouping_object
        check (jsonb_typeof(grouping_criteria) = 'object')
);

comment on table public.qualitative_analysis_batches is
    'Permanent, stably numbered computational batches within a frozen qualitative-analysis run.';

create table public.qualitative_analysis_batch_sessions (
    batch_id uuid not null
        references public.qualitative_analysis_batches(id) on delete restrict,
    session_id text not null,
    created_at timestamptz not null default now(),
    primary key (batch_id, session_id),
    constraint qualitative_analysis_batch_sessions_id_not_blank
        check (btrim(session_id) <> '')
);

comment on table public.qualitative_analysis_batch_sessions is
    'Frozen exact session membership for a computational analysis batch. Legacy identifiers remain valid even when no session metadata row exists.';

create table public.qualitative_analysis_batch_messages (
    batch_id uuid not null
        references public.qualitative_analysis_batches(id) on delete restrict,
    message_id uuid not null
        references public.interview_messages(id) on delete restrict,
    session_id text,
    created_at timestamptz not null default now(),
    primary key (batch_id, message_id),
    constraint qualitative_analysis_batch_messages_session_not_blank
        check (session_id is null or btrim(session_id) <> '')
);

comment on table public.qualitative_analysis_batch_messages is
    'Frozen exact transcript-message membership for a computational analysis batch.';

create table public.qualitative_analysis_item_batches (
    analysis_item_id uuid not null,
    batch_id uuid not null,
    analysis_run_id uuid not null,
    relationship_type text not null,
    created_at timestamptz not null default now(),
    primary key (analysis_item_id, batch_id),
    constraint qualitative_analysis_item_batches_item_run_fkey
        foreign key (analysis_item_id, analysis_run_id)
        references public.qualitative_analysis_items(id, analysis_run_id)
        on delete restrict,
    constraint qualitative_analysis_item_batches_batch_run_fkey
        foreign key (batch_id, analysis_run_id)
        references public.qualitative_analysis_batches(id, analysis_run_id)
        on delete restrict,
    constraint qualitative_analysis_item_batches_relationship_valid
        check (relationship_type in (
            'generated_from',
            'contributed_to',
            'synthesized_from'
        ))
);

comment on table public.qualitative_analysis_item_batches is
    'Many-to-many provenance between analytical items and every contributing computational batch.';

create table public.qualitative_analysis_suggestion_sources (
    id uuid primary key default gen_random_uuid(),
    analysis_item_id uuid not null,
    batch_id uuid not null,
    suggestion_type text not null,
    suggestion_value text not null,
    message_id uuid not null,
    created_at timestamptz not null default now(),
    constraint qualitative_analysis_suggestion_sources_item_batch_fkey
        foreign key (analysis_item_id, batch_id)
        references public.qualitative_analysis_item_batches(
            analysis_item_id,
            batch_id
        )
        on delete restrict,
    constraint qualitative_analysis_suggestion_sources_batch_message_fkey
        foreign key (batch_id, message_id)
        references public.qualitative_analysis_batch_messages(
            batch_id,
            message_id
        )
        on delete restrict,
    constraint qualitative_analysis_suggestion_sources_type_valid
        check (suggestion_type in (
            'theme',
            'code',
            'coded_phrase',
            'keyword'
        )),
    constraint qualitative_analysis_suggestion_sources_value_not_blank
        check (btrim(suggestion_value) <> ''),
    constraint qualitative_analysis_suggestion_sources_unique
        unique (
            analysis_item_id,
            batch_id,
            suggestion_type,
            suggestion_value,
            message_id
        )
);

comment on table public.qualitative_analysis_suggestion_sources is
    'Exact message-level provenance for each AI-suggested theme, code, coded phrase, and keyword.';

alter table public.qualitative_analysis_evidence
add column batch_id uuid;

alter table public.qualitative_analysis_evidence
add constraint qualitative_analysis_evidence_batch_message_fkey
foreign key (batch_id, message_id)
references public.qualitative_analysis_batch_messages(batch_id, message_id)
on delete restrict;

create or replace function public.create_ai_analysis_item_with_batch(
    p_analysis_run_id uuid,
    p_batch_id uuid,
    p_theme text,
    p_codes text[],
    p_coded_phrases text[],
    p_keywords text[],
    p_rationale text,
    p_evidence jsonb,
    p_suggestion_sources jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    analysis_item_id uuid;
    evidence_entry jsonb;
    source_entry jsonb;
begin
    if not exists (
        select 1
        from public.qualitative_analysis_batches
        where id = p_batch_id
          and analysis_run_id = p_analysis_run_id
    ) then
        raise exception 'The generating batch does not belong to the analysis run.';
    end if;

    if jsonb_typeof(p_evidence) <> 'array'
       or jsonb_array_length(p_evidence) = 0
       or jsonb_typeof(p_suggestion_sources) <> 'array'
       or jsonb_array_length(p_suggestion_sources) = 0 then
        raise exception 'AI analytical items require evidence and suggestion sources.';
    end if;

    insert into public.qualitative_analysis_items (
        analysis_run_id,
        origin,
        ai_theme,
        ai_codes,
        ai_coded_phrases,
        ai_keywords,
        ai_rationale,
        status
    ) values (
        p_analysis_run_id,
        'ai',
        p_theme,
        coalesce(p_codes, '{}'),
        coalesce(p_coded_phrases, '{}'),
        coalesce(p_keywords, '{}'),
        p_rationale,
        'ai_suggested'
    )
    returning id into analysis_item_id;

    insert into public.qualitative_analysis_item_batches (
        analysis_item_id,
        batch_id,
        analysis_run_id,
        relationship_type
    ) values (
        analysis_item_id,
        p_batch_id,
        p_analysis_run_id,
        'generated_from'
    );

    for evidence_entry in
        select value from jsonb_array_elements(p_evidence)
    loop
        insert into public.qualitative_analysis_evidence (
            analysis_item_id,
            batch_id,
            message_id,
            evidence_round,
            source,
            included,
            code_attributions
        ) values (
            analysis_item_id,
            p_batch_id,
            (evidence_entry ->> 'message_id')::uuid,
            0,
            'initial_ai',
            true,
            array(
                select jsonb_array_elements_text(
                    coalesce(evidence_entry -> 'codes', '[]'::jsonb)
                )
            )
        );
    end loop;

    for source_entry in
        select value from jsonb_array_elements(p_suggestion_sources)
    loop
        insert into public.qualitative_analysis_suggestion_sources (
            analysis_item_id,
            batch_id,
            suggestion_type,
            suggestion_value,
            message_id
        ) values (
            analysis_item_id,
            p_batch_id,
            source_entry ->> 'suggestion_type',
            source_entry ->> 'suggestion_value',
            (source_entry ->> 'message_id')::uuid
        );
    end loop;

    return analysis_item_id;
end;
$$;

revoke all on function public.create_ai_analysis_item_with_batch(
    uuid,
    uuid,
    text,
    text[],
    text[],
    text[],
    text,
    jsonb,
    jsonb
)
from public, anon, authenticated, service_role;

grant execute on function public.create_ai_analysis_item_with_batch(
    uuid,
    uuid,
    text,
    text[],
    text[],
    text[],
    text,
    jsonb,
    jsonb
)
to service_role;

insert into public.qualitative_analysis_batches (
    analysis_run_id,
    batch_number,
    total_batches,
    session_count,
    message_count,
    input_token_count,
    grouping_criteria
)
select
    links.analysis_run_id,
    links.batch_number,
    greatest(
        max(max(links.batch_number)) over (partition by links.analysis_run_id),
        max(max(runs.batches_used)) over (partition by links.analysis_run_id)
    ) as total_batches,
    count(distinct nullif(btrim(messages."Session"), '')) as session_count,
    count(*) as message_count,
    null,
    jsonb_build_object(
        'strategy', 'legacy_reconstructed',
        'source', 'qualitative_analysis_run_messages.batch_number',
        'legacy', true
    )
from public.qualitative_analysis_run_messages as links
join public.qualitative_analysis_runs as runs
    on runs.id = links.analysis_run_id
join public.interview_messages as messages
    on messages.id = links.message_id
group by
    links.analysis_run_id,
    links.batch_number;

insert into public.qualitative_analysis_batch_sessions (
    batch_id,
    session_id
)
select distinct
    batches.id,
    btrim(messages."Session")
from public.qualitative_analysis_batches as batches
join public.qualitative_analysis_run_messages as links
    on links.analysis_run_id = batches.analysis_run_id
   and links.batch_number = batches.batch_number
join public.interview_messages as messages
    on messages.id = links.message_id
where nullif(btrim(messages."Session"), '') is not null;

insert into public.qualitative_analysis_batch_messages (
    batch_id,
    message_id,
    session_id
)
select
    batches.id,
    links.message_id,
    nullif(btrim(messages."Session"), '')
from public.qualitative_analysis_batches as batches
join public.qualitative_analysis_run_messages as links
    on links.analysis_run_id = batches.analysis_run_id
   and links.batch_number = batches.batch_number
join public.interview_messages as messages
    on messages.id = links.message_id;

insert into public.qualitative_analysis_item_batches (
    analysis_item_id,
    batch_id,
    analysis_run_id,
    relationship_type
)
select distinct
    items.id,
    batches.id,
    items.analysis_run_id,
    'generated_from'
from public.qualitative_analysis_items as items
join public.qualitative_analysis_evidence as evidence
    on evidence.analysis_item_id = items.id
   and evidence.source = 'initial_ai'
join public.qualitative_analysis_batch_messages as batch_messages
    on batch_messages.message_id = evidence.message_id
join public.qualitative_analysis_batches as batches
    on batches.id = batch_messages.batch_id
   and batches.analysis_run_id = items.analysis_run_id
where items.origin = 'ai';

insert into public.qualitative_analysis_item_batches (
    analysis_item_id,
    batch_id,
    analysis_run_id,
    relationship_type
)
select distinct
    items.id,
    batches.id,
    items.analysis_run_id,
    'contributed_to'
from public.qualitative_analysis_items as items
join public.qualitative_analysis_evidence as evidence
    on evidence.analysis_item_id = items.id
   and evidence.source <> 'initial_ai'
join public.qualitative_analysis_batch_messages as batch_messages
    on batch_messages.message_id = evidence.message_id
join public.qualitative_analysis_batches as batches
    on batches.id = batch_messages.batch_id
   and batches.analysis_run_id = items.analysis_run_id
on conflict (analysis_item_id, batch_id) do nothing;

update public.qualitative_analysis_evidence as evidence
set batch_id = matched.batch_id
from (
    select
        evidence_link.id as evidence_id,
        min(batch_messages.batch_id::text)::uuid as batch_id
    from public.qualitative_analysis_evidence as evidence_link
    join public.qualitative_analysis_items as items
        on items.id = evidence_link.analysis_item_id
    join public.qualitative_analysis_batch_messages as batch_messages
        on batch_messages.message_id = evidence_link.message_id
    join public.qualitative_analysis_batches as batches
        on batches.id = batch_messages.batch_id
       and batches.analysis_run_id = items.analysis_run_id
    group by evidence_link.id
) as matched
where evidence.id = matched.evidence_id;

insert into public.qualitative_analysis_suggestion_sources (
    analysis_item_id,
    batch_id,
    suggestion_type,
    suggestion_value,
    message_id
)
select distinct
    items.id,
    evidence.batch_id,
    'theme',
    items.ai_theme,
    evidence.message_id
from public.qualitative_analysis_items as items
join public.qualitative_analysis_evidence as evidence
    on evidence.analysis_item_id = items.id
where items.origin = 'ai'
  and items.ai_theme is not null
  and btrim(items.ai_theme) <> ''
  and evidence.source = 'initial_ai'
  and evidence.batch_id is not null;

insert into public.qualitative_analysis_suggestion_sources (
    analysis_item_id,
    batch_id,
    suggestion_type,
    suggestion_value,
    message_id
)
select distinct
    items.id,
    evidence.batch_id,
    'code',
    code.value,
    evidence.message_id
from public.qualitative_analysis_items as items
join public.qualitative_analysis_evidence as evidence
    on evidence.analysis_item_id = items.id
cross join lateral unnest(evidence.code_attributions) as code(value)
where items.origin = 'ai'
  and evidence.source = 'initial_ai'
  and evidence.batch_id is not null
  and btrim(code.value) <> '';

create index qualitative_analysis_batches_run_idx
on public.qualitative_analysis_batches(analysis_run_id, batch_number);

create index qualitative_analysis_batch_sessions_session_idx
on public.qualitative_analysis_batch_sessions(session_id);

create index qualitative_analysis_batch_messages_message_idx
on public.qualitative_analysis_batch_messages(message_id);

create index qualitative_analysis_batch_messages_session_idx
on public.qualitative_analysis_batch_messages(session_id);

create index qualitative_analysis_item_batches_batch_idx
on public.qualitative_analysis_item_batches(batch_id);

create index qualitative_analysis_suggestion_sources_item_type_idx
on public.qualitative_analysis_suggestion_sources(
    analysis_item_id,
    suggestion_type
);

create index qualitative_analysis_suggestion_sources_message_idx
on public.qualitative_analysis_suggestion_sources(message_id);

create index qualitative_analysis_evidence_batch_idx
on public.qualitative_analysis_evidence(batch_id);

alter table public.qualitative_analysis_batches enable row level security;
alter table public.qualitative_analysis_batch_sessions enable row level security;
alter table public.qualitative_analysis_batch_messages enable row level security;
alter table public.qualitative_analysis_item_batches enable row level security;
alter table public.qualitative_analysis_suggestion_sources enable row level security;

revoke all on table public.qualitative_analysis_batches
from public, anon, authenticated, service_role;
revoke all on table public.qualitative_analysis_batch_sessions
from public, anon, authenticated, service_role;
revoke all on table public.qualitative_analysis_batch_messages
from public, anon, authenticated, service_role;
revoke all on table public.qualitative_analysis_item_batches
from public, anon, authenticated, service_role;
revoke all on table public.qualitative_analysis_suggestion_sources
from public, anon, authenticated, service_role;

grant select, insert on table public.qualitative_analysis_batches
to service_role;
grant update(input_token_count) on table public.qualitative_analysis_batches
to service_role;
grant select, insert on table public.qualitative_analysis_batch_sessions
to service_role;
grant select, insert on table public.qualitative_analysis_batch_messages
to service_role;
grant select, insert on table public.qualitative_analysis_item_batches
to service_role;
grant select, insert on table public.qualitative_analysis_suggestion_sources
to service_role;
