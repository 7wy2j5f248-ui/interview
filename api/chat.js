import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { ensureParticipantDescriptor } from "../server/participantDescriptors.js";
import {
  loadResearchDesignById,
  selectUsableResearchDesign
} from "../server/researchDesign.js";
import {
  prepareInterviewSession,
  refreshInterviewSessionMetrics,
  resolveInactivityTimeoutMinutes
} from "../server/sessionLifecycle.js";
import { scheduleAutomaticCaseAnalysis } from "../server/automaticCaseAnalysis.js";

const supportedInterviewLanguages = Object.freeze({
  en: "English",
  zh: "Simplified Chinese",
  ar: "Arabic",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  tr: "Turkish",
  hi: "Hindi",
  bn: "Bengali",
  vi: "Vietnamese",
  ta: "Tamil",
  sw: "Swahili",
  ur: "Urdu",
  id: "Indonesian",
  so: "Somali",
  my: "Burmese",
  fa: "Persian / Farsi",
  prs: "Dari"
});

function valueOrFallback(value, fallback) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return null;
  }

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim()
    )
    .map(item => ({
      role: item.role,
      content: item.content.trim()
    }));
}

function normalizeInterviewLanguage(language) {
  const requestedLanguage = valueOrFallback(language, "en").toLowerCase();

  return Object.hasOwn(supportedInterviewLanguages, requestedLanguage)
    ? requestedLanguage
    : "en";
}

export function extractReplyText(response) {
  const candidates = [
    response?.output_text,
    ...(response?.output || []).flatMap(item =>
      (item?.content || []).map(content => content?.text)
    )
  ];

  return candidates.find(candidate =>
    typeof candidate === "string" && candidate.trim()
  )?.trim() || "";
}

export function parseInterviewTurn(response) {
  const outputText = extractReplyText(response);

  if (!outputText) {
    throw new Error("OpenAI returned an empty interview turn.");
  }

  let turn;

  try {
    turn = JSON.parse(outputText);
  } catch (error) {
    throw new Error("OpenAI returned invalid interview turn data.", {
      cause: error
    });
  }

  const reply = typeof turn?.reply === "string"
    ? turn.reply.trim()
    : "";

  if (!reply || typeof turn?.final_question_answered !== "boolean") {
    throw new Error("OpenAI returned incomplete interview turn data.");
  }

  return {
    reply,
    finalQuestionAnswered: turn.final_question_answered
  };
}

async function initializeInterviewSession(
  supabaseClient,
  {
    sessionId,
    participantId,
    language,
    interviewModel,
    researchDesignId,
    requestTime,
    inactivityTimeoutMinutes
  }
) {
  const preparedSession = await prepareInterviewSession(
    supabaseClient,
    {
      sessionId,
      participantId,
      language,
      interviewModel,
      researchDesignId,
      requestTime,
      inactivityTimeoutMinutes
    }
  );

  await ensureParticipantDescriptor(supabaseClient, {
    sessionId: preparedSession.sessionId,
    participantId
  });

  return preparedSession;
}

async function markInterviewSessionCompleted(supabaseClient, sessionId) {
  const { data, error } = await supabaseClient.rpc(
    "complete_interview_session",
    { p_session_id: sessionId }
  );

  if (error || data !== true) {
    throw new Error("Interview session completion persistence failed.", {
      cause: error || undefined
    });
  }
}

export async function handleChat(
  req,
  res,
  {
    openaiClient,
    supabaseClient,
    sessionSupabaseClient,
    inactivityTimeoutMinutes = 30,
    now = () => new Date()
  }
) {
  try {
    if (req.method && req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed." });
    }

    const body = req.body || {};

    const message = typeof body.message === "string"
      ? body.message.trim()
      : "";
    const history = sanitizeHistory(body.history);

    if (!message || !history) {
      return res.status(400).json({ error: "Invalid interview request." });
    }

    const participantId = valueOrFallback(body.participantId, "anonymous");
    const sessionId = valueOrFallback(body.sessionId, "unknown");
    const language = normalizeInterviewLanguage(body.language);
    const languageName = supportedInterviewLanguages[language];
    const requestTime = now();
    const activeDesign = await selectUsableResearchDesign(supabaseClient);

    if (!activeDesign) {
      throw new Error("No usable research design is available.");
    }

    const preparedSession = await initializeInterviewSession(
      sessionSupabaseClient,
      {
        sessionId,
        participantId,
        language,
        interviewModel: activeDesign.interview_model,
        researchDesignId: activeDesign.id,
        requestTime,
        inactivityTimeoutMinutes
      }
    );

    if (preparedSession.expired) {
      return res.status(409).json({
        code: "SESSION_EXPIRED",
        sessionId: preparedSession.sessionId,
        previousSessionId: preparedSession.previousSessionId,
        timeoutAt: preparedSession.timeoutAt,
        inactivityTimeoutMinutes:
          preparedSession.inactivityTimeoutMinutes
      });
    }

    const activeSessionId = preparedSession.sessionId;
    const design = await loadResearchDesignById(
      supabaseClient,
      preparedSession.researchDesignId
    );

    if (!design) {
      throw new Error("The interview session's research design is unavailable.");
    }

    const lastHistoryItem = history[history.length - 1];
    const requestHistory =
      lastHistoryItem?.role === "user" &&
      lastHistoryItem.content === message
        ? history
        : [...history, { role: "user", content: message }];

    let retrievedHistory = [];

    try {
      const { data, error } = await supabaseClient
        .from("interview_messages")
        .select("*")
        .eq("Participant", participantId)
        .order("Timestamp", { ascending: true });

      if (error) {
        console.error("Supabase retrieval error:", error);
      } else {
        retrievedHistory = data || [];
      }
    } catch (err) {
      console.error("History retrieval failed:", err);
    }

    const interviewProtocol = `
You are an AI interviewer conducting an interview on behalf of a researcher.

Conduct the interview in the selected interview language. Use that language for all questions and responses unless the participant explicitly requests another language.

${design.research_goal}

Do not introduce yourself.

Assume the participant has already read the consent form and entered the interview.

You are not evaluating the participant.
You are not debating the participant.
You are not teaching the participant.

If this is a new interview, begin with Question 1 of the Interview Sequence.

If this is a resumed interview, first follow the resumption procedure described above. After the participant agrees to continue, resume from the next unanswered interview question. Do not restart from Question 1.

${design.ai_role}

Do not invent introductory interview questions before the Interview Sequence.

The Interview Sequence provided by the researcher is the official interview protocol. Follow it in order unless a follow-up question or interview resumption is required.
When asking an interview question, ask only the question text. Do not say or display labels such as "Question 1", "Question 2", or any other question number.

If the participant is returning after a previous session and has not yet resumed the interview:

For a resumed interview, once at the beginning: welcome the participant back, summarize prior topics in no more than 3 bullet points, ask whether they wish to continue, and wait. If they agree, resume from the next unanswered question; otherwise do not continue. Never restart from Question 1.

After receiving answers to Question ${design.interview_question_count}:
${design.ending_message}

Interview Sequence
${design.interview_questions}

Interview Principles:
Ask one short question at a time. Follow the sequence in order. Use follow-ups, elaboration, or clarification when appropriate. Use conversation history to avoid repetition and determine progress.

Restrictions:
Do not advise, teach, debate, answer unrelated questions, or give long explanations. Remain an interviewer.

The interview should contain no more than ${design.maximum_interviewer_questions} interviewer questions.

Near the end, invite final comments and conclude politely.

Final canonical question state:
The Interview Sequence contains ${design.interview_question_count} canonical questions in researcher-defined order. Canonical Question ${design.interview_question_count}, the last question in that ordered sequence, is the final canonical question. Follow-up, clarification, resumption, and final-comments questions do not change which canonical question is final.

Return final_question_answered as true when the participant's current message answers that final canonical question. Return it as false when the current message answers any earlier canonical question or any follow-up, clarification, resumption, or final-comments question. Base this value only on whether the participant's current message answers the structurally final canonical question. Do not base it on the tone or wording of your reply, whether your reply sounds conclusive, the ending-message wording, whether you thank the participant, or whether you invite final comments. This value is internal machine-readable state and must never be mentioned, labelled, or exposed in the participant-facing reply.
`;

    const interviewHistoryText = retrievedHistory
      .map(item => `${item.Speaker}: ${item.Message}`)
      .join("\n");

    const response = await openaiClient.responses.create({
      model: preparedSession.interviewModel,
      text: {
        format: {
          type: "json_schema",
          name: "interview_turn",
          strict: true,
          schema: {
            type: "object",
            properties: {
              reply: {
                type: "string",
                description: "Only the natural participant-facing interviewer reply in the selected interview language."
              },
              final_question_answered: {
                type: "boolean",
                description: "True only when the participant's current message answers the last canonical question in the researcher-defined ordered Interview Sequence."
              }
            },
            required: ["reply", "final_question_answered"],
            additionalProperties: false
          }
        }
      },
      input: [
        {
          role: "system",
          content:
            interviewProtocol +
            "\n\nSelected interview language: " + languageName +
            " (" + language + ")" +
            "\n\nPrevious interview history:\n" +
            interviewHistoryText
        },
        ...requestHistory
      ]
    });

    const { reply, finalQuestionAnswered } = parseInterviewTurn(response);

    const timestamp = new Date(requestTime).toISOString();
    const { error: persistenceError } = await supabaseClient
      .from("interview_messages")
      .insert([
        {
          Participant: participantId,
          Session: activeSessionId,
          Language: language,
          Speaker: "user",
          Message: message,
          Timestamp: timestamp
        },
        {
          Participant: participantId,
          Session: activeSessionId,
          Language: language,
          Speaker: "ai",
          Message: reply,
          Timestamp: timestamp
        }
      ]);

    if (persistenceError) {
      throw new Error("Interview message persistence failed.", {
        cause: persistenceError
      });
    }

    await refreshInterviewSessionMetrics(
      sessionSupabaseClient,
      activeSessionId,
      inactivityTimeoutMinutes
    );

    if (finalQuestionAnswered) {
      await markInterviewSessionCompleted(
        sessionSupabaseClient,
        activeSessionId
      );

      // Formal completion persists the durable queue item in PostgreSQL.
      // This request only wakes the worker; a wake-up failure never loses work.
      scheduleAutomaticCaseAnalysis(req);
    }

    return res.status(200).json({
      reply,
      completed: finalQuestionAnswered
    });
  } catch (error) {
    console.error("Interview request failed:", error);

    return res.status(500).json({
      error: "Unable to complete the interview request."
    });
  }
}

export default async function handler(req, res) {
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({
      error: "Server configuration is incomplete."
    });
  }

  const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  let inactivityTimeoutMinutes;

  try {
    inactivityTimeoutMinutes = resolveInactivityTimeoutMinutes(
      process.env.INTERVIEW_INACTIVITY_TIMEOUT_MINUTES
    );
  } catch {
    return res.status(500).json({
      error: "Server configuration is incomplete."
    });
  }

  const supabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const sessionSupabaseClient = createClient(
    process.env.SUPABASE_URL,
    secretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );

  return handleChat(req, res, {
    openaiClient,
    supabaseClient,
    sessionSupabaseClient,
    inactivityTimeoutMinutes
  });
}
