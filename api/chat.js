import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
  try {

    const body = req.body || {};

const message = body.message || "";
const history = body.history || [];
const participantId = body.participantId || "anonymous";
const sessionId = body.sessionId || "unknown";
const language = body.language || "en";
let retrievedHistory = [];

try {

  const { data, error } = await supabase
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
    
  await supabase
.from("interview_messages")
.insert([
 {
    Participant: participantId,
    Session: sessionId,
    Language: language,
    Speaker: "user",
    Message: message,
    Timestamp: new Date().toISOString()
}
]);

const { data: design, error: designError } = await supabase
.from("research_designs")
.select("*")
.order("created_at", { ascending: false, nullsFirst: false })
.limit(1)
.single();

if (designError) {
  throw designError;
}

if (!design) {
  throw new Error("design is undefined");
}

if (!design.interview_questions) {
  throw new Error("interview_questions is empty");
}
 

if (typeof design.interview_questions !== "string") {
  throw new Error(`interview_questions type: ${typeof design.interview_questions}`);
}

if (design.interview_questions.trim() === "") {
  throw new Error("interview_questions is blank");
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

    
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [
        {
          role: "system",
                  content:
            interviewProtocol +
            "\n\nSelected interview language: " + language +
            "\n\nPrevious interview history:\n" +
            interviewHistoryText
        },
        ...history
      ]
    });
console.log(response.output_text);
        const reply = response.output_text || response.output?.[0]?.content?.[0]?.text || "";

  await supabase
.from("interview_messages")
.insert([
  {
    Participant: participantId,
    Session: sessionId,
    Language: language,
    Speaker: "ai",
    Message: reply,
    Timestamp: new Date().toISOString()
  }
]);
    res.status(200).json({
      reply
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
           error: String(error),
      stack: error?.stack 
    });

  }
}
