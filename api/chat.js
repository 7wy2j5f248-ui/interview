import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { selectUsableResearchDesign } from "./researchDesign.js";

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

export async function handleChat(
  req,
  res,
  { openaiClient, supabaseClient }
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
    const language = valueOrFallback(body.language, "en");
    const design = await selectUsableResearchDesign(supabaseClient);

    if (!design) {
      throw new Error("No usable research design is available.");
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
`;

const interviewHistoryText = retrievedHistory
  .map(item => `${item.Speaker}: ${item.Message}`)
  .join("\n");

    
    const response = await openaiClient.responses.create({
      model: "gpt-5.1",
      input: [
        {
          role: "system",
                  content:
            interviewProtocol +
            "\n\nSelected interview language: " + language +
            "\n\nPrevious interview history:\n" +
            interviewHistoryText
        },
        ...requestHistory
      ]
    });

    const reply = extractReplyText(response);

    if (!reply) {
      throw new Error("OpenAI returned an empty interview reply.");
    }

    const timestamp = new Date().toISOString();
    const { error: persistenceError } = await supabaseClient
      .from("interview_messages")
      .insert([
        {
          Participant: participantId,
          Session: sessionId,
          Language: language,
          Speaker: "user",
          Message: message,
          Timestamp: timestamp
        },
        {
          Participant: participantId,
          Session: sessionId,
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

    return res.status(200).json({
      reply
    });

  } catch (error) {

    console.error("Interview request failed:", error);

    return res.status(500).json({
      error: "Unable to complete the interview request."
    });

  }
}

export default async function handler(req, res) {
  const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  const supabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  return handleChat(req, res, { openaiClient, supabaseClient });
}
