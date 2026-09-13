-- Keep the pilot participant worksheet readable by the server while denying
-- server-role mutation after the one-time researcher-authorized import.

revoke all on table public.pilot_stage1_participant_information_v2
    from service_role;
grant select on table public.pilot_stage1_participant_information_v2
    to service_role;
