import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
    ADVANCED_PRELIMINARY_MODEL,
    ADVANCED_PRELIMINARY_PROMPT_VERSION,
    ADVANCED_PRELIMINARY_PROVIDER,
    ADVANCED_PRELIMINARY_REASONING_EFFORT,
    ADVANCED_PRELIMINARY_STOP_LAYER,
    SLEEPING_HABITS_PROJECT_CODE,
    probeAdvancedPreliminaryModel
} from "./advancedPreliminaryAnalysis.js";
import { scheduleStagedAnalysis } from "./stagedAnalysisWorker.js";
import {
    configuredStage1DefaultModel,
    configuredStage1Models
} from "./analysisModelCatalog.js";
import { normalizeOpenAIModel } from "./modelConfiguration.js";
import { authorizeResearcher } from "./researcherAuth.js";

export const config = { maxDuration: 300 };

const PAGE_SIZE = 50;
function availableModels() {
    return configuredStage1Models();
}

function defaultModel(models) {
    return configuredStage1DefaultModel(models, {
        ...process.env,
        ADVANCED_PRELIMINARY_ANALYSIS_MODEL:
            process.env.ADVANCED_PRELIMINARY_ANALYSIS_MODEL
            || ADVANCED_PRELIMINARY_MODEL
    });
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
        .select("id, run_number, status, source_scope, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, prior_analysis_role, stop_layer, project_snapshot, source_case_count, pending_count, processing_count, completed_count, failed_count, requested_by, requested_at, model_verified_at, started_at, completed_at, updated_at, last_error");
    query = requestedRunId
        ? query.eq("id", requestedRunId)
        : query.order("requested_at", { ascending: false }).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("The advanced preliminary run could not be loaded.");
    return data || null;
}

async function loadSummary(supabase, req) {
    const models = availableModels();
    const run = await latestRun(
        supabase,
        typeof req.query?.runId === "string" ? req.query.runId : null
    );
    if (!run) return {
        run: null,
        page: 1,
        pageSize: PAGE_SIZE,
        cases: [],
        availableModels: models,
        defaultModel: defaultModel(models)
    };
    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const from = (page - 1) * PAGE_SIZE;
    const jobs = await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_at, disposition_by")
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
            .select("id, job_id, session_id, case_number, participant_code, language, project_id, source_report_id, case_summary, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, input_token_count, output_token_count, completed_at")
            .in("job_id", jobIds),
        "Advanced preliminary case reports could not be loaded."
    ) : [];
    const reportIds = reports.map(report => report.id);
    const meaningUnits = reportIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_meaning_units")
            .select("report_id")
            .in("report_id", reportIds),
        "Stage 1 meaning-unit counts could not be loaded."
    ) : [];
    const countByReport = rows => rows.reduce((counts, row) => {
        counts.set(row.report_id, (counts.get(row.report_id) || 0) + 1);
        return counts;
    }, new Map());
    const muCount = countByReport(meaningUnits);
    const reportByJob = new Map(reports.map(report => [report.job_id, report]));
    const attentionReports = await requireData(
        supabase
            .from("advanced_preliminary_case_reports")
            .select("id, job_id, session_id, case_number, participant_code, language, project_id, source_report_id, case_summary, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, input_token_count, output_token_count, completed_at")
            .eq("run_id", run.id)
            .contains("analytical_audit", { coverageReviewRequired: true }),
        "Stage 1 cases requiring researcher attention could not be loaded."
    );
    const failedJobs = await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_at, disposition_by")
            .eq("run_id", run.id)
            .eq("status", "failed")
            .eq("disposition", "active")
            .order("source_completed_at", { ascending: true }),
        "Failed Stage 1 cases could not be loaded."
    );
    const attentionReportByJob = new Map(
        attentionReports.map(report => [report.job_id, report])
    );
    const failedJobIds = new Set(failedJobs.map(job => job.id));
    const reportOnlyJobIds = attentionReports
        .map(report => report.job_id)
        .filter(jobId => !failedJobIds.has(jobId));
    const reportOnlyJobs = reportOnlyJobIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_at, disposition_by")
            .in("id", reportOnlyJobIds)
            .order("source_completed_at", { ascending: true }),
        "Audited Stage 1 cases requiring attention could not be loaded."
    ) : [];
    const attentionJobs = [...failedJobs, ...reportOnlyJobs]
        .filter(job => job.disposition === "active")
        .sort((left, right) =>
            String(left.source_completed_at).localeCompare(String(right.source_completed_at))
            || String(left.session_id).localeCompare(String(right.session_id))
        );
    const attentionReportIds = attentionReports.map(report => report.id);
    const attentionMeaningUnits = attentionReportIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_meaning_units")
            .select("report_id")
            .in("report_id", attentionReportIds),
        "Stage 1 attention-case Meaning Unit counts could not be loaded."
    ) : [];
    const attentionMuCount = countByReport(attentionMeaningUnits);
    const attentionJobIds = new Set(attentionJobs.map(job => job.id));
    const legacyJobs = await requireData(
        supabase
            .from("advanced_preliminary_analysis_jobs")
            .select("id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, updated_at, last_error, disposition, disposition_reason, disposition_at, disposition_by")
            .eq("run_id", run.id)
            .eq("disposition", "legacy_unusable")
            .order("source_completed_at", { ascending: true }),
        "Legacy unusable cases could not be loaded."
    );
    const legacyJobIds = new Set(legacyJobs.map(job => job.id));
    const decorateJob = (job, reportMap, counts) => {
        const report = reportMap.get(job.id) || null;
        return {
            ...job,
            report: report ? {
                ...report,
                meaningUnitCount: counts.get(report.id) || 0
            } : null
        };
    };
    return {
        run,
        page,
        pageSize: PAGE_SIZE,
        availableModels: models,
        defaultModel: defaultModel(models),
        attentionCount: attentionJobs.length,
        attentionCases: attentionJobs.map(job =>
            decorateJob(job, attentionReportByJob, attentionMuCount)
        ),
        legacyCount: legacyJobs.length,
        legacyCases: legacyJobs.map(job =>
            decorateJob(job, attentionReportByJob, attentionMuCount)
        ),
        cases: jobs
            .filter(job => !attentionJobIds.has(job.id) && !legacyJobIds.has(job.id))
            .map(job => decorateJob(job, reportByJob, muCount))
    };
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
        .select("id, run_id, session_id, participant_id, case_number, source_completed_at, project_id, analysis_framework_id, source_report_id, project_binding_status, status, attempt_count, completed_at, last_error")
        .eq("run_id", run.id)
        .or(`case_number.eq.${caseReference},session_id.eq.${caseReference}`)
        .maybeSingle();
    if (jobError || !job) {
        throw Object.assign(new Error("The selected advanced case was not found."), { status: 404 });
    }
    const { data: report, error: reportError } = await supabase
        .from("advanced_preliminary_case_reports")
        .select("id, run_id, job_id, session_id, case_number, participant_id, participant_code, language, project_id, analysis_framework_id, source_report_id, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, case_summary, unassigned_code_numbers, analytical_audit, input_token_count, output_token_count, created_at, completed_at")
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
    if (!report) return { run, job, report: null, transcript };

    const meaningUnits = await requireData(
        supabase
            .from("advanced_preliminary_meaning_units")
            .select("id, report_id, unit_number, message_id, exact_source_text, source_language, start_offset, end_offset, occurrence_index, context_note")
            .eq("report_id", report.id)
            .order("unit_number"),
        "Stage 1 meaning units could not be loaded."
    );

    return {
        run,
        job,
        report: {
            ...report,
            meaningUnits
        },
        transcript
    };
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
            .select("id, run_id, session_id, case_number, participant_code, language, project_id, analysis_version, prompt_version, analytical_audit, completed_at")
            .eq("run_id", run.id)
            .order("case_number"),
        "Stage 1 reports could not be exported."
    );
    const reportIds = reports.map(report => report.id);
    const meaningUnits = reportIds.length ? await requireData(
        supabase
            .from("advanced_preliminary_meaning_units")
            .select("id, report_id, unit_number, message_id, exact_source_text, source_language, start_offset, end_offset, occurrence_index, context_note")
            .in("report_id", reportIds)
            .order("report_id")
            .order("unit_number"),
        "Stage 1 Meaning Units could not be exported."
    ) : [];
    const reportById = new Map(reports.map(report => [report.id, report]));
    const project = Array.isArray(run.project_snapshot)
        ? run.project_snapshot[0] || {} : {};
    const headers = [
        "Run", "Project", "Research topic", "Requested model",
        "Resolved model", "Reasoning effort", "Analysis version",
        "Prompt version", "Stop layer", "Case ID", "Session ID",
        "Participant code", "Report ID", "Report completed at",
        "Meaning Unit", "Stable MU ID", "Message ID", "Exact source text",
        "Source language", "Start offset", "End offset", "Occurrence",
        "Context note", "Full transcript coverage", "Stage 1 only"
    ];
    const rows = meaningUnits.map(unit => {
        const report = reportById.get(unit.report_id) || {};
        return [
            run.run_number, project.project_name, project.research_topic,
            run.model, run.resolved_model, run.reasoning_effort,
            report.analysis_version || run.analysis_version,
            report.prompt_version || run.prompt_version, run.stop_layer,
            report.case_number, report.session_id, report.participant_code,
            report.id, report.completed_at, `MU${unit.unit_number}`, unit.id,
            unit.message_id, unit.exact_source_text, unit.source_language,
            unit.start_offset, unit.end_offset, unit.occurrence_index,
            unit.context_note,
            report.analytical_audit?.fullTranscriptCoverage ? "verified" : "not verified",
            report.analytical_audit?.stage1Only ? "verified" : "not verified"
        ];
    });
    const csv = [headers, ...rows]
        .map(row => row.map(csvCell).join(","))
        .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="sleeping-habits-stage1-run-${run.run_number}.csv"`
    );
    return res.status(200).send(`\uFEFF${csv}`);
}

async function startRun(supabase, req) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        throw Object.assign(new Error("The production OpenAI configuration is incomplete."), { status: 500 });
    }
    const models = availableModels();
    const requestedModel = typeof req.body?.model === "string"
        ? normalizeOpenAIModel(req.body.model)
        : defaultModel(models);
    const model = requestedModel;
    const reasoningEffort = process.env.ADVANCED_PRELIMINARY_REASONING_EFFORT
        || ADVANCED_PRELIMINARY_REASONING_EFFORT;
    let capability;
    try {
        capability = await probeAdvancedPreliminaryModel(
            new OpenAI({ apiKey: openaiKey }),
            { model, reasoningEffort }
        );
    } catch (error) {
        console.error("Stage 1 model capability probe failed:", error);
        throw Object.assign(
            new Error(
                `${model} is not currently available or does not support the required Stage 1 capabilities. Enter another model ID.`
            ),
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
    const { data: runId, error } = await supabase.rpc(
        "create_stage1_meaning_unit_run",
        {
            p_project_id: project.id,
            p_provider: ADVANCED_PRELIMINARY_PROVIDER,
            p_model: capability.model,
            p_resolved_model: capability.resolvedModel,
            p_reasoning_effort: capability.reasoningEffort,
            p_analysis_version: ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
            p_prompt_version: ADVANCED_PRELIMINARY_PROMPT_VERSION,
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
        modelVerified: true,
        provider: capability.provider,
        model: capability.model,
        resolvedModel: capability.resolvedModel,
        reasoningEffort: capability.reasoningEffort,
        stopLayer: ADVANCED_PRELIMINARY_STOP_LAYER,
        project,
        scheduled
    };
}

async function markLegacyCase(supabase, req) {
    const jobId = typeof req.body?.jobId === "string"
        ? req.body.jobId.trim() : "";
    const reason = typeof req.body?.reason === "string"
        ? req.body.reason.trim() : "";
    if (!jobId || !reason) {
        throw Object.assign(
            new Error("A Stage 1 case and a human-visible legacy reason are required."),
            { status: 400 }
        );
    }
    const { data, error } = await supabase.rpc(
        "set_advanced_preliminary_case_disposition",
        {
            p_job_id: jobId,
            p_disposition: "legacy_unusable",
            p_reason: reason,
            p_actor: "researcher-dashboard"
        }
    );
    if (error || !data) {
        throw Object.assign(
            new Error("The case could not be classified as legacy unusable."),
            { status: 500 }
        );
    }
    scheduleStagedAnalysis(req);
    return { jobId, disposition: "legacy_unusable", reason };
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
        if (req.method === "POST" && req.body?.action === "mark-legacy") {
            return res.status(200).json(await markLegacyCase(supabase, req));
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
