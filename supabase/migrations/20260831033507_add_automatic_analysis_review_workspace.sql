create table public.automatic_analysis_review_workbook_imports (
    id uuid primary key default gen_random_uuid(),
    source_filename text not null,
    source_size_bytes integer not null,
    file_sha256 text not null,
    workbook_format_version text not null
        default 'automatic-review-workbook-v1',
    sheet_manifest jsonb not null default '[]'::jsonb,
    case_index jsonb not null default '{}'::jsonb,
    workbook_snapshot jsonb not null default '{}'::jsonb,
    imported_by text not null default 'researcher',
    imported_at timestamptz not null default now(),
    constraint automatic_analysis_review_workbook_filename_not_blank
        check (btrim(source_filename) <> ''),
    constraint automatic_analysis_review_workbook_size_positive
        check (source_size_bytes > 0),
    constraint automatic_analysis_review_workbook_sha256_valid
        check (file_sha256 ~ '^[0-9a-f]{64}$'),
    constraint automatic_analysis_review_workbook_version_not_blank
        check (btrim(workbook_format_version) <> ''),
    constraint automatic_analysis_review_workbook_json_types
        check (
            jsonb_typeof(sheet_manifest) = 'array'
            and jsonb_typeof(case_index) = 'object'
            and jsonb_typeof(workbook_snapshot) = 'object'
        ),
    constraint automatic_analysis_review_workbook_unique_file
        unique (file_sha256)
);

comment on table public.automatic_analysis_review_workbook_imports is
    'Append-only researcher workbook uploads for automatic case-analysis review. Parsed workbook structure, row order, hidden columns, case references, filename, timestamp, and file hash are preserved without changing source case reports.';

create index automatic_analysis_review_workbook_imports_time_idx
on public.automatic_analysis_review_workbook_imports (imported_at desc);

create table public.automatic_analysis_review_threads (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    workbook_import_id uuid
        references public.automatic_analysis_review_workbook_imports(id)
        on delete restrict,
    created_by text not null default 'researcher',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automatic_analysis_review_threads_title_not_blank
        check (btrim(title) <> '')
);

comment on table public.automatic_analysis_review_threads is
    'Persistent second-layer qualitative-analysis discussions linked to an optional researcher workbook decision layer.';

create index automatic_analysis_review_threads_updated_idx
on public.automatic_analysis_review_threads (updated_at desc);

create table public.automatic_analysis_review_messages (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null
        references public.automatic_analysis_review_threads(id)
        on delete restrict,
    role text not null,
    content text not null,
    selected_sources jsonb not null default '[]'::jsonb,
    provenance jsonb not null default '{}'::jsonb,
    model text,
    created_at timestamptz not null default now(),
    constraint automatic_analysis_review_messages_role_valid
        check (role in ('researcher', 'assistant')),
    constraint automatic_analysis_review_messages_content_not_blank
        check (btrim(content) <> ''),
    constraint automatic_analysis_review_messages_json_types
        check (
            jsonb_typeof(selected_sources) = 'array'
            and jsonb_typeof(provenance) = 'object'
        )
);

comment on table public.automatic_analysis_review_messages is
    'Append-only researcher and AI discussion messages with the exact participant, case, theme/code position, workbook layer, model, and evidence provenance used for each turn.';

create index automatic_analysis_review_messages_thread_time_idx
on public.automatic_analysis_review_messages (thread_id, created_at);

alter table public.automatic_analysis_review_workbook_imports
enable row level security;
alter table public.automatic_analysis_review_threads
enable row level security;
alter table public.automatic_analysis_review_messages
enable row level security;

revoke all on table
    public.automatic_analysis_review_workbook_imports,
    public.automatic_analysis_review_threads,
    public.automatic_analysis_review_messages
from public, anon, authenticated, service_role;

grant select, insert on table
    public.automatic_analysis_review_workbook_imports
to service_role;

grant select, insert, update on table
    public.automatic_analysis_review_threads
to service_role;

grant select, insert on table
    public.automatic_analysis_review_messages
to service_role;
