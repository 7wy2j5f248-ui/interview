-- Qualify the active-run fields because the claim function's table-return
-- column names are also PL/pgSQL variables. This migration is a no-op on a
-- clean replay where the preceding migration already contains the correction.
do $migration$
declare
    function_definition text;
    corrected_definition text;
begin
    select pg_get_functiondef(routine.oid)
    into function_definition
    from pg_proc as routine
    join pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname = 'claim_available_advanced_preliminary_analysis'
    limit 1;

    if function_definition is null then
        raise exception 'The parallel Stage 1 claim function is missing.';
    end if;

    corrected_definition := replace(
        function_definition,
        $old$select * into active_run
    from public.advanced_preliminary_analysis_runs
    where status in ('queued', 'processing')
      and operation_type = 'fresh_independent_analysis'
      and authoritative_source = 'original_completed_transcripts'
      and legacy_analysis_input = 'excluded'
    order by requested_at$old$,
        $new$select run.* into active_run
    from public.advanced_preliminary_analysis_runs as run
    where run.status in ('queued', 'processing')
      and run.operation_type = 'fresh_independent_analysis'
      and run.authoritative_source = 'original_completed_transcripts'
      and run.legacy_analysis_input = 'excluded'
    order by run.requested_at$new$
    );

    if corrected_definition <> function_definition then
        execute corrected_definition;
    end if;
end;
$migration$;
