import { waitUntil } from "@vercel/functions";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    handleCaseAnalysisDashboard,
    handleCaseArchiveMutation
} from "../server/caseAnalysisDashboard.js";
import {
    automaticCaseAnalysisBaseUrl,
    continueAutomaticCaseAnalysis,
    processOldestAutomaticCase,
    workerRequestIsAuthorized
} from "../server/automaticCaseAnalysis.js";

export const config = { maxDuration: 300 };

async function processAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !secretKey || !openaiKey) {
        throw new Error("Automatic case-analysis configuration is incomplete.");
    }

    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const openaiClient = new OpenAI({ apiKey: openaiKey });
    const result = await processOldestAutomaticCase(
        supabaseClient,
        openaiClient
    );

    if (result.claimed) {
        if (!result.completed) {
            await new Promise(resolve => setTimeout(resolve, 12000));
        }
        await continueAutomaticCaseAnalysis(
            automaticCaseAnalysisBaseUrl(req)
        );
    }
}

export default async function handler(req, res) {
    if (req.method === "GET") {
        return handleCaseAnalysisDashboard(req, res);
    }

    if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (["archive", "restore"].includes(req.body?.action)) {
        return handleCaseArchiveMutation(req, res);
    }

    if (!workerRequestIsAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized." });
    }

    waitUntil(processAndContinue(req).catch(error => {
        console.error("Automatic case-analysis worker stopped:", error);
    }));

    return res.status(202).json({
        accepted: true,
        processingOrder: "earliest_completed_first"
    });
}
