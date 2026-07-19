alter table public.interview_sessions
add column if not exists research_design_id uuid references public.research_designs(id);

comment on column public.interview_sessions.research_design_id is
  'Research design version frozen when the interview session is first created.';

create or replace function public.prepare_interview_session_with_model(
  p_session_id text,
  p_participant_id text,
  p_language text,
  p_interview_model text,
  p_research_design_id uuid,
  p_request_at timestamptz,
  p_timeout_minutes integer
)
returns table (
  accepted_session_id text,
  previous_session_id text,
  expired boolean,
  created boolean,
  timeout_at timestamptz,
  selected_interview_model text,
  selected_research_design_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_session public.interview_sessions%rowtype;
  new_session_id text;
  calculated_timeout_at timestamptz;
  normalized_model text;
begin
  normalized_model := btrim(p_interview_model);

  if nullif(btrim(p_session_id), '') is null
     or nullif(btrim(p_participant_id), '') is null
     or nullif(btrim(p_language), '') is null
     or nullif(normalized_model, '') is null
     or normalized_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_research_design_id is null
     or not exists (
       select 1
       from public.research_designs design
       where design.id = p_research_design_id
     )
     or p_request_at is null
     or p_timeout_minutes is null
     or p_timeout_minutes < 1
     or p_timeout_minutes > 10080 then
    raise exception 'Invalid interview session preparation request.';
  end if;

  select session.*
  into existing_session
  from public.interview_sessions as session
  where session.session_id = btrim(p_session_id)
  for update;

  if not found then
    insert into public.interview_sessions (
      session_id,
      participant_id,
      language,
      interview_model,
      research_design_id,
      completed,
      completed_at,
      created_at,
      updated_at,
      last_activity_at,
      session_status,
      inactivity_timeout_minutes
    ) values (
      btrim(p_session_id),
      btrim(p_participant_id),
      btrim(p_language),
      normalized_model,
      p_research_design_id,
      false,
      null,
      p_request_at,
      p_request_at,
      null,
      'active',
      p_timeout_minutes
    );

    return query
    select btrim(p_session_id), null::text, false, true,
      null::timestamptz, normalized_model, p_research_design_id;
    return;
  end if;

  if existing_session.participant_id <> btrim(p_participant_id) then
    raise exception 'Interview session participant does not match.';
  end if;

  calculated_timeout_at := coalesce(
    existing_session.timed_out_at,
    existing_session.ended_at,
    existing_session.last_activity_at
      + make_interval(mins => p_timeout_minutes)
  );

  if existing_session.session_status in ('timed_out', 'abandoned')
     or (
       existing_session.last_activity_at is not null
       and p_request_at > existing_session.last_activity_at
         + make_interval(mins => p_timeout_minutes)
     ) then
    if not existing_session.completed
       and existing_session.session_status = 'active' then
      calculated_timeout_at := existing_session.last_activity_at
        + make_interval(mins => p_timeout_minutes);

      update public.interview_sessions
      set session_status = 'timed_out',
          end_reason = 'inactivity_timeout',
          timed_out_at = calculated_timeout_at,
          ended_at = calculated_timeout_at
      where session_id = existing_session.session_id;
    end if;

    new_session_id := 'S'
      || floor(extract(epoch from p_request_at) * 1000)::bigint::text
      || '-'
      || replace(gen_random_uuid()::text, '-', '');

    insert into public.interview_sessions (
      session_id,
      participant_id,
      language,
      interview_model,
      research_design_id,
      completed,
      completed_at,
      created_at,
      updated_at,
      last_activity_at,
      session_status,
      continuation_of_session_id,
      inactivity_timeout_minutes
    ) values (
      new_session_id,
      btrim(p_participant_id),
      btrim(p_language),
      normalized_model,
      p_research_design_id,
      false,
      null,
      p_request_at,
      p_request_at,
      null,
      'active',
      existing_session.session_id,
      p_timeout_minutes
    );

    return query
    select new_session_id, existing_session.session_id,
      true, true, calculated_timeout_at, normalized_model,
      p_research_design_id;
    return;
  end if;

  update public.interview_sessions
  set inactivity_timeout_minutes = p_timeout_minutes,
      research_design_id = coalesce(
        interview_sessions.research_design_id,
        p_research_design_id
      )
  where session_id = existing_session.session_id;

  return query
  select existing_session.session_id, null::text, false, false,
    null::timestamptz, existing_session.interview_model,
    coalesce(existing_session.research_design_id, p_research_design_id);
end;
$$;

revoke all on function public.prepare_interview_session_with_model(
  text, text, text, text, uuid, timestamptz, integer
) from public, anon, authenticated, service_role;

grant execute on function public.prepare_interview_session_with_model(
  text, text, text, text, uuid, timestamptz, integer
) to service_role;