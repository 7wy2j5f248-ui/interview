begin;

-- Preserve every historical row while making the retired analysis pipeline
-- incapable of claiming or publishing new analytical results.
revoke execute on function public.claim_next_automatic_case_analysis(text)
from public, anon, authenticated, service_role;
revoke execute on function public.complete_automatic_case_analysis(
    text, text, text, integer, jsonb
)
from public, anon, authenticated, service_role;
revoke execute on function public.complete_automatic_case_analysis_v5(
    text, text, text, integer, jsonb
)
from public, anon, authenticated, service_role;
revoke execute on function public.fail_automatic_case_analysis(
    text, text, boolean
)
from public, anon, authenticated, service_role;
revoke execute on function public.claim_next_framework_reanalysis()
from public, anon, authenticated, service_role;

update public.automatic_case_analysis_jobs
set status = 'failed',
    lease_expires_at = null,
    next_retry_at = null,
    last_error =
        'Retired preliminary-analysis pipeline disabled. Historical row retained for provenance; this is not a current analytical result.',
    updated_at = now()
where status in ('pending', 'processing');

commit;
