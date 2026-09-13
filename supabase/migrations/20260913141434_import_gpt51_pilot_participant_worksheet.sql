-- Schema for a pilot-only, researcher-authorized import of the first
-- participant-information worksheet from a historical Stage 1 workbook.
-- The authorized source worksheet is named "1 Participant & case".
-- The private worksheet rows are imported directly into the protected
-- production database and are intentionally never committed to Git.
-- No Meaning Unit, Code, Category, Theme, hierarchy, calculation process,
-- or other historical analytical content is accepted by this table.

create table public.pilot_stage1_participant_information_v2 (
    case_id uuid primary key
        references public.analysis_cases_v2(id) on delete restrict,
    source_worksheet_row_number integer not null,
    source_participant_code text not null,
    source_session_number integer not null,
    source_language text not null,
    participant_information jsonb not null,
    source_model text not null default 'gpt-5.1',
    source_filename text not null,
    source_sheet_name text not null,
    source_workbook_sha256 text not null,
    source_scope text not null default 'participant_information_only',
    analytical_content_imported boolean not null default false,
    prior_analytical_process_inherited boolean not null default false,
    authorized_by text not null default 'researcher',
    authorized_at timestamptz not null default now(),
    constraint pilot_stage1_participant_information_v2_object
        check (jsonb_typeof(participant_information) = 'object'),
    constraint pilot_stage1_participant_information_v2_source_row
        check (source_worksheet_row_number between 2 and 276),
    constraint pilot_stage1_participant_information_v2_source_code
        check (source_participant_code ~ '^P[0-9]{4}$'),
    constraint pilot_stage1_participant_information_v2_session_positive
        check (source_session_number > 0),
    constraint pilot_stage1_participant_information_v2_hash
        check (source_workbook_sha256 ~ '^[0-9a-f]{64}$'),
    constraint pilot_stage1_participant_information_v2_scope
        check (source_scope = 'participant_information_only'),
    constraint pilot_stage1_participant_information_v2_no_analysis
        check (
            analytical_content_imported = false
            and prior_analytical_process_inherited = false
        )
);

comment on table public.pilot_stage1_participant_information_v2 is
    'Researcher-authorized pilot-only participant worksheet. Private source rows are loaded directly into the protected database, never Git. It contains no historical analytical content and grants no authority to the historical analytical process.';

create trigger pilot_stage1_participant_information_v2_immutable
before update or delete on public.pilot_stage1_participant_information_v2
for each row execute function public.reject_analysis_v2_mutation();

alter table public.pilot_stage1_participant_information_v2
    enable row level security;
revoke all on table public.pilot_stage1_participant_information_v2
    from public, anon, authenticated;
grant select on table public.pilot_stage1_participant_information_v2
    to service_role;
