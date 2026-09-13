drop function private.backfill_stage1_readable_reports_v2(integer, integer);
drop function private.stage1_report_reference_ids_v2(jsonb, text);
drop function private.stage1_report_id_v2(text, text, bigint);
drop function private.extract_complete_stage1_report_array_v2(text, text);

do $verify_report_backfill$
begin
    if exists (
        select 1
        from public.analysis_cases_v2 as analysis_case
        where analysis_case.stage1_status = 'completed'
          and not exists (
              select 1
              from public.stage1_attempts_v2 as attempt
              join public.stage1_readable_reports_v2 as report
                on report.attempt_id = attempt.id
              where attempt.case_id = analysis_case.id
                and attempt.status = 'completed'
          )
    ) then
        raise exception 'A completed Stage 1 case has no submitted readable report';
    end if;
end;
$verify_report_backfill$;




