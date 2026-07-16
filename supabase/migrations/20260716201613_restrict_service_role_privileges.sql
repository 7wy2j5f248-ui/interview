-- Reconcile the already-applied Task 013 migration with Supabase projects
-- whose default privileges grant service_role broader table access.
revoke all on table public.interview_sessions
from service_role;

grant select, insert, update on table public.interview_sessions
to service_role;

revoke all on function public.complete_interview_session(text)
from service_role;

grant execute on function public.complete_interview_session(text)
to service_role;
