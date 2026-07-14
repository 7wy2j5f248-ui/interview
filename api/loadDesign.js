import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
  const { data: activeDesign, error: activeDesignError } = await supabase
    .from("active_design")
    .select("active_design_id")
    .limit(1)
    .single();
  if (activeDesignError) {
    return res.status(500).json({ error: activeDesignError.message });
  }

  const { data, error } = await supabase
    .from("research_designs")
    .select("*")
    .eq("id", activeDesign.active_design_id)
    .single();

  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json(data);
  }
