import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
.insert([design]);
 

 const { error } = await supabase
  .from("research_designs")
  .insert([{
    research_title: design.researchTitle,
    research_purpose: design.researchPurpose,
    interview_topic: design.interviewTopic,
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
  message: "Research design saved."
});
}
