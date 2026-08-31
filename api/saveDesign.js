import { createClient } from "@supabase/supabase-js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";
import { authorizeResearcher } from "../server/researcherAuth.js";
import {
  listAnalysisFrameworkWorkspace
} from "../server/analysisFramework.js";
import { scheduleAutomaticCaseAnalysis } from "../server/automaticCaseAnalysis.js";
import { cancelProjectWideReanalysisBatch } from "../server/projectWideReanalysis.js";

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
  if (req.method && !["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const authorization = authorizeResearcher(
    req,
    process.env.RESEARCHER_DASHBOARD_TOKEN
  );

  if (!authorization.authorized) {
    return res.status(authorization.status).json({ error: authorization.error });
  }

  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!process.env.SUPABASE_URL || !secretKey) {
    return res.status(500).json({ error: "Server configuration is incomplete." });
  }
  const supabase = createClient(process.env.SUPABASE_URL, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  if (req.method === "GET") {
    try {
      return res.status(200).json(await listAnalysisFrameworkWorkspace(supabase));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  const design = req.body || {};
  if (design.action === "cancel_project_wide_reanalysis") {
    try {
      return res.status(200).json(await cancelProjectWideReanalysisBatch(
        supabase,
        design.batchId,
        design.cancellationReason
      ));
    } catch (error) {
      return res.status(409).json({ error: error.message });
    }
  }
  if (design.action === "save_analysis_framework") {
    const fields = [
      "projectName",
      "researchTopic",
      "studyScope",
      "themeRequirements",
      "codeDerivationRules",
      "themeCodeFitRules",
      "inclusionRules",
      "exclusionRules",
      "provenanceExpectations"
    ];
    const missing = fields.find(field =>
      typeof design[field] !== "string" || !design[field].trim()
    );
    if (missing) {
      return res.status(400).json({
        error: "Complete every Analysis Framework field before saving."
      });
    }
    const applicationScope = design.applicationScope === "include_completed"
      ? "include_completed"
      : design.applicationScope === "future_only"
        ? "future_only"
        : null;
    if (!applicationScope) {
      return res.status(400).json({
        error: "Choose whether this framework applies only to future analysis or includes completed interviews from the same project/topic."
      });
    }
    const projectId = typeof design.projectId === "string"
      && /^[0-9a-f-]{36}$/i.test(design.projectId)
      ? design.projectId
      : null;
    const { data, error } = await supabase.rpc(
      "save_analysis_framework_version_with_batch",
      {
        p_project_id: projectId,
        p_project_name: design.projectName.trim(),
        p_research_topic: design.researchTopic.trim(),
        p_study_scope: design.studyScope.trim(),
        p_theme_requirements: design.themeRequirements.trim(),
        p_code_derivation_rules: design.codeDerivationRules.trim(),
        p_theme_code_fit_rules: design.themeCodeFitRules.trim(),
        p_inclusion_rules: design.inclusionRules.trim(),
        p_exclusion_rules: design.exclusionRules.trim(),
        p_provenance_expectations: design.provenanceExpectations.trim(),
        p_application_scope: applicationScope,
        p_version_notes: typeof design.analysisVersionNotes === "string"
          ? design.analysisVersionNotes.trim() || null
          : null
      }
    );
    const saved = Array.isArray(data) ? data[0] : data;
    if (error || !saved) {
      return res.status(409).json({
        error: error?.message || "The Analysis Framework could not be saved."
      });
    }
    if (saved.historical_requests_queued > 0) {
      scheduleAutomaticCaseAnalysis(req);
    }
    return res.status(200).json({
      message: `Analysis Framework v${saved.version_number} saved.`,
      frameworkId: saved.framework_id,
      historicalBatchId: saved.historical_batch_id || null,
      projectId: saved.project_id,
      versionNumber: saved.version_number,
      historicalRequestsQueued: saved.historical_requests_queued,
      scopeExplanation: applicationScope === "future_only"
        ? "Existing reports remain unchanged. New analysis for this project will use this version."
        : `${saved.historical_requests_queued} completed same-project cases were queued as versioned proposals. Current reports remain unchanged until explicit researcher approval.`
    });
  }
  let interviewModel;
  let protocolVersion;

  try {
    interviewModel = normalizeOpenAIModel(design.interviewModel);
    protocolVersion = requiredProtocolVersion(design.protocolVersion);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let projectId = typeof design.projectId === "string"
    && /^[0-9a-f-]{36}$/i.test(design.projectId)
    ? design.projectId
    : null;
  if (!projectId) {
    const { data: active } = await supabase
      .from("active_analysis_frameworks")
      .select("project_id")
      .limit(2);
    if ((active || []).length === 1) projectId = active[0].project_id;
  }
  if (!projectId) {
    return res.status(400).json({
      error: "Choose the named research project/topic for this interview protocol. A different topic must start a new project and Analysis Framework."
    });
  }

  const { error } = await supabase
    .from("research_designs")
    .insert([{
      project_id: projectId,
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
