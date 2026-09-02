-- GOV-PART-001 follow-up: the historical four-argument overload must be
-- prohibited as well as the later five-argument disposition function.

create or replace function public.set_advanced_preliminary_case_disposition(
    p_job_id uuid,
    p_disposition text,
    p_reason text,
    p_actor text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    raise exception using
        errcode = 'P0001',
        message = 'Participant or transcript exclusion is prohibited by GOV-PART-001. Record analysis and computational failures as system-owned attention states.';
end;
$$;

revoke all on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.set_advanced_preliminary_case_disposition(
    uuid, text, text, text
) to service_role;
