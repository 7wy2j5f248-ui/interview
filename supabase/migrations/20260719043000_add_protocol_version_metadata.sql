alter table public.research_designs
add column if not exists protocol_version text,
add column if not exists version_notes text;

update public.research_designs
set protocol_version = coalesce(nullif(btrim(protocol_version), ''), 'legacy')
where protocol_version is null or nullif(btrim(protocol_version), '') is null;

alter table public.research_designs
alter column protocol_version set not null;

alter table public.research_designs
drop constraint if exists research_designs_protocol_version_length;

alter table public.research_designs
add constraint research_designs_protocol_version_length
check (char_length(protocol_version) between 1 and 50);

comment on column public.research_designs.protocol_version is
  'Researcher-defined version identifier for this immutable interview protocol row.';

comment on column public.research_designs.version_notes is
  'Researcher-authored summary of changes made in this protocol version.';