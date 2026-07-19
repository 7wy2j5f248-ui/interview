do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.research_designs'::regclass
      and contype in ('p', 'u')
      and conkey = array[
        (
          select attnum
          from pg_attribute
          where attrelid = 'public.research_designs'::regclass
            and attname = 'id'
        )::smallint
      ]
  ) then
    alter table public.research_designs
    add constraint research_designs_id_unique unique (id);
  end if;
end;
$$;