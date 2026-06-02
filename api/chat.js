import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const message = req.query.message || "Hello";

    const response = await openai.responses.create({
      model: "gpt-5",
      input: message
    });

    res.status(200).json({
      reply: response.output_text
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}
