import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";
import {
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
import { createTranslationClient } from "../server/translationProvider.js";

export const config = { maxDuration: 300 };

async function processStagedAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
        throw new Error("Staged-analysis configuration is incomplete.");
    }

    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const result = await processNextAdvancedPreliminaryAnalysis(supabaseClient);

    return result;
}

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
}

export default async function handler(req, res) {
    if (req.query?.view === "advanced-preliminary"
        && (req.method === "GET"
            || (req.method === "POST"
                && ["preflight", "start", "cancel", "mark-legacy"]
                    .includes(req.body?.action)))) {
        return handleAdvancedPreliminaryDashboard(req, res);
    }

    if (req.method === "GET" && req.query?.cron === "staged") {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(processStagedAndContinue(req).catch(error => {
            console.error("Scheduled staged-analysis worker stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            processing: "fresh_independent_preliminary_case_analysis_only",
            trigger: "explicitly_authorized_run_continuation"
        });
    }

    if (req.method === "GET") return res.status(410).json({
        error: "The legacy analysis endpoint is retired. Use the staged researcher dashboard."
    });

    if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (req.body?.worker === "authorized-initial-wake") {
        const supabaseUrl = process.env.SUPABASE_URL;
        const secretKey = process.env.SUPABASE_SECRET_KEY;
        if (!supabaseUrl || !secretKey) {
            return res.status(500).json({
                error: "Staged-analysis configuration is incomplete."
            });
        }
        const supabaseClient = createClient(supabaseUrl, secretKey, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data: runId, error } = await supabaseClient.rpc(
            "consume_authorized_analysis_initial_wake"
        );
        if (error) {
            console.error("Authorized initial wake could not be consumed:", error);
            return res.status(500).json({ error: "The authorized run could not be woken." });
        }
        if (!runId) {
            return res.status(409).json({
                error: "No unused researcher-authorized run wake is available."
            });
        }
        waitUntil(processStagedAndContinue(req).catch(workerError => {
            console.error("Authorized staged-analysis wake stopped:", workerError);
        }));
        return res.status(202).json({
            accepted: true,
            runId,
            processing: "fresh_independent_preliminary_case_analysis_only",
            authorization: "single_use_researcher_authorized_run_wake"
        });
    }

    if (req.body?.worker === "authorized-run-tick") {
        const supabaseUrl = process.env.SUPABASE_URL;
        const secretKey = process.env.SUPABASE_SECRET_KEY;
        if (!supabaseUrl || !secretKey) {
            return res.status(500).json({
                error: "Staged-analysis configuration is incomplete."
            });
        }
        const supabaseClient = createClient(supabaseUrl, secretKey, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data: runId, error } = await supabaseClient.rpc(
            "consume_authorized_analysis_server_tick"
        );
        if (error) {
            console.error("Authorized server tick could not be consumed:", error);
            return res.status(500).json({ error: "The authorized run tick failed." });
        }
        if (!runId) {
            return res.status(204).end();
        }
        waitUntil(processStagedAndContinue(req).catch(workerError => {
            console.error("Authorized staged-analysis tick stopped:", workerError);
        }));
        return res.status(202).json({
            accepted: true,
            runId,
            processing: "one_durable_stage1_tick",
            authorization: "database_verified_researcher_authorized_run"
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
        processing: "fresh_independent_preliminary_case_analysis_only",
        processingOrder: "earliest_completed_first"
    });
}
