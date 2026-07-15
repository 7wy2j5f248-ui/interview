alter table public.interview_messages
add column if not exists "EnglishTranslation" text;

comment on column public.interview_messages."EnglishTranslation" is
'Durable English translation of a non-English interview message. The original Message value remains unchanged.';
