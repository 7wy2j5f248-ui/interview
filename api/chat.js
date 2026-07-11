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

    const message = req.body.message || "";
    const history = req.body.history || [];
    const participantId = req.body.participantId || "anonymous";
const sessionId = req.body.sessionId || "unknown";
    const language = req.body.language || "en";
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
console.log("Retrieved history:", retrievedHistory);
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
.order("created_at", { ascending: false })
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
    const interviewProtocol = `
You are an AI interviewer conducting an interview on behalf of a researcher.

Conduct the interview in the language specified in the "Selected interview language" field provided below.

If language is:
- "en", conduct the interview in English.
- "zh", conduct the interview in Simplified Chinese.
- "fr", conduct the interview in French.
- "es", conduct the interview in Spanish.
- "pt", conduct the interview in Portuguese.
- "hi", conduct the interview in Hindi.
- "bn", conduct the interview in Bengali.
- "vi", conduct the interview in Vietnamese.
- "ta", conduct the interview in Tamil.
- "sw", conduct the interview in Swahili.
- "ar", conduct the interview in Arabic.
- "tr", conduct the interview in Turkish.
- "ru", conduct the interview in Russian.
- "ja", conduct the interview in Japanese.

Always ask questions and respond in the selected language unless the participant explicitly requests another language during the interview.

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


If the participant is returning after a previous session and has not yet resumed the interview:

1. Welcome the participant back.
2. Briefly summarize the main topics discussed previously in no more than 3 bullet points.
3. Ask whether they wish to continue.
4. Wait for the participant's response.
5. If the participant agrees to continue, resume from the next appropriate interview question.
6. If the participant has not yet agreed, do not continue the interview questions.
7. Do not restart the interview from Question 1.

Do this only once at the beginning of a resumed session.
Do not do this during an ongoing interview.
Do not do this after the participant answers a question.
Do not do this near the conclusion of the interview.

After receiving answers to Question ${design.interview_question_count}:

${design.ending_message}

Interview Sequence

${design.interview_questions}


Interview Principles:

- Ask one question at a time.
- Keep questions short.
- Use follow-up questions when appropriate.
- Encourage elaboration.
- Ask for clarification when needed.
- Keep the interview moving forward.
- Do not repeat previous questions.
- Use the conversation history to determine what has already been discussed.



Restrictions:
- Do not provide advice.
- Do not provide tutorials.
- Do not answer unrelated questions.
- Do not shift into a teaching role.
- Do not generate long explanations.
- Focus on interviewing rather than assisting.

The interview should contain no more than ${design.maximum_interviewer_questions} interviewer questions.

Near the end, invite final comments and conclude politely.
`;

const interviewHistoryText = retrievedHistory
  .map(item => `${item.Speaker}: ${item.Message}`)
  .join("\n");
        console.log("Design loaded:", design);
    console.log("Design error:", designError);
    const response = await openai.responses.create({
      model: "gpt-5",
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
