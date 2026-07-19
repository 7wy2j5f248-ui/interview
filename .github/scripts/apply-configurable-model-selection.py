from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path, old, new):
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:80]!r}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


def write(path, content):
    file_path = ROOT / path
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content, encoding="utf-8")


write(
    "server/modelConfiguration.js",
    '''export const DEFAULT_OPENAI_MODEL = "gpt-5.1";

const OPENAI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidOpenAIModelId(value) {
    return typeof value === "string"
        && OPENAI_MODEL_ID_PATTERN.test(value.trim());
}

export function normalizeOpenAIModel(
    value,
    fallback = DEFAULT_OPENAI_MODEL
) {
    const candidate = typeof value === "string" && value.trim()
        ? value.trim()
        : fallback;

    if (!isValidOpenAIModelId(candidate)) {
        throw new Error(
            "OpenAI model ID must contain only letters, numbers, periods, underscores, colons, or hyphens."
        );
    }

    return candidate;
}
'''
)

replace_once(
    "design.html",
    '''<h2>AI Interview Configuration</h2>

<label for="aiRole"><strong>AI Role</strong></label>''',
    '''<h2>AI Interview Configuration</h2>

<label for="interviewModel"><strong>Interview Model</strong></label>
<p>Enter the exact OpenAI model ID to use for interviews. The selected model is stored with this research design.</p>
<input type="text" id="interviewModel" value="gpt-5.1" autocomplete="off" style="width:100%;padding:10px;margin-bottom:16px;box-sizing:border-box;">

<label for="aiRole"><strong>AI Role</strong></label>'''
)

replace_once(
    "design.js",
    '''        interviewTopic: document.getElementById("interviewTopic").value,

        interviewQuestions:''',
    '''        interviewTopic: document.getElementById("interviewTopic").value,

        interviewModel: document.getElementById("interviewModel").value,

        interviewQuestions:'''
)

write(
    "api/saveDesign.js",
    '''import { createClient } from "@supabase/supabase-js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method && req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const design = req.body || {};
  let interviewModel;

  try {
    interviewModel = normalizeOpenAIModel(design.interviewModel);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const { error } = await supabase
    .from("research_designs")
    .insert([{
      research_title: design.researchTitle,
      research_purpose: design.researchPurpose,
      interview_topic: design.interviewTopic,
      interview_model: interviewModel,
      interview_questions: design.interviewQuestions,
      ai_role: design.aiRole,
      research_goal: design.researchGoal,
      ending_message: design.endingMessage,
      interview_question_count: Number(design.interviewQuestionCount),
      maximum_interviewer_questions: Number(design.maximumInterviewerQuestions)
    }]);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    message: `Research design saved with interview model ${interviewModel}.`
  });
}
'''
)

write(
    "server/researchDesign.js",
    '''import { normalizeOpenAIModel } from "./modelConfiguration.js";

function hasTextField(design, field) {
  return typeof design?.[field] === "string";
}

function hasPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

function normalizedResearchDesign(design) {
  if (!design) {
    return null;
  }

  try {
    return {
      ...design,
      interview_model: normalizeOpenAIModel(design.interview_model)
    };
  } catch {
    return null;
  }
}

export function isUsableResearchDesign(design) {
  const normalized = normalizedResearchDesign(design);

  return Boolean(
    normalized &&
    hasTextField(normalized, "research_goal") &&
    hasTextField(normalized, "ai_role") &&
    hasTextField(normalized, "ending_message") &&
    typeof normalized.interview_questions === "string" &&
    normalized.interview_questions.trim() &&
    hasPositiveInteger(normalized.interview_question_count) &&
    hasPositiveInteger(normalized.maximum_interviewer_questions)
  );
}

export async function selectUsableResearchDesign(
  supabase,
  { logger = console } = {}
) {
  const activeDesignResult = await supabase
    .from("active_design")
    .select("active_design_id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeDesignResult.error) {
    logger.warn(
      "Active research design lookup failed; trying the latest saved design.",
      activeDesignResult.error
    );
  }

  const activeDesignId = activeDesignResult.data?.active_design_id;

  if (activeDesignId) {
    const activeResearchDesignResult = await supabase
      .from("research_designs")
      .select("*")
      .eq("id", activeDesignId)
      .maybeSingle();

    if (activeResearchDesignResult.error) {
      logger.warn(
        "Selected research design could not be loaded; trying the latest saved design.",
        activeResearchDesignResult.error
      );
    } else if (isUsableResearchDesign(activeResearchDesignResult.data)) {
      return normalizedResearchDesign(activeResearchDesignResult.data);
    } else if (activeResearchDesignResult.data) {
      logger.warn(
        "Selected research design is incomplete; trying the latest saved design."
      );
    }
  }

  const fallbackResult = await supabase
    .from("research_designs")
    .select("*")
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(20);

  if (fallbackResult.error) {
    throw new Error("Research design fallback lookup failed.", {
      cause: fallbackResult.error
    });
  }

  return (fallbackResult.data || [])
    .map(normalizedResearchDesign)
    .find(isUsableResearchDesign) || null;
}
'''
)

write(
    "server/sessionLifecycle.js",
    '''import { normalizeOpenAIModel } from "./modelConfiguration.js";

export const DEFAULT_INTERVIEW_INACTIVITY_TIMEOUT_MINUTES = 30;

const MINIMUM_TIMEOUT_MINUTES = 1;
const MAXIMUM_TIMEOUT_MINUTES = 7 * 24 * 60;

function requiredIdentifier(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required.`);
    }

    return value.trim();
}

export function resolveInactivityTimeoutMinutes(value) {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_INTERVIEW_INACTIVITY_TIMEOUT_MINUTES;
    }

    const minutes = typeof value === "number"
        ? value
        : Number(value);

    if (!Number.isInteger(minutes)
        || minutes < MINIMUM_TIMEOUT_MINUTES
        || minutes > MAXIMUM_TIMEOUT_MINUTES) {
        throw new Error(
            "Interview inactivity timeout must be a whole number of minutes between 1 and 10080."
        );
    }

    return minutes;
}

function normalizedRequestTime(value) {
    const timestamp = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(timestamp.getTime())) {
        throw new Error("Interview request time is invalid.");
    }

    return timestamp.toISOString();
}

export async function prepareInterviewSession(
    supabaseClient,
    {
        sessionId,
        participantId,
        language,
        interviewModel,
        requestTime,
        inactivityTimeoutMinutes
    }
) {
    const timeoutMinutes = resolveInactivityTimeoutMinutes(
        inactivityTimeoutMinutes
    );
    const requestedModel = normalizeOpenAIModel(interviewModel);
    const { data, error } = await supabaseClient.rpc(
        "prepare_interview_session_with_model",
        {
            p_session_id: requiredIdentifier(sessionId, "Session"),
            p_participant_id: requiredIdentifier(
                participantId,
                "Participant"
            ),
            p_language: requiredIdentifier(language, "Language"),
            p_interview_model: requestedModel,
            p_request_at: normalizedRequestTime(requestTime),
            p_timeout_minutes: timeoutMinutes
        }
    );

    const result = Array.isArray(data) ? data[0] : data;

    if (error || !result?.accepted_session_id) {
        throw new Error("Interview session preparation failed.", {
            cause: error || undefined
        });
    }

    return {
        sessionId: result.accepted_session_id,
        previousSessionId: result.previous_session_id || null,
        expired: result.expired === true,
        created: result.created === true,
        timeoutAt: result.timeout_at || null,
        inactivityTimeoutMinutes: timeoutMinutes,
        interviewModel: normalizeOpenAIModel(
            result.selected_interview_model,
            requestedModel
        )
    };
}

export async function refreshInterviewSessionMetrics(
    supabaseClient,
    sessionId,
    inactivityTimeoutMinutes
) {
    const { data, error } = await supabaseClient.rpc(
        "refresh_interview_session_metrics",
        {
            p_session_id: requiredIdentifier(sessionId, "Session"),
            p_timeout_minutes: resolveInactivityTimeoutMinutes(
                inactivityTimeoutMinutes
            )
        }
    );

    if (error || data !== true) {
        throw new Error("Interview session timing persistence failed.", {
            cause: error || undefined
        });
    }
}
'''
)

replace_once(
    "api/chat.js",
    '''    language,
    requestTime,
    inactivityTimeoutMinutes
  }''',
    '''    language,
    interviewModel,
    requestTime,
    inactivityTimeoutMinutes
  }'''
)

replace_once(
    "api/chat.js",
    '''      language,
      requestTime,
      inactivityTimeoutMinutes
    }''',
    '''      language,
      interviewModel,
      requestTime,
      inactivityTimeoutMinutes
    }'''
)

replace_once(
    "api/chat.js",
    '''    const languageName = supportedInterviewLanguages[language];
    const requestTime = now();
    const preparedSession = await initializeInterviewSession(
      sessionSupabaseClient,
      {
        sessionId,
        participantId,
        language,
        requestTime,
        inactivityTimeoutMinutes
      }
    );

    if (preparedSession.expired) {''',
    '''    const languageName = supportedInterviewLanguages[language];
    const requestTime = now();
    const design = await selectUsableResearchDesign(supabaseClient);

    if (!design) {
      throw new Error("No usable research design is available.");
    }

    const preparedSession = await initializeInterviewSession(
      sessionSupabaseClient,
      {
        sessionId,
        participantId,
        language,
        interviewModel: design.interview_model,
        requestTime,
        inactivityTimeoutMinutes
      }
    );

    if (preparedSession.expired) {'''
)

replace_once(
    "api/chat.js",
    '''    const activeSessionId = preparedSession.sessionId;
    const design = await selectUsableResearchDesign(supabaseClient);

    if (!design) {
      throw new Error("No usable research design is available.");
    }

    const lastHistoryItem''',
    '''    const activeSessionId = preparedSession.sessionId;

    const lastHistoryItem'''
)

replace_once(
    "api/chat.js",
    '''      model: "gpt-5.1",''',
    '''      model: preparedSession.interviewModel,'''
)

replace_once(
    "server/analysisCore.js",
    '''import { storedIdentifier } from "./corpus.js";

export const QUALITATIVE_ANALYSIS_MODEL = "gpt-5.1";''',
    '''import { storedIdentifier } from "./corpus.js";
import { DEFAULT_OPENAI_MODEL } from "./modelConfiguration.js";

export const QUALITATIVE_ANALYSIS_MODEL = DEFAULT_OPENAI_MODEL;'''
)

replace_once(
    "api/analysis.js",
    '''import { authorizeResearcher } from "../server/researcherAuth.js";
''',
    '''import { authorizeResearcher } from "../server/researcherAuth.js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";
'''
)

replace_once(
    "api/analysis.js",
    '''function analysisCompletionFilter(value) {
    try {
        return normalizeCompletionFilter(value);
    } catch (error) {
        throw new AnalysisError(400, error.message);
    }
}

function operationalStatus(error) {''',
    '''function analysisCompletionFilter(value) {
    try {
        return normalizeCompletionFilter(value);
    } catch (error) {
        throw new AnalysisError(400, error.message);
    }
}

function analysisModel(value) {
    try {
        return normalizeOpenAIModel(value);
    } catch (error) {
        throw new AnalysisError(400, error.message);
    }
}

function operationalStatus(error) {'''
)

replace_once(
    "api/analysis.js",
    '''    if (!openaiClient) {
        throw new AnalysisError(500, "Server configuration is incomplete.");
    }

    const period = analysisPeriod(req.body?.start, req.body?.end);''',
    '''    if (!openaiClient) {
        throw new AnalysisError(500, "Server configuration is incomplete.");
    }

    const model = analysisModel(req.body?.model);
    const period = analysisPeriod(req.body?.start, req.body?.end);'''
)

replace_once(
    "api/analysis.js",
    '''            model: QUALITATIVE_ANALYSIS_MODEL,''',
    '''            model,'''
)

replace_once(
    "api/analysis.js",
    '''            const result = await generateSuggestionsForBatch(
                openaiClient,
                batches[index].messages
            );''',
    '''            const result = await generateSuggestionsForBatch(
                openaiClient,
                batches[index].messages,
                { model }
            );'''
)

replace_once(
    "api/analysis.js",
    '''    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {''',
    '''    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);
    const run = await loadRun(supabaseClient, item.analysis_run_id);

    if (item.status === "archived") {'''
)

replace_once(
    "api/analysis.js",
    '''            const result = await collectEvidenceForBatch(
                openaiClient,
                batches[index].messages,
                instruction
            );''',
    '''            const result = await collectEvidenceForBatch(
                openaiClient,
                batches[index].messages,
                instruction,
                { model: analysisModel(run.model) }
            );'''
)

replace_once(
    "api/analysis.js",
    '''    const run = await loadRun(supabaseClient, item.analysis_run_id);
    await supabaseClient
        .from(ANALYSIS_TABLES.runs)''',
    '''    await supabaseClient
        .from(ANALYSIS_TABLES.runs)'''
)

replace_once(
    "researcher.html",
    '''    <div id="analysisWorkspace" hidden>
        <div class="actionRow">
            <button id="generateAnalysisButton" type="button">''',
    '''    <div id="analysisWorkspace" hidden>
        <div class="actionRow">
            <label>
                Analysis model
                <input id="analysisModel" type="text" value="gpt-5.1" autocomplete="off">
            </label>
            <button id="generateAnalysisButton" type="button">'''
)

replace_once(
    "researcher-analysis.js",
    '''    const runSelect = document.getElementById("analysisRunSelect");
    const evidenceDialog''',
    '''    const runSelect = document.getElementById("analysisRunSelect");
    const analysisModel = document.getElementById("analysisModel");
    const evidenceDialog'''
)

replace_once(
    "researcher-analysis.js",
    '''            option.textContent = `${new Date(run.created_at).toLocaleString()} — ${run.status}`;''',
    '''            option.textContent = `${new Date(run.created_at).toLocaleString()} — ${run.model} — ${run.status}`;'''
)

replace_once(
    "researcher-analysis.js",
    '''            completionFilter.selectedOptions[0].textContent,
            `${workspace.run.messages_analyzed} participant messages analysed`,''',
    '''            completionFilter.selectedOptions[0].textContent,
            `Model ${workspace.run.model}`,
            `${workspace.run.messages_analyzed} participant messages analysed`,'''
)

replace_once(
    "researcher-analysis.js",
    '''                action: "generate",
                start: period.start,''',
    '''                action: "generate",
                model: analysisModel.value.trim(),
                start: period.start,'''
)

write(
    "supabase/migrations/20260719030000_add_researcher_model_selection.sql",
    '''alter table public.research_designs
add column if not exists interview_model text;

update public.research_designs
set interview_model = 'gpt-5.1'
where interview_model is null or btrim(interview_model) = '';

alter table public.research_designs
alter column interview_model set default 'gpt-5.1';

alter table public.research_designs
alter column interview_model set not null;

alter table public.research_designs
add constraint research_designs_interview_model_valid
check (interview_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

comment on column public.research_designs.interview_model is
    'Exact OpenAI model identifier selected by the researcher for interviews using this design.';

alter table public.interview_sessions
add column if not exists interview_model text;

update public.interview_sessions
set interview_model = 'gpt-5.1'
where interview_model is null or btrim(interview_model) = '';

alter table public.interview_sessions
alter column interview_model set default 'gpt-5.1';

alter table public.interview_sessions
alter column interview_model set not null;

alter table public.interview_sessions
add constraint interview_sessions_interview_model_valid
check (interview_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

comment on column public.interview_sessions.interview_model is
    'Interview model frozen when the session is first created; active sessions retain it if the research design later changes.';

create or replace function public.prepare_interview_session_with_model(
    p_session_id text,
    p_participant_id text,
    p_language text,
    p_interview_model text,
    p_request_at timestamptz,
    p_timeout_minutes integer
)
returns table (
    accepted_session_id text,
    previous_session_id text,
    expired boolean,
    created boolean,
    timeout_at timestamptz,
    selected_interview_model text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    existing_session public.interview_sessions%rowtype;
    new_session_id text;
    calculated_timeout_at timestamptz;
    normalized_model text;
begin
    normalized_model := btrim(p_interview_model);

    if nullif(btrim(p_session_id), '') is null
       or nullif(btrim(p_participant_id), '') is null
       or nullif(btrim(p_language), '') is null
       or nullif(normalized_model, '') is null
       or normalized_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or p_request_at is null
       or p_timeout_minutes is null
       or p_timeout_minutes < 1
       or p_timeout_minutes > 10080 then
        raise exception 'Invalid interview session preparation request.';
    end if;

    select session.*
    into existing_session
    from public.interview_sessions as session
    where session.session_id = btrim(p_session_id)
    for update;

    if not found then
        insert into public.interview_sessions (
            session_id,
            participant_id,
            language,
            interview_model,
            completed,
            completed_at,
            created_at,
            updated_at,
            last_activity_at,
            session_status,
            inactivity_timeout_minutes
        ) values (
            btrim(p_session_id),
            btrim(p_participant_id),
            btrim(p_language),
            normalized_model,
            false,
            null,
            p_request_at,
            p_request_at,
            null,
            'active',
            p_timeout_minutes
        );

        return query select
            btrim(p_session_id),
            null::text,
            false,
            true,
            null::timestamptz,
            normalized_model;
        return;
    end if;

    if existing_session.participant_id <> btrim(p_participant_id) then
        raise exception 'Interview session participant does not match.';
    end if;

    calculated_timeout_at := coalesce(
        existing_session.timed_out_at,
        existing_session.ended_at,
        existing_session.last_activity_at
            + make_interval(mins => p_timeout_minutes)
    );

    if existing_session.session_status in ('timed_out', 'abandoned')
       or (
            existing_session.last_activity_at is not null
            and p_request_at > existing_session.last_activity_at
                + make_interval(mins => p_timeout_minutes)
       ) then
        if not existing_session.completed
           and existing_session.session_status = 'active' then
            calculated_timeout_at := existing_session.last_activity_at
                + make_interval(mins => p_timeout_minutes);

            update public.interview_sessions
            set
                session_status = 'timed_out',
                end_reason = 'inactivity_timeout',
                timed_out_at = calculated_timeout_at,
                ended_at = calculated_timeout_at
            where session_id = existing_session.session_id;
        end if;

        new_session_id := 'S'
            || floor(extract(epoch from p_request_at) * 1000)::bigint::text
            || '-'
            || replace(gen_random_uuid()::text, '-', '');

        insert into public.interview_sessions (
            session_id,
            participant_id,
            language,
            interview_model,
            completed,
            completed_at,
            created_at,
            updated_at,
            last_activity_at,
            session_status,
            continuation_of_session_id,
            inactivity_timeout_minutes
        ) values (
            new_session_id,
            btrim(p_participant_id),
            btrim(p_language),
            normalized_model,
            false,
            null,
            p_request_at,
            p_request_at,
            null,
            'active',
            existing_session.session_id,
            p_timeout_minutes
        );

        return query select
            new_session_id,
            existing_session.session_id,
            true,
            true,
            calculated_timeout_at,
            normalized_model;
        return;
    end if;

    update public.interview_sessions
    set inactivity_timeout_minutes = p_timeout_minutes
    where session_id = existing_session.session_id;

    return query select
        existing_session.session_id,
        null::text,
        false,
        false,
        null::timestamptz,
        existing_session.interview_model;
end;
$$;

revoke all on function public.prepare_interview_session_with_model(
    text,
    text,
    text,
    text,
    timestamptz,
    integer
)
from public, anon, authenticated, service_role;

grant execute on function public.prepare_interview_session_with_model(
    text,
    text,
    text,
    text,
    timestamptz,
    integer
)
to service_role;
'''
)

replace_once(
    "tests/session-inactivity-duration.test.mjs",
    '''            assert.equal(name, "prepare_interview_session");''',
    '''            assert.equal(name, "prepare_interview_session_with_model");'''
)

replace_once(
    "tests/session-inactivity-duration.test.mjs",
    '''                    timeout_at: "2026-07-18T12:30:00.000Z"
                }],''',
    '''                    timeout_at: "2026-07-18T12:30:00.000Z",
                    selected_interview_model: "gpt-5.1"
                }],'''
)

replace_once(
    "tests/session-descriptor-foundation.test.mjs",
    '''        maximum_interviewer_questions: 3
    };''',
    '''        maximum_interviewer_questions: 3,
        interview_model: "gpt-5.1"
    };'''
)

replace_once(
    "tests/session-descriptor-foundation.test.mjs",
    '''            if (name === "prepare_interview_session") {
                return {
                    data: [{
                        accepted_session_id: "session-1",
                        previous_session_id: null,
                        expired: false,
                        created: true,
                        timeout_at: null
                    }],''',
    '''            if (name === "prepare_interview_session_with_model") {
                return {
                    data: [{
                        accepted_session_id: "session-1",
                        previous_session_id: null,
                        expired: false,
                        created: true,
                        timeout_at: null,
                        selected_interview_model: "gpt-5.1"
                    }],'''
)

replace_once(
    "tests/session-descriptor-foundation.test.mjs",
    '''                async create() {
                    return {''',
    '''                async create(options) {
                    assert.equal(options.model, "gpt-5.1");
                    return {'''
)

replace_once(
    "tests/session-descriptor-foundation.test.mjs",
    '''    assert.equal(calls[0].name, "prepare_interview_session");''',
    '''    assert.equal(calls[0].name, "prepare_interview_session_with_model");
    assert.equal(calls[0].args.p_interview_model, "gpt-5.1");'''
)

write(
    "tests/model-selection.test.mjs",
    '''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    DEFAULT_OPENAI_MODEL,
    isValidOpenAIModelId,
    normalizeOpenAIModel
} from "../server/modelConfiguration.js";
import { isUsableResearchDesign } from "../server/researchDesign.js";

test("normalizes configurable OpenAI model identifiers", () => {
    assert.equal(DEFAULT_OPENAI_MODEL, "gpt-5.1");
    assert.equal(normalizeOpenAIModel(" gpt-5.1-mini "), "gpt-5.1-mini");
    assert.equal(normalizeOpenAIModel(""), DEFAULT_OPENAI_MODEL);
    assert.equal(isValidOpenAIModelId("provider:model-v2.1"), true);
    assert.equal(isValidOpenAIModelId("bad model"), false);
    assert.throws(() => normalizeOpenAIModel("bad/model"), /model ID/);
});

test("legacy and configured research designs remain usable", () => {
    const base = {
        research_goal: "Understand participant experience.",
        ai_role: "Ask neutral questions.",
        ending_message: "Thank the participant.",
        interview_questions: "1. What happened?",
        interview_question_count: 1,
        maximum_interviewer_questions: 3
    };

    assert.equal(isUsableResearchDesign(base), true);
    assert.equal(isUsableResearchDesign({
        ...base,
        interview_model: "gpt-5.1-mini"
    }), true);
    assert.equal(isUsableResearchDesign({
        ...base,
        interview_model: "bad model"
    }), false);
});

test("researcher interfaces select separate interview and analysis models", async () => {
    const [designHtml, designJs, researcherHtml, researcherAnalysis] =
        await Promise.all([
            readFile(new URL("../design.html", import.meta.url), "utf8"),
            readFile(new URL("../design.js", import.meta.url), "utf8"),
            readFile(new URL("../researcher.html", import.meta.url), "utf8"),
            readFile(new URL("../researcher-analysis.js", import.meta.url), "utf8")
        ]);

    assert.match(designHtml, /id="interviewModel"/);
    assert.match(designJs, /interviewModel:/);
    assert.match(researcherHtml, /id="analysisModel"/);
    assert.match(researcherAnalysis, /model: analysisModel\.value\.trim\(\)/);
    assert.match(researcherAnalysis, /Model \$\{workspace\.run\.model\}/);
});

test("runtime model choices are persisted and no longer hard-coded at call sites", async () => {
    const [chat, analysis, core, migration] = await Promise.all([
        readFile(new URL("../api/chat.js", import.meta.url), "utf8"),
        readFile(new URL("../api/analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../server/analysisCore.js", import.meta.url), "utf8"),
        readFile(new URL(
            "../supabase/migrations/20260719030000_add_researcher_model_selection.sql",
            import.meta.url
        ), "utf8")
    ]);

    assert.match(chat, /model: preparedSession\.interviewModel/);
    assert.doesNotMatch(chat, /model: "gpt-5\.1"/);
    assert.match(analysis, /const model = analysisModel\(req\.body\?\.model\)/);
    assert.match(analysis, /generateSuggestionsForBatch[\s\S]*\{ model \}/);
    assert.match(analysis, /collectEvidenceForBatch[\s\S]*model: analysisModel\(run\.model\)/);
    assert.match(core, /DEFAULT_OPENAI_MODEL/);
    assert.match(migration, /research_designs[\s\S]*interview_model/);
    assert.match(migration, /interview_sessions[\s\S]*interview_model/);
    assert.match(migration, /prepare_interview_session_with_model/);
    assert.match(migration, /existing_session\.interview_model/);
});
'''
)

print("Configurable model selection patch applied.")
