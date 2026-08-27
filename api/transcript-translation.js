import { waitUntil } from "@vercel/functions";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    continueTranscriptTranslation,
    processTranscriptTranslation,
    transcriptTranslationBaseUrl,
    transcriptTranslationRequestIsAuthorized
} from "../server/transcriptTranslationQueue.js";

export const config = { maxDuration: 300 };

async function processAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !secretKey || !openaiKey) {
        throw new Error("Transcript translation configuration is incomplete.");
    }

    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const openaiClient = new OpenAI({ apiKey: openaiKey });
    const requestedSessionId = typeof req.body?.sessionId === "string"
        ? req.body.sessionId.trim() || null
        : null;
    const result = await processTranscriptTranslation(
        supabaseClient,
        openaiClient,
        requestedSessionId
    );

    if (result.claimed) {
        await continueTranscriptTranslation(
            transcriptTranslationBaseUrl(req)
        );
    }
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (!transcriptTranslationRequestIsAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    waitUntil(processAndContinue(req).catch(error => {
        console.error("Transcript translation worker stopped:", error);
    }));

    return res.status(202).json({
        accepted: true,
        processing: "translation_independent_from_case_analysis"
    });
}
