alter table public.advanced_preliminary_category_codes
drop constraint if exists advanced_preliminary_category_codes_report_id_code_id_key;

create index if not exists advanced_preliminary_category_code_lookup_idx
on public.advanced_preliminary_category_codes (report_id, code_id);

comment on table public.advanced_preliminary_category_codes is
    'Traceable many-to-many links between preliminary categories and codes; a code may support more than one analytically justified category.';
