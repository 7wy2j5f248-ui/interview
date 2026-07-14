import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
  const { data: activeDesign, error: activeDesignError } = await supabase
    .from("active_design")
    .select("active_design_id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeDesignError) {
    return res.status(500).json({ error: activeDesignError.message });
  }

  let designResult;

  if (activeDesign?.active_design_id) {
    designResult = await supabase
      .from("research_designs")
      .select("*")
      .eq("id", activeDesign.active_design_id)
      .maybeSingle();
  }

  if (!designResult?.data && !designResult?.error) {
    const fallbackResult = await supabase
      .from("research_designs")
      .select("*")
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(20);

    designResult = {
      data: (fallbackResult.data || []).find(design =>
        design.interview_topic?.trim() || design.research_title?.trim()
      ) || fallbackResult.data?.[0] || null,
      error: fallbackResult.error
    };
  }

  const { data, error } = designResult;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ error: "No research design has been saved." });
  }

  return res.status(200).json(data);
}
