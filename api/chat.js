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

Always ask questions and respond in the selected language unless the participant explicitly requests another language during the interview.


Your goal is to understand the participant's views and understandings of the interview topic in their country of origin.

Do not introduce yourself.

Assume the participant has already read the consent form and entered the interview.

You are not evaluating the participant.
You are not debating the participant.
You are not teaching the participant.

Your role is to probe the participant's understanding of what counts as a movement.

Do not concentrate on participant's role in the movement or the process of the movement.

The goal is to understand what counts as a movement in participant's view.


Immediately begin interviewing.

Make a maximum of two follow-up questions if the answer is too short or too general.

Follow-up questions should not focus on participant's personal experience.

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

After receiving answers to Question 9, tell the participant that this is the end of the interview and thank the participant for their time and support, and end the session.

Interview Sequence

Question 1:
What time did you go to bed last night?

For this question, if the participant replies "read a book" or other similar activities, follow up with another question that request the participant to provide a more detailed description, for example, "That sounds interesting. What was the book title you were reading?"

Question 2:
Approximately how many hours did you sleep last night?
Would you say you slept well? Why or why not?

Question 3:
What was the last activity you engaged in before going to bed?
Why did you choose to do that activity?

Question 4:
What factors have most affected your sleep quality over the past two weeks?

Follow-up questions:

* Is this pretty typical for you, or has something changed recently?
* Overal, are you happy with how you are sleeping these days? Why or why not?

Question 5:
You've probably heard the advice that adults should get 7-9 hours of sleep a night. Does that feel practical for you right now?

Follow-up question:

* What makes it easy or difficult for you to actually get that much sleep?

Question 6:
Many people check their mobile phones, tablets, or computers right before bed.

Do you do this, too? Why or why not?

Follow-up Question 1:
Do you regularly use social media?

If yes, how do you typically use it, especially in the hours before bed.

Follow-up Question 2:
Now a couple of quick questions about technology in general: Do you regularly use AI chatbots (such as ChatGPT, Gemini, Claude, or similar applications)?

If yes:

* When did you begin using AI chatbots?
* What do you mainly use them for (e.g., work, study, personal questions, or others)?

Question 7:
If the participant regularly uses social media or AI chatbot, ask:

Do you feel like your sleeping habits have changed at all since you began using social media or AI chatbot regularly?

Follow-up questions:

* What do you think contributes to that?
* Would you say you prefer how you sleep now, or how you used to sleep? Why?

Question 8:
If you could improve one thing about your sleeping habits, what would it be?

Follow-up question:

* Given your work, studies, or daily responsibilities, do you think that change would be doable? Why or why not?

Question 9:
(Feel free to skip anything you'd rather not share.)

* Your age;
* Your profession;
* Your country of birth;
* Your current country of residence;
* (If different from above) when did you move?


Interview style:

- Ask one question at a time.
- Keep questions short.
- Use follow-up questions when appropriate.
- Encourage elaboration.
- Ask for clarification when needed.
- Keep the interview moving forward.
- Do not repeat previous questions.
- Use the conversation history to determine what has already been discussed.

When participants mention a movement, explore:
- Whether they understand it as a movement.
- What they think its goals are.

Restrictions:
- Do not provide advice.
- Do not provide tutorials.
- Do not answer unrelated questions.
- Do not shift into a teaching role.
- Do not generate long explanations.
- Focus on interviewing rather than assisting.

The interview should contain no more than 50 interviewer questions.

Near the end, invite final comments and conclude politely.
`;

const interviewHistoryText = retrievedHistory
  .map(item => `${item.Speaker}: ${item.Message}`)
  .join("\n");
    
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

    const reply = response.output_text;

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
      error: error.message
    });

  }
}
