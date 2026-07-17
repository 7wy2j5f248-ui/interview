alter table public.participant_descriptors
add column if not exists descriptor_sources jsonb not null default '{}'::jsonb;

alter table public.participant_descriptors
add constraint participant_descriptors_sources_object
check (jsonb_typeof(descriptor_sources) = 'object');

comment on column public.participant_descriptors.descriptor_sources is
    'Audit provenance for structured values, including the designated question and participant-answer message IDs, original answer, extracted segment, and missing-information state.';

create or replace function public.set_session_metadata_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.updated_at is not distinct from old.updated_at then
        new.updated_at = now();
    end if;

    return new;
end;
$$;

revoke all on function public.set_session_metadata_updated_at()
from public, anon, authenticated, service_role;

grant execute on function public.set_session_metadata_updated_at()
to service_role;

with historical_session_values as (
    select
        btrim("Session") as session_id,
        case
            when count(distinct nullif(btrim("Participant"), '')) = 1
                then min(nullif(btrim("Participant"), ''))
            when count(distinct nullif(btrim("Participant"), '')) > 1
                then 'unclear'
            else 'unidentified'
        end as participant_id,
        case
            when count(distinct nullif(btrim("Language"), '')) = 1
                then min(nullif(btrim("Language"), ''))
            when count(distinct nullif(btrim("Language"), '')) > 1
                then 'unclear'
            else 'unidentified'
        end as language,
        min("Timestamp") as created_at,
        max("Timestamp") as updated_at
    from public.interview_messages
    where nullif(btrim("Session"), '') is not null
    group by btrim("Session")
)
update public.interview_sessions as session
set
    participant_id = historical.participant_id,
    language = historical.language,
    created_at = historical.created_at,
    updated_at = historical.updated_at
from historical_session_values as historical
where session.session_id = historical.session_id;

create temporary table descriptor_backfill_answers
on commit drop
as
with latest_active_design as (
    select
        design.id,
        design.interview_question_count,
        regexp_replace(
            design.interview_questions,
            '(?is)^.*question\s+'
                || design.interview_question_count::text
                || '\s*:\s*',
            ''
        ) as final_question
    from public.active_design as active
    join public.research_designs as design
        on design.id = active.active_design_id
    order by active.id desc
    limit 1
),
eligible_design as (
    select *
    from latest_active_design
    where lower(final_question) ~ '(your age|age)'
      and lower(final_question) ~ '(profession|occupation)'
      and lower(final_question) ~ '(country of birth|born)'
      and lower(final_question) ~ '(country of residence|currently live|current country)'
),
ordered_messages as (
    select
        message.id,
        btrim(message."Session") as session_id,
        lower(coalesce(message."Language", '')) as language,
        lower(coalesce(message."Speaker", '')) as speaker,
        message."Message" as message,
        message."Timestamp" as message_timestamp,
        row_number() over (
            partition by btrim(message."Session")
            order by
                message."Timestamp",
                case
                    when lower(coalesce(message."Speaker", ''))
                        in ('user', 'participant') then 0
                    else 1
                end,
                message.id
        ) as message_order
    from public.interview_messages as message
    where nullif(btrim(message."Session"), '') is not null
),
final_question_candidates as (
    select
        message.*,
        design.id as active_design_id,
        row_number() over (
            partition by message.session_id
            order by message.message_order desc
        ) as candidate_order
    from ordered_messages as message
    cross join eligible_design as design
    where message.speaker in ('ai', 'assistant', 'interviewer')
      and (
        (
            message.message ~* '(your age|how old)'
            and message.message ~* '(profession|occupation)'
            and message.message ~* '(country of birth|born)'
            and message.message ~* '(country of residence|currently live|current country)'
        )
        or (
            message.message ~ '(年龄|几岁)'
            and message.message ~ '(职业|工作)'
            and message.message ~ '(出生.*国|哪个国家出生)'
            and message.message ~ '(目前.*居住|现在.*居住|现在.*住)'
        )
        or (
            message.message ~ '(العمر|عمرك)'
            and message.message ~ '(المهنة|مهنتك|العمل)'
            and message.message ~ '(بلد.*الميلاد|ولدت)'
            and message.message ~ '(بلد.*الإقامة|تعيش)'
        )
        or (
            message.message ~ '(عمر|سال)'
            and message.message ~ '(پیشہ|کام)'
            and message.message ~ '(پیدائش|پیدا)'
            and message.message ~ '(رہائش|رہتے)'
        )
      )
),
matched_turns as (
    select
        question.active_design_id,
        question.session_id,
        question.language,
        question.id as question_message_id,
        question.message as question_text,
        question.message_timestamp as question_timestamp,
        answer.id as answer_message_id,
        answer.message as raw_answer,
        answer.message_timestamp as answer_timestamp
    from final_question_candidates as question
    left join lateral (
        select candidate.*
        from ordered_messages as candidate
        where candidate.session_id = question.session_id
          and candidate.message_order > question.message_order
          and candidate.speaker in ('user', 'participant')
        order by candidate.message_order
        limit 1
    ) as answer on true
    where question.candidate_order = 1
)
select * from matched_turns;

update public.interview_sessions as session
set
    completed = true,
    completed_at = matched.answer_timestamp
from descriptor_backfill_answers as matched
where session.session_id = matched.session_id
  and matched.answer_message_id is not null
  and session.completed = false;

with descriptor_context as (
    select
        descriptor.session_id,
        matched.active_design_id,
        matched.question_message_id,
        matched.question_text,
        matched.answer_message_id,
        matched.raw_answer,
        matched.answer_timestamp,
        case
            when matched.question_message_id is null then 'not_asked'
            when matched.answer_message_id is null then 'unidentified'
            when lower(btrim(matched.raw_answer)) ~
                '^(skip|skipped|decline|declined|prefer not|rather not|no comment|n/?a)$'
              or matched.raw_answer ~ '(跳过|跳過|不想说|不想說|不愿说|不願說|没什么可说|沒什麼可說)'
              or matched.raw_answer ~ '(أفضل عدم|لا أرغب|امتنع)'
              or matched.raw_answer ~ '(نہیں بتانا|جواب نہیں|ترجیح.*نہیں)'
                then 'declined'
            else 'answered'
        end as answer_state,
        regexp_split_to_array(
            regexp_replace(coalesce(matched.raw_answer, ''), '[\.。\s]+$', ''),
            '\s*[,，;；\n]+\s*'
        ) as answer_segments
    from public.participant_descriptors as descriptor
    left join descriptor_backfill_answers as matched
        on matched.session_id = descriptor.session_id
),
segment_values as (
    select
        context.*,
        segment.value as segment,
        segment.ordinality as segment_order,
        case
            when lower(segment.value) ~ '(^|[^[:alpha:]])canada([^[:alpha:]]|$)'
              or segment.value ~ '(加拿大|كندا|کینیڈا)' then 'canada'
            when lower(segment.value) ~ '(^|[^[:alpha:]])china([^[:alpha:]]|$)'
              or segment.value ~ '(中国|中國|الصين|چین)' then 'china'
            when lower(segment.value) ~ '(united states|\bu\.?s\.?a?\b)'
              or segment.value ~ '(美国|美國|الولايات المتحدة|امریکہ)' then 'united_states'
            when lower(segment.value) ~ '(united kingdom|\bu\.?k\.?\b|britain)'
              or segment.value ~ '(英国|英國|المملكة المتحدة|برطانیہ)' then 'united_kingdom'
            when lower(segment.value) ~ '(^|[^[:alpha:]])india([^[:alpha:]]|$)'
              or segment.value ~ '(印度|الهند|بھارت|انڈیا)' then 'india'
            when lower(segment.value) ~ '(^|[^[:alpha:]])pakistan([^[:alpha:]]|$)'
              or segment.value ~ '(巴基斯坦|باكستان|پاکستان)' then 'pakistan'
            when lower(segment.value) ~ '(^|[^[:alpha:]])bangladesh([^[:alpha:]]|$)'
              or segment.value ~ '(孟加拉国|孟加拉國|بنغلاديش|بنگلہ دیش)' then 'bangladesh'
            when lower(segment.value) ~ '(^|[^[:alpha:]])myanmar([^[:alpha:]]|$)|(^|[^[:alpha:]])burma([^[:alpha:]]|$)'
              or segment.value ~ '(缅甸|緬甸|ميانمار|میانمار)' then 'myanmar'
            when lower(segment.value) ~ '(^|[^[:alpha:]])somalia([^[:alpha:]]|$)'
              or segment.value ~ '(索马里|索馬里|الصومال|صومالیہ)' then 'somalia'
            when lower(segment.value) ~ '(^|[^[:alpha:]])turkey([^[:alpha:]]|$)|(^|[^[:alpha:]])türkiye([^[:alpha:]]|$)'
              or segment.value ~ '(土耳其|تركيا|ترکی)' then 'turkiye'
            when lower(segment.value) ~ '(^|[^[:alpha:]])vietnam([^[:alpha:]]|$)'
              or segment.value ~ '(越南|فيتنام|ویتنام)' then 'vietnam'
            else null
        end as normalized_country,
        case
            when lower(segment.value) ~ '(university|college|uni\.?|student)'
              or segment.value ~ '(大学生|大學生|学生|學生|طالب|طالبہ|طالب علم)'
                then 'student'
            when lower(segment.value) ~ 'warehouse\s+supervisor'
                then 'warehouse_supervisor'
            when lower(segment.value) ~ 'professor'
              or segment.value ~ '(教授|أستاذ جامعي|پروفیسر)'
                then 'professor'
            when lower(segment.value) ~ 'teacher'
              or segment.value ~ '(教师|教師|老师|老師|معلم|استاد)' then 'teacher'
            when lower(segment.value) ~ 'driver'
              or segment.value ~ '(司机|司機|سائق|ڈرائیور)' then 'driver'
            when lower(segment.value) ~ 'worker'
              or segment.value ~ '(工人|عامل|مزدور)' then 'worker'
            else null
        end as normalized_social_identity,
        case
            when substring(segment.value from '([0-9]{1,3})') is not null
             and substring(segment.value from '([0-9]{1,3})')::integer between 0 and 130
             and segment.value !~ '[0-9]{4}'
                then substring(segment.value from '([0-9]{1,3})')::integer
            else null
        end as extracted_age,
        case
            when substring(segment.value from '([12][0-9]{3})') is not null
             and substring(segment.value from '([12][0-9]{3})')::integer
                    between 1900 and extract(year from coalesce(context.answer_timestamp, now()))::integer
             and not (
                segment.value ~* '(born\s+(in\s+)?[12][0-9]{3}|birth\s*year\s*[:：]?\s*[12][0-9]{3})'
                or segment.value ~ '([12][0-9]{3})年(出生|生)'
             )
                then substring(segment.value from '([12][0-9]{3})')::integer
            else null
        end as extracted_year
    from descriptor_context as context
    left join lateral unnest(context.answer_segments) with ordinality
        as segment(value, ordinality) on true
),
aggregated as (
    select
        session_id,
        active_design_id,
        question_message_id,
        question_text,
        answer_message_id,
        raw_answer,
        answer_timestamp,
        answer_state,
        (array_agg(extracted_age order by segment_order)
            filter (where extracted_age is not null))[1] as age,
        (array_agg(segment order by segment_order)
            filter (where extracted_age is not null))[1] as age_segment,
        (array_agg(normalized_social_identity order by segment_order)
            filter (where normalized_social_identity is not null))[1]
            as social_identity,
        (array_agg(segment order by segment_order)
            filter (where normalized_social_identity is not null))[1]
            as social_identity_segment,
        (array_agg(normalized_country order by segment_order)
            filter (where normalized_country is not null))[1]
            as country_of_origin,
        (array_agg(normalized_country order by segment_order)
            filter (where normalized_country is not null))[2]
            as current_country,
        (array_agg(segment order by segment_order)
            filter (where normalized_country is not null))[1]
            as country_of_origin_segment,
        (array_agg(segment order by segment_order)
            filter (where normalized_country is not null))[2]
            as current_country_segment,
        (array_agg(extracted_year order by segment_order)
            filter (where extracted_year is not null))[1] as move_year,
        (array_agg(segment order by segment_order)
            filter (where extracted_year is not null))[1] as move_year_segment
    from segment_values
    group by
        session_id,
        active_design_id,
        question_message_id,
        question_text,
        answer_message_id,
        raw_answer,
        answer_timestamp,
        answer_state
),
normalized as (
    select
        aggregated.*,
        case
            when coalesce(
                (regexp_match(raw_answer, '(?i)born\s+(?:in\s+)?([12][0-9]{3})'))[1],
                (regexp_match(raw_answer, '(?i)birth\s*year\s*[:：]?\s*([12][0-9]{3})'))[1],
                (regexp_match(raw_answer, '([12][0-9]{3})年(?:出生|生)'))[1]
            ) is not null then coalesce(
                (regexp_match(raw_answer, '(?i)born\s+(?:in\s+)?([12][0-9]{3})'))[1],
                (regexp_match(raw_answer, '(?i)birth\s*year\s*[:：]?\s*([12][0-9]{3})'))[1],
                (regexp_match(raw_answer, '([12][0-9]{3})年(?:出生|生)'))[1]
            )::integer
            else null
        end as explicit_birth_year,
        case
            when answer_state <> 'answered' or age is null then null
            else extract(year from answer_timestamp)::integer - age - 1
        end as earliest_birth_year,
        case
            when answer_state <> 'answered' or age is null then null
            else extract(year from answer_timestamp)::integer - age
        end as latest_birth_year
    from aggregated
),
resolved as (
    select
        normalized.*,
        case
            when explicit_birth_year is not null then
                case
                    when explicit_birth_year >= 2000 then 'post_2000s'
                    when explicit_birth_year >= 1990 then 'post_1990s'
                    when explicit_birth_year >= 1980 then 'post_1980s'
                    when explicit_birth_year >= 1970 then 'post_1970s'
                    when explicit_birth_year >= 1960 then 'post_1960s'
                    else 'pre_1960s'
                end
            when earliest_birth_year >= 2000 and latest_birth_year >= 2000
                then 'post_2000s'
            when earliest_birth_year between 1990 and 1999
             and latest_birth_year between 1990 and 1999 then 'post_1990s'
            when earliest_birth_year between 1980 and 1989
             and latest_birth_year between 1980 and 1989 then 'post_1980s'
            when earliest_birth_year between 1970 and 1979
             and latest_birth_year between 1970 and 1979 then 'post_1970s'
            when earliest_birth_year between 1960 and 1969
             and latest_birth_year between 1960 and 1969 then 'post_1960s'
            when earliest_birth_year < 1960 and latest_birth_year < 1960
                then 'pre_1960s'
            when age is not null then 'unclear'
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as birth_cohort,
        case
            when age between 18 and 25 then 'age_18_25'
            when age is not null then 'not_applicable'
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as youth_status
    from normalized
),
backfill as (
    select
        resolved.*,
        case
            when answer_state = 'answered' then 'unidentified'
            else answer_state
        end as missing_status,
        case
            when answer_state = 'answered' and current_country is not null
                then current_country
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as resolved_current_country,
        case
            when answer_state = 'answered' and country_of_origin is not null
                then country_of_origin
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as resolved_country_of_origin,
        case
            when answer_state = 'answered'
             and country_of_origin is not null
             and current_country is not null
             and country_of_origin = current_country
                then 'native_country_resident'
            when answer_state = 'answered'
             and country_of_origin is not null
             and current_country is not null
             and country_of_origin <> current_country
                then 'diaspora'
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as resolved_diaspora_status,
        case
            when answer_state = 'answered' and social_identity is not null
                then social_identity
            when answer_state = 'declined' then 'declined'
            when answer_state = 'not_asked' then 'not_asked'
            else 'unidentified'
        end as resolved_social_identity
    from resolved
)
update public.participant_descriptors as descriptor
set
    current_country = coalesce(descriptor.current_country, backfill.resolved_current_country),
    current_region = coalesce(descriptor.current_region, 'not_asked'),
    country_of_origin = coalesce(descriptor.country_of_origin, backfill.resolved_country_of_origin),
    diaspora_status = coalesce(descriptor.diaspora_status, backfill.resolved_diaspora_status),
    gender = coalesce(descriptor.gender, 'not_asked'),
    age = coalesce(descriptor.age, backfill.age),
    birth_year = coalesce(descriptor.birth_year, backfill.explicit_birth_year),
    birth_cohort = coalesce(descriptor.birth_cohort, backfill.birth_cohort),
    youth_status = coalesce(descriptor.youth_status, backfill.youth_status),
    education_level = coalesce(descriptor.education_level, 'not_asked'),
    social_identity = coalesce(descriptor.social_identity, backfill.resolved_social_identity),
    additional_descriptors = (
        jsonb_strip_nulls(jsonb_build_object(
            'move_year', backfill.move_year,
            'birth_year_range', case
                when backfill.explicit_birth_year is null and backfill.age is not null
                    then jsonb_build_object(
                        'earliest', backfill.earliest_birth_year,
                        'latest', backfill.latest_birth_year,
                        'basis', 'age_and_interview_year_birthday_unknown'
                    )
                else null
            end
        )) || descriptor.additional_descriptors
    ),
    descriptor_sources = (
        jsonb_build_object(
            'current_country', jsonb_strip_nulls(jsonb_build_object(
                'status', case when backfill.current_country is not null then 'identified' else backfill.missing_status end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'extracted_segment', backfill.current_country_segment
            )),
            'current_region', jsonb_build_object('status', 'not_asked'),
            'country_of_origin', jsonb_strip_nulls(jsonb_build_object(
                'status', case when backfill.country_of_origin is not null then 'identified' else backfill.missing_status end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'extracted_segment', backfill.country_of_origin_segment
            )),
            'diaspora_status', jsonb_strip_nulls(jsonb_build_object(
                'status', case
                    when backfill.country_of_origin is not null and backfill.current_country is not null
                        then 'identified'
                    else backfill.missing_status
                end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer
            )),
            'gender', jsonb_build_object('status', 'not_asked'),
            'age', jsonb_strip_nulls(jsonb_build_object(
                'status', case when backfill.age is not null then 'identified' else backfill.missing_status end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'extracted_segment', backfill.age_segment
            )),
            'birth_year', jsonb_strip_nulls(jsonb_build_object(
                'status', case
                    when backfill.explicit_birth_year is not null then 'identified'
                    when backfill.age is not null then 'unclear'
                    else backfill.missing_status
                end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'earliest_possible_year', backfill.earliest_birth_year,
                'latest_possible_year', backfill.latest_birth_year
            )),
            'birth_cohort', jsonb_strip_nulls(jsonb_build_object(
                'status', case
                    when backfill.birth_cohort in (
                        'post_2000s', 'post_1990s', 'post_1980s',
                        'post_1970s', 'post_1960s', 'pre_1960s'
                    ) then 'identified'
                    else backfill.birth_cohort
                end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer
            )),
            'youth_status', jsonb_strip_nulls(jsonb_build_object(
                'status', case
                    when backfill.age is not null then 'identified'
                    else backfill.missing_status
                end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer
            )),
            'education_level', jsonb_build_object('status', 'not_asked'),
            'social_identity', jsonb_strip_nulls(jsonb_build_object(
                'status', case when backfill.social_identity is not null then 'identified' else backfill.missing_status end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'extracted_segment', backfill.social_identity_segment
            )),
            'additional_descriptors.move_year', jsonb_strip_nulls(jsonb_build_object(
                'status', case when backfill.move_year is not null then 'identified' else backfill.missing_status end,
                'source_question_message_id', backfill.question_message_id,
                'source_message_id', backfill.answer_message_id,
                'raw_answer', backfill.raw_answer,
                'extracted_segment', backfill.move_year_segment
            ))
        ) || descriptor.descriptor_sources
    )
from backfill
where descriptor.session_id = backfill.session_id;
