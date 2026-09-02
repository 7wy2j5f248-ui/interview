-- Restore the stored MU/Code/Category/Theme structures that were copied to the
-- recovery archive before the exact-output-only migration removed them from
-- the active report tables. This is a lossless data restoration only. Nothing
-- here validates, scores, repairs, retries, accepts, or rejects model output.

insert into public.advanced_preliminary_meaning_units
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_meaning_units,
    coalesce(archive.projection->'meaningUnits', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_codes
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_codes,
    coalesce(archive.projection->'codes', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_categories
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_categories,
    coalesce(archive.projection->'categories', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_themes
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_themes,
    coalesce(archive.projection->'tentativeThemes', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_code_meaning_units
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_code_meaning_units,
    coalesce(archive.projection->'codeMeaningUnits', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_category_codes
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_category_codes,
    coalesce(archive.projection->'categoryCodes', '[]'::jsonb)
) as restored
on conflict do nothing;

insert into public.advanced_preliminary_theme_categories
select restored.*
from public.advanced_preliminary_projection_archive as archive
cross join lateral jsonb_populate_recordset(
    null::public.advanced_preliminary_theme_categories,
    coalesce(archive.projection->'themeCategories', '[]'::jsonb)
) as restored
on conflict do nothing;

update public.advanced_preliminary_case_reports as report
set analytical_audit = coalesce(report.analytical_audit, '{}'::jsonb)
    || jsonb_build_object(
        'storedReportStructureAvailable', true,
        'storedReportStructureRole', 'read_only_researcher_inspection',
        'storedReportStructureRestoredAt', now(),
        'storedReportStructureHasNoRejectionAuthority', true
    )
where exists (
    select 1
    from public.advanced_preliminary_projection_archive as archive
    where archive.report_id = report.id
      and (
          jsonb_array_length(coalesce(
              archive.projection->'meaningUnits', '[]'::jsonb
          )) > 0
          or jsonb_array_length(coalesce(
              archive.projection->'codes', '[]'::jsonb
          )) > 0
          or jsonb_array_length(coalesce(
              archive.projection->'categories', '[]'::jsonb
          )) > 0
          or jsonb_array_length(coalesce(
              archive.projection->'tentativeThemes', '[]'::jsonb
          )) > 0
      )
);

comment on table public.advanced_preliminary_projection_archive is
    'Lossless recovery copy of stored Stage 1 report structure. Restored structures are researcher-visible evidence and have no authority to validate or reject model output.';
