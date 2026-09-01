alter table public.advanced_preliminary_analysis_jobs
add column if not exists disposition text not null default 'active',
add column if not exists disposition_reason text,
add column if not exists disposition_at timestamptz,
add column if not exists disposition_by text;

alter table public.advanced_preliminary_analysis_jobs
drop constraint if exists advanced_preliminary_analysis_jobs_disposition_valid;

alter table public.advanced_preliminary_analysis_jobs
add constraint advanced_preliminary_analysis_jobs_disposition_valid
check (disposition in ('active', 'legacy_unusable'));

create index if not exists advanced_preliminary_jobs_run_disposition_idx
on public.advanced_preliminary_analysis_jobs(run_id, disposition, source_completed_at);

create or replace function public.set_advanced_preliminary_case_disposition(
    p_job_id uuid,
    p_disposition text,
    p_reason text,
    p_actor text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    affected integer;
begin
    if p_disposition <> 'legacy_unusable'
       or nullif(btrim(p_reason), '') is null
       or nullif(btrim(p_actor), '') is null then
        raise exception 'A valid disposition, reason, and actor are required.';
    end if;

    update public.advanced_preliminary_analysis_jobs
    set disposition = p_disposition,
        disposition_reason = btrim(p_reason),
        disposition_at = now(),
        disposition_by = btrim(p_actor),
        status = 'failed',
        attempt_count = greatest(attempt_count, 3),
        lease_expires_at = null,
        next_retry_at = null,
        last_error = 'Researcher classified this historical interview as legacy unusable: '
            || btrim(p_reason),
        updated_at = now()
    where id = p_job_id;

    get diagnostics affected = row_count;
    return affected = 1;
end;
$$;

revoke all on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) to service_role;
