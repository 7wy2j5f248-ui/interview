-- Corrective, pilot-only source for the participant-information worksheet.
-- V2 was loaded from the wrong workbook. V3 records only columns A:O from
-- the actual saved GPT-5.1 complete-case report. The historical report has
-- 272 of the 275 pilot cohort cases; the three absent cases are retained with
-- identifiers/language only and blank demographic fields.
--
-- This table contains no GPT-5.1 Meaning Unit, Code, Category, Theme, case
-- report, calculation, hierarchy, or other analytical content.

create table public.pilot_stage1_participant_information_v3 (
    case_id uuid primary key
        references public.analysis_cases_v2(id) on delete restrict,
    source_worksheet_row_number integer,
    source_row_present boolean not null,
    source_participant_code text not null,
    source_session_number integer not null,
    source_language text not null,
    participant_information jsonb not null,
    source_model text not null default 'gpt-5.1',
    source_filename text not null,
    source_sheet_name text not null,
    source_range text not null default 'A:O',
    source_workbook_sha256 text not null,
    source_scope text not null default 'participant_information_only',
    analytical_content_imported boolean not null default false,
    prior_analytical_process_inherited boolean not null default false,
    authorized_by text not null default 'researcher',
    authorized_at timestamptz not null default now(),
    constraint pilot_stage1_participant_information_v3_object
        check (jsonb_typeof(participant_information) = 'object'),
    constraint pilot_stage1_participant_information_v3_source_row
        check (
            (source_row_present and source_worksheet_row_number between 2 and 273)
            or (not source_row_present and source_worksheet_row_number is null)
        ),
    constraint pilot_stage1_participant_information_v3_source_code
        check (source_participant_code ~ '^P[0-9]{4}$'),
    constraint pilot_stage1_participant_information_v3_session_positive
        check (source_session_number > 0),
    constraint pilot_stage1_participant_information_v3_range
        check (source_range = 'A:O'),
    constraint pilot_stage1_participant_information_v3_hash
        check (source_workbook_sha256 ~ '^[0-9a-f]{64}$'),
    constraint pilot_stage1_participant_information_v3_scope
        check (source_scope = 'participant_information_only'),
    constraint pilot_stage1_participant_information_v3_no_analysis
        check (
            analytical_content_imported = false
            and prior_analytical_process_inherited = false
        )
);

comment on table public.pilot_stage1_participant_information_v3 is
    'Researcher-authorized pilot-only copy of demographic columns A:O from the actual saved GPT-5.1 complete-case report. No historical analytical content is stored or inherited.';

create trigger pilot_stage1_participant_information_v3_immutable
before update or delete on public.pilot_stage1_participant_information_v3
for each row execute function public.reject_analysis_v2_mutation();

alter table public.pilot_stage1_participant_information_v3
    enable row level security;
revoke all on table public.pilot_stage1_participant_information_v3
    from public, anon, authenticated;
grant select, insert on table public.pilot_stage1_participant_information_v3
    to service_role;
