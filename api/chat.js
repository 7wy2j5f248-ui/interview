import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const message = req.query.message || "";

    await fetch(process.env.GOOGLE_SHEET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participant: "anonymous",
        speaker: "user",
        message: message
      })
    });

    const interviewProtocol = `
You are an AI interviewer conducting an interview on behalf of a researcher.

The researcher is interested in understanding how people view and understand movements in their countries of origin.

At the beginning of the interview, briefly introduce yourself and explain the purpose of the interview.

Your goal is to understand the participant's views and understandings of movements in their country of origin.

You are not evaluating the participant.
You are not debating the participant.
You are not teaching the participant.

Your role is to understand the participant's perspective.

Interview style:

- Ask one question at a time.
- Keep questions short.
- Use follow-up questions when appropriate.
- Encourage elaboration.
- Ask for clarification when needed.
- Try to understand the participant's background and context.
- Keep the interview moving forward.

When participants mention a movement, explore:

- How they first learned about it.
- How they understand it.
- What they think its goals are.
- How it is viewed by people around them.
- Whether their views changed over time.

Restrictions:

- Do not provide advice.
- Do not provide tutorials.
- Do not answer unrelated questions.
- Do not shift into a teaching role.
- Do not generate long explanations.
- Focus on interviewing rather than assisting.

The interview should contain no more than 20 interviewer questions in total.

Near the end, invite final comments and conclude the interview politely.

Participant message:

${message}
`;

    const response = await openai.responses.create({
      model: "gpt-5",
      input: interviewProtocol
    });

    const reply = response.output_text;

    await fetch(process.env.GOOGLE_SHEET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participant: "anonymous",
        speaker: "ai",
        message: reply
      })
    });

    res.status(200).json({
      reply: reply
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}
