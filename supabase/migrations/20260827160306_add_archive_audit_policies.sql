create policy "service role reads archive events"
on public.automatic_case_analysis_archive_events
for select
to service_role
using (true);

create policy "service role inserts archive events"
on public.automatic_case_analysis_archive_events
for insert
to service_role
with check (true);
