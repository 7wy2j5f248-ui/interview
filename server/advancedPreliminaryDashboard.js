import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    AUTHORITATIVE_SOURCE,
    EXECUTION_CONTRACT_VERSION,
    FRESH_ANALYSIS_OPERATION,
    LEGACY_ANALYSIS_INPUT,
    SLEEPING_HABITS_PROJECT_CODE
} from "./advancedPreliminaryAnalysis.js";
import { scheduleStagedAnalysis } from "./stagedAnalysisWorker.js";
import { configuredStage1Models } from "./analysisModelCatalog.js";
import { normalizeAnalysisModel } from "./modelConfiguration.js";
import {
    normalizeAnalysisProviderId,
    publicAnalysisProviderCatalog
} from "./analysisProvider.js";
import { authorizeResearcher } from "./researcherAuth.js";

export const config = { maxDuration: 300 };

const PAGE_SIZE = 50;
function availableModels() {
    return configuredStage1Models();
}

function client() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
}

async function requireData(query, message) {
    const { data, error } = await query;
    if (error) throw new Error(message, { cause: error });
    return data || [];
}

async function latestRun(supabase, requestedRunId = null) {
    let query = supabase
        .from("advanced_preliminary_analysis_runs")
        .select("id, run_number, status, source_scope, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, prior_analysis_role, stop_layer, project_snapshot, source_case_count, pending_count, processing_count, completed_count, failed_count, requested_by, requested_at, model_verified_at, started_at, completed_at, cancelled_at, cancellation_reason, updated_at, last_error, operation_type, authoritative_source, legacy_analysis_input, execution_contract_version, execution_plan_hash, rules_snapshot, automatic_continuation, maximum_analysis_calls, spending_limit_usd, spending_baseline_usd, estimated_incremental_spend_usd, input_price_usd_per_million, output_price_usd_per_million, next_call_reserve_usd, spend_guard_status, spend_guard_checked_at, resumed_at, resumed_by, resume_count, previous_cancellations, contract_transitions");
    query = requestedRunId
        ? query.eq("id", requestedRunId)
        : query.order("requested_at", { ascending: false }).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("The advanced preliminary run could not be loaded.");
    return data || null;
}

function disabledStage2() {
    return {
        run: null,
        mappings: [],
        disabled: true,
        reason: "Stage 2 is unavailable until the researcher authorizes a source contract based on exact Stage 1 outputs."
    };
}

async function loadSummary(supabase, req) {
    const models = availableModels();
    const providers = publicAnalysisProviderCatalog();
    const run = await latestRun(
        supabase,
        typeof req.query?.runId === "string" ? req.query.runId : null
    );
    if (!run) return {
        run: null,
        page: 1,
        pageSize: PAGE_SIZE,
        cases: [],
        availableProviders: providers,
        availableModels: models,
        requiredOperation: FRESH_ANALYSIS_OPERATION
    };
    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const from = (page - 1) * PAGE_SIZE;
    const jobs = await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_evidence, disposition_at, disposition_by")
            .eq("run_id", run.id)
            .order("source_completed_at", { ascending: true })
            .order("session_id", { ascending: true })
            .range(from, from + PAGE_SIZE - 1),
        "Advanced preliminary case progress could not be loaded."
    );
    const jobIds = jobs.map(job => job.id);
    const reports = jobIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_case_reports")
            .select("id, job_id, session_id, case_number, participant_code, language, project_id, source_report_id, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, raw_model_output_text, input_token_count, output_token_count, completed_at")
            .in("job_id", jobIds),
        "Advanced preliminary case reports could not be loaded."
    ) : [];
    const reportByJob = new Map(reports.map(report => [report.job_id, report]));
    const failedJobs = await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_evidence, disposition_at, disposition_by")
            .eq("run_id", run.id)
            .eq("status", "failed")
            .eq("disposition", "active")
            .order("source_completed_at", { ascending: true }),
        "Failed Stage 1 cases could not be loaded."
    );
    const failedJobIds = failedJobs.map(job => job.id);
    const savedFailedReports = failedJobIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_case_reports")
            .select("job_id")
            .in("job_id", failedJobIds),
        "Saved Stage 1 report status could not be reconciled."
    ) : [];
    const jobsWithSavedReports = new Set(
        savedFailedReports.map(report => report.job_id)
    );
    const attentionJobs = failedJobs
        .filter(job => !jobsWithSavedReports.has(job.id))
        .sort((left, right) =>
        String(left.source_completed_at).localeCompare(String(right.source_completed_at))
        || String(left.session_id).localeCompare(String(right.session_id))
    );
    const attentionJobIds = new Set(attentionJobs.map(job => job.id));
    const decorateJob = (job, reportMap) => {
        const report = reportMap.get(job.id) || null;
        return {
            ...job,
            report: report ? {
                ...report,
                exactOutputAvailable: Boolean(report.raw_model_output_text)
            } : null
        };
    };
    return {
        run,
        page,
        pageSize: PAGE_SIZE,
        availableProviders: providers,
        availableModels: models,
        requiredOperation: FRESH_ANALYSIS_OPERATION,
        stage2: disabledStage2(),
        attentionCount: attentionJobs.length,
        attentionCases: attentionJobs.map(job =>
            decorateJob(job, reportByJob)
        ),
        cases: jobs
            .filter(job => !attentionJobIds.has(job.id))
            .map(job => decorateJob(job, reportByJob))
    };
}

function executionPlanHash(plan) {
    return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

async function buildExecutionPlan(supabase, req) {
    const operation = typeof req.body?.operation === "string"
        ? req.body.operation.trim() : "";
    if (operation !== FRESH_ANALYSIS_OPERATION) {
        throw Object.assign(
            new Error("This endpoint only performs a fresh independent analysis. Audit, repair, migration, comparison, and continuation require separate researcher-selected operations."),
            { status: 400 }
        );
    }
    const provider = normalizeAnalysisProviderId(req.body?.provider);
    const model = normalizeAnalysisModel(req.body?.model);
    const providerRecord = publicAnalysisProviderCatalog()
        .find(candidate => candidate.id === provider);
    if (!providerRecord?.configured) {
        throw Object.assign(
            new Error(`Provider ${provider} is not configured for production analysis.`),
            { status: 422 }
        );
    }
    const { data: project, error: projectError } = await supabase
        .from("research_projects")
        .select("id, project_code, project_name, research_topic")
        .eq("project_code", SLEEPING_HABITS_PROJECT_CODE)
        .maybeSingle();
    if (projectError || !project?.id) {
        throw Object.assign(
            new Error("The Sleeping habits research project could not be resolved."),
            { status: 500 }
        );
    }
    const { data: preview, error: previewError } = await supabase.rpc(
        "preview_fresh_independent_analysis_run",
        { p_project_id: project.id }
    );
    if (previewError || !preview) {
        throw Object.assign(
            new Error("The source and rules execution plan could not be prepared."),
            { status: 500 }
        );
    }
    const plan = {
        operation: FRESH_ANALYSIS_OPERATION,
        provider,
        model,
        authoritativeSource: AUTHORITATIVE_SOURCE,
        legacyAnalyticalOutputsUsed: false,
        legacyAnalysisInput: LEGACY_ANALYSIS_INPUT,
        analysisRules: [],
        analyticalGatekeepers: "none",
        modelProbeCalls: 0,
        project,
        sourceCaseCount: preview.source_case_count,
        participantMessageCount: preview.participant_message_count,
        storedTranslationCount: preview.stored_translation_count,
        missingStoredTranslationCount: preview.missing_stored_translation_count,
        analysisCallsPerCase: 1,
        maximumAnalysisCalls: preview.source_case_count,
        automaticContinuation: true,
        automaticCrossCaseAnalysis: false,
        existingOutputsAffected: "none",
        newOutputs: "new isolated versioned run",
        executionContractVersion: EXECUTION_CONTRACT_VERSION,
        analysisVersion: ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
        promptVersion: ADVANCED_PRELIMINARY_PROMPT_VERSION,
        stopLayer: ADVANCED_PRELIMINARY_STOP_LAYER
    };
    return { plan, executionPlanHash: executionPlanHash(plan) };
}

async function previewRun(supabase, req) {
    return buildExecutionPlan(supabase, req);
}

async function loadCase(supabase, req) {
    const run = await latestRun(
        supabase,
        typeof req.query?.runId === "string" ? req.query.runId : null
    );
    if (!run) throw Object.assign(new Error("No advanced run exists."), { status: 404 });
    const caseReference = typeof req.query?.case === "string"
        ? req.query.case.trim() : "";
    if (!caseReference || !/^[A-Za-z0-9_-]{1,120}$/u.test(caseReference)) {
        throw Object.assign(new Error("Choose a valid case."), { status: 400 });
    }
    const { data: job, error: jobError } = await supabase
        .from("advanced_preliminary_analysis_jobs")
        .select("id, run_id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, last_error, disposition, disposition_reason, disposition_evidence, disposition_at, disposition_by")
        .eq("run_id", run.id)
        .or(`case_number.eq.${caseReference},session_id.eq.${caseReference}`)
        .maybeSingle();
    if (jobError || !job) {
        throw Object.assign(new Error("The selected advanced case was not found."), { status: 404 });
    }
    const { data: report, error: reportError } = await supabase
        .from("advanced_preliminary_case_reports")
        .select("id, run_id, job_id, session_id, case_number, participant_id, participant_code, language, project_id, analysis_framework_id, source_report_id, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, raw_model_output_text, input_token_count, output_token_count, created_at, completed_at")
        .eq("job_id", job.id)
        .maybeSingle();
    if (reportError) throw new Error("The selected advanced report could not be loaded.");

    const transcript = await requireData(
        supabase
            .from("interview_messages")
            .select("id, Speaker, Language, Message, EnglishTranslation, Timestamp")
            .eq("Session", job.session_id)
            .order("Timestamp", { ascending: true }),
        "The preserved source transcript could not be loaded."
    );
    return { run, job, report: report || null, transcript };
}

function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

async function downloadStage1Csv(supabase, req, res) {
    const run = await latestRun(
        supabase,
        typeof req.query?.runId === "string" ? req.query.runId : null
    );
    if (!run) {
        throw Object.assign(new Error("No Stage 1 run exists."), { status: 404 });
    }
    const reports = await requireData(
        supabase
            .from("advanced_preliminary_case_reports")
            .select("id, run_id, job_id, session_id, case_number, participant_code, language, project_id, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, raw_model_output_text, input_token_count, output_token_count, completed_at")
            .eq("run_id", run.id)
            .order("case_number"),
        "Stage 1 reports could not be exported."
    );
    const project = Array.isArray(run.project_snapshot)
        ? run.project_snapshot[0] || {} : {};
    const headers = [
        "Run", "Run ID", "Project", "Research topic", "Case ID",
        "Session ID", "Participant code", "Language", "Report ID", "Job ID",
        "Provider", "Requested model", "Resolved model", "Reasoning effort",
        "Analysis version", "Prompt version", "Output contract",
        "Authoritative source", "Earlier analysis used", "AI analysis passes",
        "Analytical validator", "Repair or retry", "Parsing or normalization",
        "Hierarchy projection", "Input tokens", "Output tokens",
        "Report completed at", "Exact first model response available",
        "Exact first model response"
    ];
    const rows = reports.map(report => [
        run.run_number, run.id, project.project_name, project.research_topic,
        report.case_number, report.session_id, report.participant_code,
        report.language, report.id, report.job_id, report.provider || run.provider,
        report.model || run.model, report.resolved_model || run.resolved_model,
        report.reasoning_effort || run.reasoning_effort,
        report.analysis_version || run.analysis_version,
        report.prompt_version || run.prompt_version,
        report.raw_model_output_text
            ? "exact first model response"
            : "historical projection only; exact first response was not preserved",
        "original completed transcript",
        report.analytical_audit?.priorAnalysisUsed === false ? "no" : "historical",
        report.analytical_audit?.aiAnalysisPassCount || "historical",
        report.analytical_audit?.validationType === "none_no_analytical_validator"
            ? "none" : "withdrawn historical implementation",
        "none", "none", "none", report.input_token_count,
        report.output_token_count, report.completed_at,
        report.raw_model_output_text ? "yes" : "no",
        report.raw_model_output_text || ""
    ]);
    const csv = [headers, ...rows]
        .map(row => row.map(csvCell).join(","))
        .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="sleeping-habits-stage1-exact-responses-run-${run.run_number}.csv"`
    );
    return res.status(200).send(`\uFEFF${csv}`);
}

async function startRun(supabase, req) {
    const prepared = await buildExecutionPlan(supabase, req);
    if (req.body?.executionPlanHash !== prepared.executionPlanHash) {
        throw Object.assign(
            new Error("The execution plan changed or was not explicitly confirmed. Preview it again before starting."),
            { status: 409 }
        );
    }
    const { plan } = prepared;
    const reasoningEffort = process.env.ADVANCED_PRELIMINARY_REASONING_EFFORT
        || ADVANCED_PRELIMINARY_REASONING_EFFORT;
    const { data: runId, error } = await supabase.rpc(
        "create_fresh_independent_analysis_run",
        {
            p_project_id: plan.project.id,
            p_provider: plan.provider,
            p_model: plan.model,
            p_resolved_model: plan.model,
            p_reasoning_effort: reasoningEffort,
            p_analysis_version: ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
            p_prompt_version: ADVANCED_PRELIMINARY_PROMPT_VERSION,
            p_execution_contract_version: EXECUTION_CONTRACT_VERSION,
            p_execution_plan_hash: prepared.executionPlanHash,
            p_rules_snapshot: {},
            p_requested_by: "researcher-dashboard"
        }
    );
    if (error || !runId) {
        const message = String(error?.message || "");
        throw Object.assign(
            new Error(message.includes("already active")
                ? "An advanced preliminary analysis run is already active."
                : "The advanced preliminary run could not be created."),
            { status: message.includes("already active") ? 409 : 500 }
        );
    }
    const scheduled = scheduleStagedAnalysis(req);
    return {
        runId,
        modelVerified: false,
        provider: plan.provider,
        model: plan.model,
        resolvedModel: plan.model,
        reasoningEffort,
        stopLayer: ADVANCED_PRELIMINARY_STOP_LAYER,
        project: plan.project,
        operation: plan.operation,
        executionPlanHash: prepared.executionPlanHash,
        scheduled
    };
}

async function cancelRun(supabase, req) {
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!runId || !reason) {
        throw Object.assign(
            new Error("A run ID and researcher-visible cancellation reason are required."),
            { status: 400 }
        );
    }
    const { data, error } = await supabase.rpc(
        "cancel_advanced_preliminary_analysis_run",
        {
            p_run_id: runId,
            p_cancellation_reason: reason,
            p_cancelled_by: "researcher-dashboard"
        }
    );
    if (error || !data) {
        throw Object.assign(
            new Error("The analysis run could not be stopped."),
            { status: 500 }
        );
    }
    return data;
}

export async function handleAdvancedPreliminaryDashboard(req, res) {
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    const authorization = authorizeResearcher(
        req,
        process.env.RESEARCHER_DASHBOARD_TOKEN
    );
    if (!authorization.authorized) {
        return res.status(authorization.status).json({ error: authorization.error });
    }
    const supabase = client();
    try {
        if (req.method === "GET") {
            if (req.query?.download === "stage1-csv") {
                return await downloadStage1Csv(supabase, req, res);
            }
            const payload = req.query?.case
                ? await loadCase(supabase, req)
                : await loadSummary(supabase, req);
            return res.status(200).json(payload);
        }
        if (req.method === "POST" && req.body?.action === "start") {
            return res.status(202).json(await startRun(supabase, req));
        }
        if (req.method === "POST" && req.body?.action === "preflight") {
            return res.status(200).json(await previewRun(supabase, req));
        }
        if (req.method === "POST" && req.body?.action === "cancel") {
            return res.status(200).json(await cancelRun(supabase, req));
        }
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    } catch (error) {
        console.error("Advanced preliminary analysis API failed:", error);
        return res.status(error?.status || 500).json({
            error: error instanceof Error ? error.message : "Advanced preliminary analysis failed."
        });
    }
}
