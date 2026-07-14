import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
const { data, error } = await supabase
  .from("research_designs")
  .select("*")
  .eq("id", "cf4badd5-5b96-406a-aebf-c62dc6573863")
  .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json(data);
  }
