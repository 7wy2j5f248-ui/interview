import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
const design =
  typeof req.body === "string" ? JSON.parse(req.body) : req.body;

console.log("design =", design);
  const { error } = await supabase
  .from("research_designs")
  .insert([design]);
  if (error) {
  return res.status(500).json({ error: error.message });
}

return res.status(200).json({
  message: "Research design saved."
});
}
