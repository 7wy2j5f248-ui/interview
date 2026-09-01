import { createClient } from "@supabase/supabase-js";
import { selectUsableResearchDesign } from "../server/researchDesign.js";
import { scheduleTranscriptTranslationBackfill } from "../server/messageTranslation.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
export default async function handler(req, res) {
  try {
    const design = await selectUsableResearchDesign(supabase);

    if (!design) {
      return res.status(404).json({
        error: "No usable research design is available."
      });
    }

    scheduleTranscriptTranslationBackfill(req);

    return res.status(200).json(design);
  } catch (error) {
    console.error("Research design loading failed:", error);
    return res.status(500).json({
      error: "Unable to load the research design."
    });
  }
}
