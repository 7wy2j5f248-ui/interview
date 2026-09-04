-- Supporting indexes for the case-bound analysis v2 foreign keys reported by
-- the Supabase performance advisor after the base migration was applied.

create index analysis_case_sessions_v2_session_idx
on public.analysis_case_sessions_v2(session_id);

create index analysis_cases_v2_configuration_idx
on public.analysis_cases_v2(configuration_id);

create index analysis_cohorts_v2_configuration_idx
on public.analysis_cohorts_v2(configuration_id);

create index analysis_cohorts_v2_project_idx
on public.analysis_cohorts_v2(project_id);
