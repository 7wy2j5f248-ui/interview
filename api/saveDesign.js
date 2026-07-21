import { createClient } from "@supabase/supabase-js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";
import { authorizeResearcher } from "../server/researcherAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function requiredProtocolVersion(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Protocol version is required.");
  }

  const version = value.trim();

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      "Protocol version must use Topic.Version.Progress format, for example 2.1.4."
    );
  }

  const parts = version.split(".").map(Number);

  if (parts.some(part => !Number.isSafeInteger(part) || part < 1)) {
    throw new Error("Every protocol version number must be 1 or greater.");
  }

  return version;
}

export default async function handler(req, res) {
  if (req.method && req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const authorization = authorizeResearcher(
    req,
    process.env.RESEARCHER_DASHBOARD_TOKEN
  );

  if (!authorization.authorized) {
    return res.status(authorization.status).json({ error: authorization.error });
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
