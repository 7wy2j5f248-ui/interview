create table public.qualitative_analysis_runs (
    id uuid primary key default gen_random_uuid(),
    period_start timestamptz,
    period_end timestamptz,
    represented_languages text[] not null default '{}',
    completed_only boolean not null default false,
    status text not null default 'generating',
    model text not null,
    analysis_version text not null default 'task-014-v1',
    messages_analyzed integer not null default 0,
    sessions_analyzed integer not null default 0,
    batches_used integer not null default 0,
    skipped_records integer not null default 0,
    invalid_evidence_ids integer not null default 0,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    confirmed_at timestamptz,
    constraint qualitative_analysis_runs_period_valid
        check (
            period_start is null
            or period_end is null
            or period_start <= period_end
        ),
    constraint qualitative_analysis_runs_status_valid
        check (status in (
            'generating',
            'completed',
            'completed_with_errors',
            'failed',
            'archived'
        )),
    constraint qualitative_analysis_runs_counts_nonnegative
        check (
            messages_analyzed >= 0
            and sessions_analyzed >= 0
            and batches_used >= 0
            and skipped_records >= 0
            and invalid_evidence_ids >= 0
        )
);

comment on table public.qualitative_analysis_runs is
    'Durable, versioned AI-assisted qualitative-analysis runs for a researcher-selected corpus period.';

create table public.qualitative_analysis_run_messages (
    analysis_run_id uuid not null
        references public.qualitative_analysis_runs(id) on delete restrict,
    message_id uuid not null
        references public.interview_messages(id) on delete restrict,
    batch_number integer not null,
    created_at timestamptz not null default now(),
    primary key (analysis_run_id, message_id),
    constraint qualitative_analysis_run_messages_batch_positive
        check (batch_number > 0)
);

comment on table public.qualitative_analysis_run_messages is
    'Frozen participant-message membership for an analysis run and its model batch.';

create table public.qualitative_analysis_items (
    id uuid primary key default gen_random_uuid(),
    analysis_run_id uuid not null
        references public.qualitative_analysis_runs(id) on delete restrict,
    origin text not null,
    ai_theme text,
    ai_codes text[] not null default '{}',
    ai_keywords text[] not null default '{}',
    ai_rationale text,
    researcher_theme text,
    researcher_codes text[] not null default '{}',
    researcher_keywords text[] not null default '{}',
    researcher_note text,
    status text not null default 'ai_suggested',
    working_revision integer not null default 0,
    evidence_round integer not null default 0,
    confirmed_theme text,
    confirmed_codes text[] not null default '{}',
    confirmed_keywords text[] not null default '{}',
    confirmed_evidence_message_ids uuid[] not null default '{}',
    confirmed_note text,
    confirmed_working_revision integer,
    confirmed_at timestamptz,
    changed_since_confirmation boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint qualitative_analysis_items_origin_valid
        check (origin in ('ai', 'researcher')),
    constraint qualitative_analysis_items_ai_origin_consistent
        check (
            origin = 'researcher'
            or (ai_theme is not null and btrim(ai_theme) <> '')
        ),
    constraint qualitative_analysis_items_status_valid
        check (status in (
            'ai_suggested',
            'feedback_saved',
            'evidence_collected',
            'evidence_error',
            'confirmed',
            'archived'
        )),
    constraint qualitative_analysis_items_revisions_nonnegative
        check (
            working_revision >= 0
            and evidence_round >= 0
            and (
                confirmed_working_revision is null
                or confirmed_working_revision >= 0
            )
        ),
    constraint qualitative_analysis_items_confirmation_consistent
        check (
            (confirmed_at is null and confirmed_theme is null)
            or
            (
                confirmed_at is not null
                and confirmed_theme is not null
                and btrim(confirmed_theme) <> ''
                and confirmed_working_revision is not null
            )
        )
);

comment on table public.qualitative_analysis_items is
    'Immutable AI suggestions, editable researcher working state, and the latest confirmed analytical snapshot.';

create table public.qualitative_analysis_evidence (
    id uuid primary key default gen_random_uuid(),
    analysis_item_id uuid not null
        references public.qualitative_analysis_items(id) on delete restrict,
    message_id uuid not null
        references public.interview_messages(id) on delete restrict,
    evidence_round integer not null,
    source text not null,
    included boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint qualitative_analysis_evidence_round_nonnegative
        check (evidence_round >= 0),
    constraint qualitative_analysis_evidence_source_valid
        check (source in (
            'initial_ai',
            'feedback_ai',
            'researcher_manual'
        )),
    constraint qualitative_analysis_evidence_unique
        unique (analysis_item_id, message_id, evidence_round, source)
);

comment on table public.qualitative_analysis_evidence is
    'Versioned links from analytical items to exact participant messages; exclusion is soft and never deletes transcripts.';

create index qualitative_analysis_run_messages_message_id_idx
on public.qualitative_analysis_run_messages(message_id);

create index qualitative_analysis_items_run_status_idx
on public.qualitative_analysis_items(analysis_run_id, status);

create index qualitative_analysis_evidence_item_included_idx
on public.qualitative_analysis_evidence(analysis_item_id, included);

create index qualitative_analysis_evidence_message_id_idx
on public.qualitative_analysis_evidence(message_id);

alter table public.qualitative_analysis_runs enable row level security;
alter table public.qualitative_analysis_run_messages enable row level security;
alter table public.qualitative_analysis_items enable row level security;
alter table public.qualitative_analysis_evidence enable row level security;

revoke all on table public.qualitative_analysis_runs
from public, anon, authenticated;
revoke all on table public.qualitative_analysis_run_messages
from public, anon, authenticated;
revoke all on table public.qualitative_analysis_items
from public, anon, authenticated;
revoke all on table public.qualitative_analysis_evidence
from public, anon, authenticated;

grant select, insert, update on table public.qualitative_analysis_runs
to service_role;
grant select, insert on table public.qualitative_analysis_run_messages
to service_role;
grant select, insert, update on table public.qualitative_analysis_items
to service_role;
grant select, insert, update on table public.qualitative_analysis_evidence
to service_role;
