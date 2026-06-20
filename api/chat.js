import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {

    const message = req.body.message || "";
    const history = req.body.history || [];
    const participantId = req.body.participantId || "anonymous";
let retrievedHistory = [];

try {

  const historyResponse = await fetch(
    `${process.env.GOOGLE_HISTORY_URL}?participant=${participantId}`
  );

  retrievedHistory = await historyResponse.json();

} catch (err) {

  console.error("History retrieval failed:", err);

}
    
    await fetch(process.env.GOOGLE_SHEET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participant: participantId,
        speaker: "user",
        message: message
      })
    });

    const interviewProtocol = `
You are an AI interviewer conducting an interview on behalf of a researcher.

Your goal is to understand the participant's views and understandings of movements in their country of origin.

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

Interview sequence:

Question 1:
Please tell me about a movement in your country that you are familiar with.

Question 2:
Which movement do you think is the largest in scale?


Question 3:
At least 14 young migrant workers died by jumping from building ledges, bringing intense global scrutiny to harsh working conditions inside major manufacturing facilities.

Would you agree that this should be counted as a movement?

Ask follow-up questions if the participant does not explain why or why not.


Question 4:
Do you think the following should be considered a movement by your standard?

Many NGOs engaged in a "green civil society movement" and successfully pushed for changes to environmental policies.
Ask follow-up questions if the participant does not explain why or why not.

Question 5:
Do you think the following should be considered a movement by your standard?

The Beijing Women's Legal Aid and Research Center was disbanded in 2016 despite avoiding politically sensitive cases.

Question 6:
Do you think the following should be considered a movement by your standard?
The Open Constitution Initiative was disbanded in 2009. A subsequent "new citizens' movement" was later subjected to state harassment.

Question 7:
Do you think the following should be considered a movement by your standard?
Petitioners ("访民"), workers, environmental activists, and other citizens mobilized without formal organizations around grievances and public concerns.

Question 8:
Would you mind sharing your age and where were your born?

Question 9: Where do you currently live?
Ask a follow-up question if the participant lives outside their country of origin: When did you leave your country of origin?

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
  .map(item => `${item.speaker}: ${item.message}`)
  .join("\n");
    
    const response = await openai.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "system",
         content:
  interviewProtocol +
  "\n\nPrevious interview history:\n" +
  interviewHistoryText
        },
        ...history
      ]
    });

    const reply = response.output_text;

    await fetch(process.env.GOOGLE_SHEET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participant: participantId,
        speaker: "ai",
        message: reply
      })
    });

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
