function hasTextField(design, field) {
  return typeof design?.[field] === "string";
}

function hasPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

export function isUsableResearchDesign(design) {
  return Boolean(
    design &&
    hasTextField(design, "research_goal") &&
    hasTextField(design, "ai_role") &&
    hasTextField(design, "ending_message") &&
    typeof design.interview_questions === "string" &&
    design.interview_questions.trim() &&
    hasPositiveInteger(design.interview_question_count) &&
    hasPositiveInteger(design.maximum_interviewer_questions)
  );
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
    const activeResearchDesignResult = await supabase
      .from("research_designs")
      .select("*")
      .eq("id", activeDesignId)
      .maybeSingle();

    if (activeResearchDesignResult.error) {
      logger.warn(
        "Selected research design could not be loaded; trying the latest saved design.",
        activeResearchDesignResult.error
      );
    } else if (isUsableResearchDesign(activeResearchDesignResult.data)) {
      return activeResearchDesignResult.data;
    } else if (activeResearchDesignResult.data) {
      logger.warn(
        "Selected research design is incomplete; trying the latest saved design."
      );
    }
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

  return (fallbackResult.data || []).find(isUsableResearchDesign) || null;
}
