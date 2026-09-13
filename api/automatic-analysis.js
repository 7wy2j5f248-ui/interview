import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";
import {
    continueCaseBoundAnalysis,
    continueCaseBoundStage2A,
    continueParallelStage2,
    scheduleCaseBoundAnalysis,
    scheduleStage2Set,
    stagedAnalysisBaseUrl,
    stagedAnalysisWorkerRequestIsAuthorized
} from "../server/stagedAnalysisWorker.js";
import {
    processCaseBoundAnalysisTick,
    processParallelStage2Tick,
    processStage2ATick
} from "../server/caseBoundAnalysis.js";
import { handleCaseBoundAnalysisDashboard } from "../server/caseBoundAnalysisDashboard.js";
import {
    continueTranscriptTranslation,
    processTranscriptTranslation,
    transcriptTranslationBaseUrl,
    transcriptTranslationRequestIsAuthorized
} from "../server/transcriptTranslationQueue.js";
import { createTranslationClient } from "../server/translationProvider.js";

export const config = { maxDuration: 300 };

async function processTranslationAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
        throw new Error("Transcript translation configuration is incomplete.");
    }

    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const openaiClient = createTranslationClient();
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
    if (result.completed) {
        scheduleCaseBoundAnalysis(req);
    }
}

async function processCaseBoundAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !secretKey) {
        throw new Error("Case-bound analysis configuration is incomplete.");
    }
    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await processCaseBoundAnalysisTick(supabaseClient);
    if (result.claimed) {
        scheduleStage2Set(req);
        await continueCaseBoundAnalysis(stagedAnalysisBaseUrl(req));
    }
    return result;
}

async function processParallelStage2AndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !secretKey) {
        throw new Error("Parallel Stage 2 configuration is incomplete.");
    }
    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await processParallelStage2Tick(supabaseClient);
    if (result.active) {
        await continueParallelStage2(stagedAnalysisBaseUrl(req));
    }
    return result;
}

async function processCaseBoundStage2AAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !secretKey) {
        throw new Error("Stage 2A configuration is incomplete.");
    }
    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await processStage2ATick(supabaseClient);
    if (result.active) {
        await continueCaseBoundStage2A(stagedAnalysisBaseUrl(req));
    }
    return result;
}

export default async function handler(req, res) {
    if (req.query?.view === "case-bound-v2") {
        return handleCaseBoundAnalysisDashboard(req, res);
    }
    if (["stage1-validation-rules", "advanced-preliminary"]
        .includes(req.query?.view)) {
        return res.status(410).json({
            error: "This Codex-era analytical route is permanently retired."
        });
    }

    if (req.method === "GET") return res.status(410).json({
        error: "The legacy analysis endpoint is retired. Use the staged researcher dashboard."
    });

    if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (req.body?.worker === "case-bound-stage2-set-v2") {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(Promise.all([
            processCaseBoundStage2AAndContinue(req),
            processParallelStage2AndContinue(req),
            processParallelStage2AndContinue(req)
        ]).catch(error => {
            console.error("Authorized parallel Stage 2 wake stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            processing: "stage2a_2b_2c_concurrent_execution_set"
        });
    }


    if (req.body?.worker === "case-bound-stage2a-v2-continuation") {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(processCaseBoundStage2AAndContinue(req).catch(error => {
            console.error("Stage 2A continuation stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            processing: "one_whole_cohort_stage2a_response"
        });
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

    if ([
        "case-bound-analysis-v2",
        "case-bound-analysis-v2-continuation"
    ].includes(req.body?.worker)) {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(processCaseBoundAndContinue(req).catch(error => {
            console.error("Case-bound analysis worker stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            processing: "case_bound_stage1_then_objective_stage2a_barrier"
        });
    }

    if (req.body?.worker === "case-bound-parallel-stage2-v2-continuation") {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(processParallelStage2AndContinue(req).catch(error => {
            console.error("Parallel Stage 2 worker stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            processing: "one_parallel_whole_corpus_stage2_response"
        });
    }

    return res.status(410).json({
        error: "The requested Codex-era analytical worker is permanently retired."
    });
}
