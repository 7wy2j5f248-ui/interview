import { createClient } from "@supabase/supabase-js";
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
