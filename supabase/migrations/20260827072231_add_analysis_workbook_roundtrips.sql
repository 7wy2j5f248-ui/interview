create table public.qualitative_analysis_workbook_imports (
    id uuid primary key default gen_random_uuid(),
    analysis_run_id uuid not null
        references public.qualitative_analysis_runs(id) on delete restrict,
    stage text not null,
    parent_import_id uuid
        references public.qualitative_analysis_workbook_imports(id) on delete restrict,
    source_filename text not null,
    file_sha256 text not null,
    workbook_format_version text not null,
    source_selection jsonb not null default '{}'::jsonb,
    row_order jsonb not null default '[]'::jsonb,
    grouping_data jsonb not null default '{}'::jsonb,
    workbook_snapshot jsonb not null default '{}'::jsonb,
    imported_by text not null default 'researcher',
    imported_at timestamptz not null default now(),
    constraint qualitative_analysis_workbook_imports_stage_valid
        check (stage in ('themes', 'codes', 'keywords')),
    constraint qualitative_analysis_workbook_imports_filename_not_blank
        check (btrim(source_filename) <> ''),
    constraint qualitative_analysis_workbook_imports_sha256_valid
        check (file_sha256 ~ '^[0-9a-f]{64}$'),
    constraint qualitative_analysis_workbook_imports_version_not_blank
        check (btrim(workbook_format_version) <> ''),
    constraint qualitative_analysis_workbook_imports_json_types
        check (
            jsonb_typeof(source_selection) = 'object'
            and jsonb_typeof(row_order) = 'array'
            and jsonb_typeof(grouping_data) = 'object'
            and jsonb_typeof(workbook_snapshot) = 'object'
        ),
    constraint qualitative_analysis_workbook_imports_unique_file
        unique (analysis_run_id, stage, file_sha256)
);

comment on table public.qualitative_analysis_workbook_imports is
    'Append-only researcher Excel round-trip layers. Each upload preserves workbook content, ordering, grouping decisions, selections, timestamp, and source-file hash without changing the original AI analysis.';

create index qualitative_analysis_workbook_imports_run_stage_time_idx
on public.qualitative_analysis_workbook_imports (
    analysis_run_id,
    stage,
    imported_at desc
);

alter table public.qualitative_analysis_workbook_imports enable row level security;

revoke all on table public.qualitative_analysis_workbook_imports
from public, anon, authenticated, service_role;

grant select, insert on table public.qualitative_analysis_workbook_imports
to service_role;
