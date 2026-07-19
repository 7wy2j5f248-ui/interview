import { normalizeOpenAIModel } from "./modelConfiguration.js";

function hasTextField(design, field) {
  return typeof design?.[field] === "string";
}

function hasPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

function normalizedResearchDesign(design) {
  if (!design) {
    return null;
  }

  try {
    return {
      ...design,
      interview_model: normalizeOpenAIModel(design.interview_model)
    };
  } catch {
    return null;
  }
}

export function isUsableResearchDesign(design) {
  const normalized = normalizedResearchDesign(design);

  return Boolean(
    normalized &&
    hasTextField(normalized, "research_goal") &&
    hasTextField(normalized, "ai_role") &&
    hasTextField(normalized, "ending_message") &&
    typeof normalized.interview_questions === "string" &&
    normalized.interview_questions.trim() &&
    hasPositiveInteger(normalized.interview_question_count) &&
    hasPositiveInteger(normalized.maximum_interviewer_questions)
  );
}

export async function loadResearchDesignById(supabase, designId) {
  if (typeof designId !== "string" || !designId.trim()) {
    return null;
  }

  const result = await supabase
    .from("research_designs")
    .select("*")
    .eq("id", designId.trim())
    .maybeSingle();

  if (result.error || !isUsableResearchDesign(result.data)) {
    return null;
  }

  return normalizedResearchDesign(result.data);
}

export async function selectUsableResearchDesign(
  supabase,
  { logger = console } = {}
) {
  const activeDesignResult = await supabase
    .from("active_design")
    .select("active_design_id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeDesignResult.error) {
    logger.warn(
      "Active research design lookup failed; trying the latest saved design.",
      activeDesignResult.error
    );
  }

  const activeDesignId = activeDesignResult.data?.active_design_id;

  if (activeDesignId) {
    const activeDesign = await loadResearchDesignById(supabase, activeDesignId);

    if (activeDesign) {
      return activeDesign;
    }

    logger.warn(
      "Selected research design could not be loaded or is incomplete; trying the latest saved design."
    );
  }

  const fallbackResult = await supabase
    .from("research_designs")
    .select("*")
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(20);

  if (fallbackResult.error) {
    throw new Error("Research design fallback lookup failed.", {
      cause: fallbackResult.error
    });
  }

  return (fallbackResult.data || [])
    .map(normalizedResearchDesign)
    .find(isUsableResearchDesign) || null;
}