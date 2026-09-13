-- The one-time corrective import is complete. Runtime access is read-only.

revoke all on table public.pilot_stage1_participant_information_v3
    from service_role;
grant select on table public.pilot_stage1_participant_information_v3
    to service_role;
