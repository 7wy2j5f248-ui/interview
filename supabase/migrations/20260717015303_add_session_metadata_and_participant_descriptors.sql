alter table public.interview_sessions
add column id uuid default gen_random_uuid();

alter table public.interview_sessions
alter column id set not null;

alter table public.interview_sessions
add constraint interview_sessions_id_key unique (id);

alter table public.interview_sessions
add constraint interview_sessions_session_participant_key
unique (session_id, participant_id);

comment on column public.interview_sessions.id is
    'Stable surrogate identifier while session_id remains the interview-session primary key.';

comment on table public.interview_sessions is
    'Machine-readable lifecycle and descriptive metadata for participant interview sessions. Historical completion is never inferred from transcript wording.';

with historical_session_values as (
    select
        btrim("Session") as session_id,
        case
            when count(distinct nullif(btrim("Participant"), '')) = 1
                then min(nullif(btrim("Participant"), ''))
            when count(distinct nullif(btrim("Participant"), '')) > 1
                then 'unclear'
            else 'unidentified'
        end as participant_id,
        case
            when count(distinct nullif(btrim("Language"), '')) = 1
                then min(nullif(btrim("Language"), ''))
            when count(distinct nullif(btrim("Language"), '')) > 1
                then 'unclear'
            else 'unidentified'
        end as language,
        min("Timestamp") as created_at,
        max("Timestamp") as updated_at
    from public.interview_messages
    where nullif(btrim("Session"), '') is not null
    group by btrim("Session")
)
insert into public.interview_sessions (
    session_id,
    participant_id,
    language,
    completed,
    completed_at,
    created_at,
    updated_at
)
select
    session_id,
    participant_id,
    language,
    false,
    null,
    created_at,
    updated_at
from historical_session_values
on conflict (session_id) do nothing;

create index interview_sessions_language_idx
on public.interview_sessions(language);

create index interview_sessions_completed_idx
on public.interview_sessions(completed);

create table public.participant_descriptors (
    id uuid primary key default gen_random_uuid(),
    session_id text not null,
    participant_id text not null,
    current_country text,
    current_region text,
    country_of_origin text,
    diaspora_status text,
    gender text,
    age smallint,
    birth_year smallint,
    birth_cohort text,
    youth_status text,
    education_level text,
    social_identity text,
    additional_descriptors jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint participant_descriptors_session_id_key
        unique (session_id),
    constraint participant_descriptors_session_participant_fkey
        foreign key (session_id, participant_id)
        references public.interview_sessions(session_id, participant_id)
        on update cascade
        on delete restrict,
    constraint participant_descriptors_age_valid
        check (age is null or age between 0 and 130),
    constraint participant_descriptors_birth_year_valid
        check (birth_year is null or birth_year between 1000 and 9999),
    constraint participant_descriptors_birth_cohort_valid
        check (
            birth_cohort is null
            or birth_cohort in (
                'unidentified',
                'not_asked',
                'declined',
                'unclear',
                'not_applicable'
            )
            or birth_cohort ~ '^(post|pre)_[0-9]{4}s$'
        ),
    constraint participant_descriptors_additional_object
        check (jsonb_typeof(additional_descriptors) = 'object')
);

comment on table public.participant_descriptors is
    'One structured, researcher-controlled descriptor record per interview session; raw participant responses remain in interview_messages.';

comment on column public.participant_descriptors.birth_cohort is
    'Stable decade-of-birth grouping such as post_1990s; youth_status remains a separate life-stage indicator.';

comment on column public.participant_descriptors.additional_descriptors is
    'Research-design-specific structured descriptors that do not belong in the standard columns.';

insert into public.participant_descriptors (
    session_id,
    participant_id
)
select
    session_id,
    participant_id
from public.interview_sessions
on conflict (session_id) do nothing;

create index participant_descriptors_participant_id_idx
on public.participant_descriptors(participant_id);

create index participant_descriptors_current_country_idx
on public.participant_descriptors(current_country);

create index participant_descriptors_gender_idx
on public.participant_descriptors(gender);

create index participant_descriptors_birth_cohort_idx
on public.participant_descriptors(birth_cohort);

create index participant_descriptors_education_level_idx
on public.participant_descriptors(education_level);

create index participant_descriptors_social_identity_idx
on public.participant_descriptors(social_identity);

alter table public.participant_descriptors enable row level security;

revoke all on table public.participant_descriptors
from public, anon, authenticated, service_role;

grant select, insert, update on table public.participant_descriptors
to service_role;

create or replace function public.set_session_metadata_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

revoke all on function public.set_session_metadata_updated_at()
from public, anon, authenticated, service_role;

grant execute on function public.set_session_metadata_updated_at()
to service_role;

create trigger interview_sessions_set_updated_at
before update on public.interview_sessions
for each row
execute function public.set_session_metadata_updated_at();

create trigger participant_descriptors_set_updated_at
before update on public.participant_descriptors
for each row
execute function public.set_session_metadata_updated_at();

alter table public.qualitative_analysis_runs
add column completion_filter text;

update public.qualitative_analysis_runs
set completion_filter = case
    when completed_only then 'completed'
    else 'all'
end;

alter table public.qualitative_analysis_runs
alter column completion_filter set default 'completed';

alter table public.qualitative_analysis_runs
alter column completion_filter set not null;

alter table public.qualitative_analysis_runs
alter column completed_only set default true;

alter table public.qualitative_analysis_runs
add constraint qualitative_analysis_runs_completion_filter_valid
check (completion_filter in ('completed', 'all', 'incomplete'));

alter table public.qualitative_analysis_runs
add constraint qualitative_analysis_runs_completion_filter_consistent
check (completed_only = (completion_filter = 'completed'));

comment on column public.qualitative_analysis_runs.completion_filter is
    'Frozen session-completion scope for this run. New analytical corpora default to completed sessions.';
