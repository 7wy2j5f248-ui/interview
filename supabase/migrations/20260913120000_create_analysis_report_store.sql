-- A provider-completed response is not a completed Stage 1 case until its
-- readable MU -> CO -> CA -> TH report has been stored. Researcher viewing or
-- approval is deliberately absent from this contract.

alter table public.analysis_cases_v2
    drop constraint analysis_cases_v2_status_valid;
alter table public.analysis_cases_v2
    add constraint analysis_cases_v2_status_valid check (
        stage1_status in (
            'pending', 'processing', 'provider_pending', 'report_pending',
            'completed', 'unresolved'
        )
    );

alter table public.stage2_runs_v2
    drop constraint stage2_runs_v2_status_valid;
alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_status_valid check (
        status in (
            'queued', 'processing', 'provider_pending', 'report_pending',
            'completed', 'technically_incomplete', 'failed'
        )
    );
alter table public.stage2_runs_v2
    drop constraint stage2_runs_v2_terminal_consistent;
alter table public.stage2_runs_v2
    add constraint stage2_runs_v2_terminal_consistent check (
        (status in (
            'report_pending', 'completed', 'technically_incomplete', 'failed'
        ) and terminal_at is not null)
        or (status not in (
            'report_pending', 'completed', 'technically_incomplete', 'failed'
        ) and terminal_at is null)
    );

create table public.stage1_readable_reports_v2 (
    attempt_id uuid primary key
        references public.stage1_attempts_v2(id) on delete restrict,
    report_json jsonb not null,
    report_sha256 text not null,
    source_response_sha256 text not null,
    source_kind text not null,
    provider text not null,
    model text not null,
    reasoning_effort text not null,
    provider_status text,
    created_at timestamptz not null default now(),
    constraint stage1_readable_reports_v2_object check (
        jsonb_typeof(report_json) = 'object'
    ),
    constraint stage1_readable_reports_v2_complete_shape check (
        jsonb_typeof(report_json -> 'meaning_units') = 'array'
        and jsonb_typeof(report_json -> 'preliminary_codes') = 'array'
        and jsonb_typeof(report_json -> 'preliminary_categories') = 'array'
        and jsonb_typeof(
            report_json -> 'preliminary_tentative_themes'
        ) = 'array'
    ),
    constraint stage1_readable_reports_v2_hash_valid check (
        report_sha256 ~ '^[0-9a-f]{64}$'
        and source_response_sha256 ~ '^[0-9a-f]{64}$'
    ),
    constraint stage1_readable_reports_v2_source_valid check (
        source_kind in (
            'provider_completed_response',
            'frozen_gpt56_response_projection'
        )
    ),
    constraint stage1_readable_reports_v2_provider_not_blank check (
        btrim(provider) <> '' and btrim(model) <> ''
        and btrim(reasoning_effort) <> ''
    )
);

create function public.stage1_readable_report_complete_v2(p_report jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
    item jsonb;
begin
    if jsonb_typeof(p_report) <> 'object'
       or jsonb_typeof(p_report -> 'meaning_units') <> 'array'
       or jsonb_typeof(p_report -> 'preliminary_codes') <> 'array'
       or jsonb_typeof(p_report -> 'preliminary_categories') <> 'array'
       or jsonb_typeof(
           p_report -> 'preliminary_tentative_themes'
       ) <> 'array'
       or jsonb_array_length(p_report -> 'meaning_units') = 0
       or jsonb_array_length(p_report -> 'preliminary_codes') = 0
       or jsonb_array_length(p_report -> 'preliminary_categories') = 0
       or jsonb_array_length(
           p_report -> 'preliminary_tentative_themes'
       ) = 0 then
        return false;
    end if;

    for item in select value
        from jsonb_array_elements(p_report -> 'meaning_units')
    loop
        if nullif(btrim(item ->> 'id'), '') is null
           or jsonb_typeof(item -> 'sources') <> 'array'
           or jsonb_array_length(item -> 'sources') = 0
           or exists (
               select 1 from jsonb_array_elements(item -> 'sources') source
               where nullif(btrim(source ->> 'english_text'), '') is null
           ) then return false;
        end if;
    end loop;

    for item in select value
        from jsonb_array_elements(p_report -> 'preliminary_codes')
    loop
        if nullif(btrim(item ->> 'id'), '') is null
           or nullif(btrim(item ->> 'label'), '') is null
           or jsonb_typeof(item -> 'meaning_unit_ids') <> 'array' then
            return false;
        end if;
    end loop;

    for item in select value
        from jsonb_array_elements(p_report -> 'preliminary_categories')
    loop
        if nullif(btrim(item ->> 'id'), '') is null
           or nullif(btrim(item ->> 'label'), '') is null
           or jsonb_typeof(item -> 'code_ids') <> 'array' then
            return false;
        end if;
    end loop;

    for item in select value from jsonb_array_elements(
        p_report -> 'preliminary_tentative_themes'
    ) loop
        if nullif(btrim(item ->> 'id'), '') is null
           or nullif(btrim(item ->> 'statement'), '') is null
           or jsonb_typeof(item -> 'category_ids') <> 'array' then
            return false;
        end if;
    end loop;

    return true;
end;
$function$;

alter table public.stage1_readable_reports_v2
    add constraint stage1_readable_reports_v2_no_blank_report_rows
    check (public.stage1_readable_report_complete_v2(report_json));

comment on table public.stage1_readable_reports_v2 is
    'Immutable readable Stage 1 report required for case completion. Merely opening or inspecting this report has no stored state and no workflow effect.';

create trigger stage1_readable_reports_v2_immutable
before update or delete on public.stage1_readable_reports_v2
for each row execute function public.reject_analysis_v2_mutation();

alter table public.stage1_readable_reports_v2 enable row level security;
revoke all on table public.stage1_readable_reports_v2
from public, anon, authenticated;
grant select on table public.stage1_readable_reports_v2 to service_role;

create function private.stage1_report_reference_ids_v2(
    p_values jsonb,
    p_prefix text
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
    select coalesce(jsonb_agg(
        case
            when upper(value) ~ ('^' || p_prefix || '[0-9]+$')
                then upper(value)
            else p_prefix || regexp_replace(value, '[^0-9]', '', 'g')
        end order by ordinality
    ), '[]'::jsonb)
    from jsonb_array_elements_text(coalesce(p_values, '[]'::jsonb))
        with ordinality as entry(value, ordinality)
$function$;

create function private.stage1_report_id_v2(
    p_value text,
    p_prefix text,
    p_fallback bigint
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
    select case
        when upper(coalesce(p_value, '')) ~ ('^' || p_prefix || '[0-9]+$')
            then upper(p_value)
        when regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') <> ''
            then p_prefix || regexp_replace(p_value, '[^0-9]', '', 'g')
        else p_prefix || p_fallback::text
    end
$function$;


