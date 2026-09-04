import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";
import {
    continueCaseBoundAnalysis,
    continueStage2AHarmonization,
    scheduleCaseBoundAnalysis,
    stagedAnalysisBaseUrl,
    stagedAnalysisWorkerRequestIsAuthorized
} from "../server/stagedAnalysisWorker.js";
import { processCaseBoundAnalysisTick } from "../server/caseBoundAnalysis.js";
import { handleCaseBoundAnalysisDashboard } from "../server/caseBoundAnalysisDashboard.js";
import {
    availableAdvancedPreliminaryWorkerConcurrency,
    configuredAdvancedPreliminaryWorkerConcurrency,
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
import {
    handleStage1ValidationRulesDashboard
} from "../server/stage1ValidationRulesDashboard.js";
import { createTranslationClient } from "../server/translationProvider.js";
import { createAnalysisProviderClient } from "../server/analysisProvider.js";
import {
    processStage2ACodeHarmonization
} from "../server/stage2aCodeHarmonization.js";

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
    const { data: activeRun, error: activeRunError } = await supabaseClient
        .from("advanced_preliminary_analysis_runs")
        .select("source_case_count, completed_count")
        .in("status", ["queued", "processing"])
        .eq("operation_type", "fresh_independent_analysis")
        .eq("authoritative_source", "original_completed_transcripts")
        .eq("legacy_analysis_input", "excluded")
        .order("requested_at", { ascending: true })
        .limit(1)
        .maybeSingle();
    if (activeRunError) {
        throw new Error("Stage 1 execution capacity could not be loaded.", {
            cause: activeRunError
        });
    }
    const maximumParallelCases =
        configuredAdvancedPreliminaryWorkerConcurrency()
        || availableAdvancedPreliminaryWorkerConcurrency(activeRun);
    const results = [];
    const workerDeadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < workerDeadline) {
        const result = await processNextAdvancedPreliminaryAnalysis(
            supabaseClient,
            {
                claimFunction: "claim_available_advanced_preliminary_analysis",
                claimParameters: {
                    p_maximum_parallel_cases: maximumParallelCases
                }
            }
        );
        results.push(result);
        if (!result.claimed) break;
    }

    return {
        claimed: results.some(result => result.claimed),
        completed: results.filter(result => result.completed).length,
        activeTickOperations: results.filter(result => result.claimed).length,
        maximumParallelCases,
        concurrencySource: configuredAdvancedPreliminaryWorkerConcurrency()
            ? "technical_environment_override"
            : "active_run_remaining_workload"
    };
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
    if (result.completed) {
        scheduleCaseBoundAnalysis(req);
    }
}

async function processStage2AAndContinue(req) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const runId = typeof req.body?.runId === "string"
        ? req.body.runId.trim() : "";
    if (!supabaseUrl || !secretKey || !runId) {
        throw new Error("Stage 2A harmonization configuration is incomplete.");
    }
    const supabaseClient = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: run, error } = await supabaseClient
        .from("stage2a_code_harmonization_runs")
        .select("id, provider")
        .eq("id", runId)
        .maybeSingle();
    if (error || !run) throw new Error("The Stage 2A run could not be loaded.");
    const { client: analysisClient } = createAnalysisProviderClient(run.provider);
    const result = await processStage2ACodeHarmonization(
        supabaseClient,
        analysisClient,
        run.id
    );
    if (result.active) {
        await continueStage2AHarmonization(stagedAnalysisBaseUrl(req), run.id);
    }
    return result;
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
        await continueCaseBoundAnalysis(stagedAnalysisBaseUrl(req));
    }
    return result;
}

export default async function handler(req, res) {
    if (req.query?.view === "case-bound-v2") {
        return handleCaseBoundAnalysisDashboard(req, res);
    }
    if (req.query?.view === "stage1-validation-rules") {
        return handleStage1ValidationRulesDashboard(req, res);
    }
    if (req.query?.view === "advanced-preliminary"
        && (req.method === "GET"
            || (req.method === "POST"
                && [
                    "preflight", "start", "cancel",
                    "stage2a-preflight", "stage2a-start"
                ]
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

    if ([
        "stage2a-code-harmonization",
        "stage2a-code-harmonization-continuation"
    ].includes(req.body?.worker)) {
        if (!stagedAnalysisWorkerRequestIsAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized." });
        }
        waitUntil(processStage2AAndContinue(req).catch(error => {
            console.error("Stage 2A harmonization worker stopped:", error);
        }));
        return res.status(202).json({
            accepted: true,
            runId: req.body?.runId,
            processing: "one_whole_corpus_code_harmonization_response"
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
