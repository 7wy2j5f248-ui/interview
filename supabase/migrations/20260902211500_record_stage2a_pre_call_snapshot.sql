alter table public.stage2a_code_harmonization_runs
add column if not exists pre_call_snapshot jsonb not null default '{}'::jsonb;
