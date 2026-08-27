update public.automatic_case_analysis_jobs as job
set
    status = 'pending',
    attempt_count = 0,
    claimed_at = null,
    lease_expires_at = null,
    next_retry_at = null,
    completed_at = null,
    last_error = null,
    updated_at = now()
where job.archived_at is null
  and exists (
      select 1
      from public.interview_sessions as session
      join public.interview_messages as message
        on message."Session" = session.session_id
      where session.session_id = job.session_id
        and session.completed = true
        and lower(coalesce(message."Language", '')) <> 'en'
        and nullif(btrim(message."EnglishTranslation"), '') is null
  );
