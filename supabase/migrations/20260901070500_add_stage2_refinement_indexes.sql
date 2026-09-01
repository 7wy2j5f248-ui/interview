create index if not exists stage2_runs_project_idx
on public.stage2_code_refinement_runs(project_id);

create index if not exists stage2_preliminary_codes_run_idx
on public.stage2_preliminary_codes(run_id);

create index if not exists stage2_preliminary_codes_report_idx
on public.stage2_preliminary_codes(stage1_report_id);

create index if not exists stage2_preliminary_evidence_mu_idx
on public.stage2_preliminary_code_evidence(meaning_unit_id);

create index if not exists stage2_refined_codes_source_idx
on public.stage2_refined_codes(created_from_preliminary_code_id);

create index if not exists stage2_assignments_run_idx
on public.stage2_code_assignments(run_id);
