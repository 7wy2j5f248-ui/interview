import { createClient } from "@supabase/supabase-js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function requiredProtocolVersion(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Protocol version is required.");
  }

  const version = value.trim();

  if (version.length > 50) {
    throw new Error("Protocol version must be 50 characters or fewer.");
  }

  return version;
}

export default async function handler(req, res) {
  if (req.method && req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const design = req.body || {};
  let interviewModel;
  let protocolVersion;

  try {
    interviewModel = normalizeOpenAIModel(design.interviewModel);
    protocolVersion = requiredProtocolVersion(design.protocolVersion);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const { error } = await supabase
    .from("research_designs")
    .insert([{
      research_title: design.researchTitle,
      protocol_version: protocolVersion,
      version_notes: typeof design.versionNotes === "string"
        ? design.versionNotes.trim()
        : "",
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
    message: `Research design version ${protocolVersion} saved with interview model ${interviewModel}.`
  });
}