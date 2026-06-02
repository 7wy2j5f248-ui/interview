import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const message = req.query.message || "Hello";

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

    const response = await openai.responses.create({
      model: "gpt-5",
      input: message
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
