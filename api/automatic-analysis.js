import { waitUntil } from "@vercel/functions";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    continueStagedAnalysis,
    stagedAnalysisBaseUrl,
    stagedAnalysisWorkerRequestIsAuthorized
} from "../server/stagedAnalysisWorker.js";
import {
    processNextAdvancedPreliminaryAnalysis
} from "../server/advancedPreliminaryAnalysis.js";
import {
    continueTranscriptTranslation,
    processTranscriptTranslation,
    transcriptTranslationBaseUrl,
    transcriptTranslationRequestIsAuthorized
} from "../server/transcriptTranslationQueue.js";
import {
    handleAdvancedPreliminaryDashboard
} from "../server/advancedPreliminaryDashboard.js";

export const config = { maxDuration: 300 };

async function processStagedAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !secretKey || !openaiKey) {
        throw new Error("Staged-analysis configuration is incomplete.");
    }

    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const openaiClient = new OpenAI({ apiKey: openaiKey });
    const result = await processNextAdvancedPreliminaryAnalysis(
        supabaseClient,
        openaiClient
    );

    if (result.claimed) {
        if (!result.completed) {
            await new Promise(resolve => setTimeout(resolve, 12000));
        }
        await continueStagedAnalysis(
            stagedAnalysisBaseUrl(req)
        );
    }
}

async function processTranslationAndContinue(req) {
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
    if (req.query?.view === "advanced-preliminary"
        && (req.method === "GET"
            || (req.method === "POST"
                && req.body?.action === "start"))) {
        return handleAdvancedPreliminaryDashboard(req, res);
    }

    if (req.method === "GET") return res.status(410).json({
        error: "The legacy analysis endpoint is retired. Use the staged researcher dashboard."
    });

    if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (req.body?.worker === "translation") {
        if (!transcriptTranslationRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }

        waitUntil(processTranslationAndContinue(req).catch(error => {
            console.error("Transcript translation worker stopped:", error);
        }));

        return res.status(202).json({
            accepted: true,
            processing: "translation_independent_from_case_analysis"
        });
    }

    if (!["staged-analysis", "staged-analysis-continuation"]
        .includes(req.body?.worker)) {
        return res.status(410).json({
            error: "The requested legacy analysis worker is retired."
        });
    }

    if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    waitUntil(processStagedAndContinue(req).catch(error => {
        console.error("Staged-analysis worker stopped:", error);
    }));

    return res.status(202).json({
        accepted: true,
        processing: "staged_meaning_units",
        processingOrder: "earliest_completed_first"
    });
}
