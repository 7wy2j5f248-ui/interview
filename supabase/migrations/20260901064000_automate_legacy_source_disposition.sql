alter table public.advanced_preliminary_analysis_jobs
add column if not exists disposition_evidence jsonb not null default '{}'::jsonb;

alter table public.advanced_preliminary_analysis_jobs
drop constraint if exists advanced_preliminary_jobs_disposition_evidence_object;

alter table public.advanced_preliminary_analysis_jobs
add constraint advanced_preliminary_jobs_disposition_evidence_object
check (jsonb_typeof(disposition_evidence) = 'object');

create or replace function public.set_advanced_preliminary_case_disposition(
    p_job_id uuid,
    p_disposition text,
    p_reason text,
    p_actor text,
    p_evidence jsonb
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
       or nullif(btrim(p_actor), '') is null
       or jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object' then
        raise exception 'A valid disposition, reason, actor, and evidence object are required.';
    end if;

    update public.advanced_preliminary_analysis_jobs
    set disposition = p_disposition,
        disposition_reason = btrim(p_reason),
        disposition_evidence = coalesce(p_evidence, '{}'::jsonb),
        disposition_at = now(),
        disposition_by = btrim(p_actor),
        status = 'failed',
        attempt_count = greatest(attempt_count, 3),
        lease_expires_at = null,
        next_retry_at = null,
        last_error = 'Classified as legacy unusable: ' || btrim(p_reason),
        updated_at = now()
    where id = p_job_id;

    get diagnostics affected = row_count;
    return affected = 1;
end;
$$;

revoke all on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text, jsonb
) to service_role;
