create index analysis_frameworks_predecessor_idx
on public.analysis_frameworks(predecessor_id)
where predecessor_id is not null;

create index research_designs_project_idx
on public.research_designs(project_id)
where project_id is not null;

create index automatic_case_jobs_project_idx
on public.automatic_case_analysis_jobs(project_id)
where project_id is not null;

create index automatic_case_jobs_framework_idx
on public.automatic_case_analysis_jobs(analysis_framework_id)
where analysis_framework_id is not null;

create index automatic_case_reanalysis_requests_project_idx
on public.automatic_case_reanalysis_requests(project_id)
where project_id is not null;

create index automatic_case_reanalysis_requests_framework_idx
on public.automatic_case_reanalysis_requests(analysis_framework_id)
where analysis_framework_id is not null;

create index automatic_case_reanalysis_proposals_project_idx
on public.automatic_case_reanalysis_proposals(project_id)
where project_id is not null;

create index automatic_case_reanalysis_proposals_framework_idx
on public.automatic_case_reanalysis_proposals(analysis_framework_id)
where analysis_framework_id is not null;

create index qualitative_case_reports_project_idx
on public.qualitative_case_reports(project_id)
where project_id is not null;

create index qualitative_case_reports_framework_idx
on public.qualitative_case_reports(analysis_framework_id)
where analysis_framework_id is not null;
