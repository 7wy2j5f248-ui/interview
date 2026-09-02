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
    SLEEPING_HABITS_PROJECT_CODE,
    probeAdvancedPreliminaryModel
} from "./advancedPreliminaryAnalysis.js";
import { scheduleStagedAnalysis } from "./stagedAnalysisWorker.js";
import { configuredStage1Models } from "./analysisModelCatalog.js";
import { normalizeAnalysisModel } from "./modelConfiguration.js";
import {
    createAnalysisProviderClient,
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

async function loadStage2Summary(supabase, stage1RunId) {
    const { data: run, error: runError } = await supabase
        .from("stage2_code_refinement_runs")
        .select("id, stage1_run_id, project_id, status, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, source_case_count, preliminary_completed_count, preliminary_failed_count, refinement_completed_count, refinement_failed_count, created_at, completed_at, updated_at, last_error")
        .eq("stage1_run_id", stage1RunId)
        .maybeSingle();
    if (runError) throw new Error("Stage 2 progress could not be loaded.");
    if (!run) return { run: null, mappings: [] };
    const assignments = await requireData(
        supabase.from("stage2_code_assignments")
            .select("id, preliminary_code_id, refined_code_id, decision, semantic_rationale, model, created_at")
            .eq("run_id", run.id)
            .order("created_at")
            .limit(500),
        "Stage 2 assignments could not be loaded."
    );
    const preliminaryIds = assignments.map(item => item.preliminary_code_id);
    const refinedIds = [...new Set(assignments.map(item => item.refined_code_id))];
    const [preliminaryCodes, refinedCodes, evidenceLinks] = await Promise.all([
        preliminaryIds.length ? requireData(
            supabase.from("stage2_preliminary_codes")
                .select("id, case_number, code_number, code_label, definition, rationale")
                .in("id", preliminaryIds),
            "Stage 2 preliminary Codes could not be loaded."
        ) : [],
        refinedIds.length ? requireData(
            supabase.from("stage2_refined_codes")
                .select("id, refined_code_number, refined_code_label, definition")
                .in("id", refinedIds),
            "Stage 2 refined Codes could not be loaded."
        ) : [],
        preliminaryIds.length ? requireData(
            supabase.from("stage2_preliminary_code_evidence")
                .select("preliminary_code_id, meaning_unit_id")
                .in("preliminary_code_id", preliminaryIds),
            "Stage 2 Meaning Unit links could not be loaded."
        ) : []
    ]);
    const muIds = [...new Set(evidenceLinks.map(item => item.meaning_unit_id))];
    const meaningUnits = muIds.length ? await requireData(
        supabase.from("advanced_preliminary_meaning_units")
            .select("id, report_id, unit_number, message_id, exact_source_text, source_language, context_note")
            .in("id", muIds),
        "Stage 2 exact evidence could not be loaded."
    ) : [];
    const preliminaryById = new Map(preliminaryCodes.map(item => [item.id, item]));
    const refinedById = new Map(refinedCodes.map(item => [item.id, item]));
    const meaningUnitById = new Map(meaningUnits.map(item => [item.id, item]));
    const evidenceByCode = evidenceLinks.reduce((map, item) => {
        if (!map.has(item.preliminary_code_id)) map.set(item.preliminary_code_id, []);
        const unit = meaningUnitById.get(item.meaning_unit_id);
        if (unit) map.get(item.preliminary_code_id).push(unit);
        return map;
    }, new Map());
    return {
        run,
        mappings: assignments.map(item => ({
            id: item.id,
            decision: item.decision,
            semanticRationale: item.semantic_rationale,
            model: item.model,
            preliminaryCode: preliminaryById.get(item.preliminary_code_id) || null,
            refinedCode: refinedById.get(item.refined_code_id) || null,
            meaningUnits: evidenceByCode.get(item.preliminary_code_id) || []
        }))
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
            .select("id, job_id, session_id, case_number, participant_code, language, project_id, source_report_id, case_summary, model, resolved_model, reasoning_effort, analysis_version, prompt_version, analytical_audit, system_processing_notes, input_token_count, output_token_count, completed_at")
            .in("job_id", jobIds),
        "Advanced preliminary case reports could not be loaded."
    ) : [];
    const reportIds = reports.map(report => report.id);
    const [meaningUnits, codes, categories, themes] = reportIds.length
        ? await Promise.all([
            requireData(supabase.from("advanced_preliminary_meaning_units")
                .select("report_id").in("report_id", reportIds),
            "Preliminary Meaning Unit counts could not be loaded."),
            requireData(supabase.from("advanced_preliminary_codes")
                .select("report_id").in("report_id", reportIds),
            "Preliminary Code counts could not be loaded."),
            requireData(supabase.from("advanced_preliminary_categories")
                .select("report_id").in("report_id", reportIds),
            "Preliminary Category counts could not be loaded."),
            requireData(supabase.from("advanced_preliminary_themes")
                .select("report_id").in("report_id", reportIds),
            "Preliminary Tentative Theme counts could not be loaded.")
        ]) : [[], [], [], []];
    const countByReport = rows => rows.reduce((counts, row) => {
        counts.set(row.report_id, (counts.get(row.report_id) || 0) + 1);
        return counts;
    }, new Map());
    const muCount = countByReport(meaningUnits);
    const codeCount = countByReport(codes);
    const categoryCount = countByReport(categories);
    const themeCount = countByReport(themes);
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
    const decorateJob = (job, reportMap, counts, hierarchyCounts = {}) => {
        const report = reportMap.get(job.id) || null;
        return {
            ...job,
            report: report ? {
                ...report,
                meaningUnitCount: counts.get(report.id) || 0,
                codeCount: hierarchyCounts.codes?.get(report.id) || 0,
                categoryCount: hierarchyCounts.categories?.get(report.id) || 0,
                themeCount: hierarchyCounts.themes?.get(report.id) || 0
            } : null
        };
    };
    const stage2 = await loadStage2Summary(supabase, run.id);
    return {
        run,
        page,
        pageSize: PAGE_SIZE,
        availableProviders: providers,
        availableModels: models,
        requiredOperation: FRESH_ANALYSIS_OPERATION,
        stage2,
        attentionCount: attentionJobs.length,
        attentionCases: attentionJobs.map(job =>
            decorateJob(job, reportByJob, muCount)
        ),
        cases: jobs
            .filter(job => !attentionJobIds.has(job.id))
            .map(job => decorateJob(job, reportByJob, muCount, {
                codes: codeCount,
                categories: categoryCount,
                themes: themeCount
            }))
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
        analysisRules: preview.rules_snapshot,
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
        .select("id, run_id, job_id, session_id, case_number, participant_id, participant_code, language, project_id, analysis_framework_id, source_report_id, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, case_summary, unassigned_code_numbers, analytical_audit, raw_model_output_text, parsed_model_output, system_processing_notes, input_token_count, output_token_count, created_at, completed_at")
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

    const [meaningUnits, codes, codeMeaningUnits, categories, categoryCodes,
        tentativeThemes, themeCategories] = await Promise.all([
        requireData(supabase.from("advanced_preliminary_meaning_units")
            .select("id, report_id, unit_number, message_id, exact_source_text, source_language, start_offset, end_offset, occurrence_index, context_note")
            .eq("report_id", report.id).order("unit_number"),
        "Preliminary Meaning Units could not be loaded."),
        requireData(supabase.from("advanced_preliminary_codes")
            .select("id, report_id, code_number, code_label, definition, rationale")
            .eq("report_id", report.id).order("code_number"),
        "Preliminary Codes could not be loaded."),
        requireData(supabase.from("advanced_preliminary_code_meaning_units")
            .select("code_id, meaning_unit_id").eq("report_id", report.id),
        "Code-to-Meaning-Unit links could not be loaded."),
        requireData(supabase.from("advanced_preliminary_categories")
            .select("id, report_id, category_number, category_label, definition, rationale")
            .eq("report_id", report.id).order("category_number"),
        "Preliminary Categories could not be loaded."),
        requireData(supabase.from("advanced_preliminary_category_codes")
            .select("category_id, code_id").eq("report_id", report.id),
        "Category-to-Code links could not be loaded."),
        requireData(supabase.from("advanced_preliminary_themes")
            .select("id, report_id, theme_number, theme_label, rationale")
            .eq("report_id", report.id).order("theme_number"),
        "Preliminary Tentative Themes could not be loaded."),
        requireData(supabase.from("advanced_preliminary_theme_categories")
            .select("theme_id, category_id").eq("report_id", report.id),
        "Theme-to-Category links could not be loaded.")
    ]);

    return {
        run,
        job,
        report: {
            ...report,
            meaningUnits,
            codes,
            codeMeaningUnits,
            categories,
            categoryCodes,
            tentativeThemes,
            themeCategories
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
            .select("id, run_id, session_id, case_number, participant_code, language, project_id, analysis_version, prompt_version, analytical_audit, system_processing_notes, completed_at")
            .eq("run_id", run.id)
            .order("case_number"),
        "Stage 1 reports could not be exported."
    );
    const reportIds = reports.map(report => report.id);
    const [meaningUnits, codes, codeMeaningUnits, categories, categoryCodes,
        tentativeThemes, themeCategories] = reportIds.length
        ? await Promise.all([
            requireData(supabase.from("advanced_preliminary_meaning_units")
                .select("id, report_id, unit_number, message_id, exact_source_text, source_language, start_offset, end_offset, occurrence_index, context_note")
                .in("report_id", reportIds).order("report_id").order("unit_number"),
            "Preliminary Meaning Units could not be exported."),
            requireData(supabase.from("advanced_preliminary_codes")
                .select("id, report_id, code_number, code_label, definition, rationale")
                .in("report_id", reportIds),
            "Preliminary Codes could not be exported."),
            requireData(supabase.from("advanced_preliminary_code_meaning_units")
                .select("report_id, code_id, meaning_unit_id").in("report_id", reportIds),
            "Code-to-Meaning-Unit links could not be exported."),
            requireData(supabase.from("advanced_preliminary_categories")
                .select("id, report_id, category_number, category_label, definition, rationale")
                .in("report_id", reportIds),
            "Preliminary Categories could not be exported."),
            requireData(supabase.from("advanced_preliminary_category_codes")
                .select("report_id, category_id, code_id").in("report_id", reportIds),
            "Category-to-Code links could not be exported."),
            requireData(supabase.from("advanced_preliminary_themes")
                .select("id, report_id, theme_number, theme_label, rationale")
                .in("report_id", reportIds),
            "Preliminary Tentative Themes could not be exported."),
            requireData(supabase.from("advanced_preliminary_theme_categories")
                .select("report_id, theme_id, category_id").in("report_id", reportIds),
            "Theme-to-Category links could not be exported.")
        ]) : [[], [], [], [], [], [], []];
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
        "Context note", "Preliminary Code", "Stable Code ID", "Code label",
        "Code definition", "Code rationale", "Preliminary Category",
        "Stable Category ID", "Category label", "Category definition",
        "Category rationale", "Preliminary Tentative Theme", "Stable Theme ID",
        "Tentative Theme label", "Tentative Theme rationale", "Analysis source",
        "AI analysis passes", "Analytical validator", "System processing notes"
    ];
    const codeById = new Map(codes.map(item => [item.id, item]));
    const categoryById = new Map(categories.map(item => [item.id, item]));
    const themeById = new Map(tentativeThemes.map(item => [item.id, item]));
    const lineage = [];
    codeMeaningUnits.forEach(codeUnit => {
        const unit = meaningUnits.find(item => item.id === codeUnit.meaning_unit_id);
        const code = codeById.get(codeUnit.code_id);
        if (!unit || !code) return;
        const categoryIds = categoryCodes
            .filter(link => link.code_id === code.id)
            .map(link => link.category_id);
        if (!categoryIds.length) {
            lineage.push({ unit, code, category: null, theme: null });
            return;
        }
        categoryIds.forEach(categoryId => {
            const category = categoryById.get(categoryId) || null;
            const themeIds = themeCategories
                .filter(link => link.category_id === categoryId)
                .map(link => link.theme_id);
            if (!themeIds.length) {
                lineage.push({ unit, code, category, theme: null });
                return;
            }
            themeIds.forEach(themeId => lineage.push({
                unit, code, category, theme: themeById.get(themeId) || null
            }));
        });
    });
    const linkedUnitIds = new Set(lineage.map(item => item.unit.id));
    meaningUnits.filter(unit => !linkedUnitIds.has(unit.id))
        .forEach(unit => lineage.push({ unit, code: null, category: null, theme: null }));
    const rows = lineage.map(({ unit, code, category, theme }) => {
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
            unit.context_note, code ? `CO${code.code_number}` : "", code?.id,
            code?.code_label, code?.definition, code?.rationale,
            category ? `CA${category.category_number}` : "", category?.id,
            category?.category_label, category?.definition, category?.rationale,
            theme ? `TH${theme.theme_number}` : "", theme?.id,
            theme?.theme_label, theme?.rationale,
            report.analytical_audit?.priorAnalysisUsed === false
                ? "original transcript only" : "historical stopped workflow",
            report.analytical_audit?.aiAnalysisPassCount || "historical",
            report.analytical_audit?.validationType === "none_no_analytical_validator"
                ? "none" : "withdrawn historical implementation",
            Array.isArray(report.system_processing_notes)
                ? report.system_processing_notes.length : 0
        ];
    });
    const csv = [headers, ...rows]
        .map(row => row.map(csvCell).join(","))
        .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="sleeping-habits-preliminary-case-analysis-run-${run.run_number}.csv"`
    );
    return res.status(200).send(`\uFEFF${csv}`);
}

async function allStage2ExportRows(supabase, stage2RunId) {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase.rpc(
            "get_stage2_refined_code_export",
            { p_run_id: stage2RunId, p_offset: offset, p_limit: pageSize }
        );
        if (error) throw new Error("The final refined-code mapping could not be exported.");
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) return rows;
    }
}

async function downloadStage2Csv(supabase, req, res) {
    const stage1 = await latestRun(
        supabase,
        typeof req.query?.runId === "string" ? req.query.runId : null
    );
    if (!stage1) {
        throw Object.assign(new Error("No Stage 1 run exists."), { status: 404 });
    }
    const { data: stage2, error: runError } = await supabase
        .from("stage2_code_refinement_runs")
        .select("id, stage1_run_id, project_id, status, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, source_case_count, preliminary_completed_count, preliminary_failed_count, refinement_completed_count, refinement_failed_count, created_at, completed_at")
        .eq("stage1_run_id", stage1.id)
        .maybeSingle();
    if (runError || !stage2) {
        throw Object.assign(new Error("No Stage 2 run exists for this Stage 1 result."), { status: 404 });
    }
    if (!["completed", "completed_with_failures"].includes(stage2.status)) {
        throw Object.assign(
            new Error("The final refined-code mapping is still being generated."),
            { status: 409 }
        );
    }
    const [mappings, caseFailures, refinementFailures] = await Promise.all([
        allStage2ExportRows(supabase, stage2.id),
        requireData(
            supabase.from("stage2_preliminary_code_case_jobs")
                .select("case_number, session_id, stage1_report_id, attempt_count, last_error, updated_at")
                .eq("run_id", stage2.id).eq("status", "failed"),
            "Stage 2 preliminary-code failures could not be exported."
        ),
        requireData(
            supabase.from("stage2_refined_code_jobs")
                .select("case_number, code_number, preliminary_code_id, attempt_count, last_error, updated_at")
                .eq("run_id", stage2.id).eq("status", "failed"),
            "Stage 2 refinement failures could not be exported."
        )
    ]);
    const project = Array.isArray(stage1.project_snapshot)
        ? stage1.project_snapshot[0] || {} : {};
    const headers = [
        "Record type", "Stage 1 run ID", "Stage 2 run ID", "Project ID",
        "Project", "Research topic", "Stage 2 status", "Requested model",
        "Resolved model", "Reasoning effort", "Analysis version", "Prompt version",
        "Case ID", "Session ID", "Stage 1 report ID", "Meaning Unit",
        "Stable MU ID", "Message ID", "Exact transcript evidence", "Source language",
        "Preliminary Code", "Preliminary Code ID", "Preliminary Code label",
        "Preliminary Code definition", "Preliminary Code rationale", "Refined Code",
        "Refined Code ID", "Refined Code label", "Refined Code definition",
        "Semantic decision", "Semantic rationale", "Assignment model",
        "Created or updated at", "Failure attempts", "Failure detail"
    ];
    const prefix = [
        stage1.id, stage2.id, stage2.project_id, project.project_name,
        project.research_topic, stage2.status, stage2.model,
        stage2.resolved_model, stage2.reasoning_effort, stage2.analysis_version,
        stage2.prompt_version
    ];
    const rows = mappings.map(item => [
        "refined-code mapping", ...prefix, item.case_number, item.session_id,
        item.stage1_report_id, `MU${item.meaning_unit_number}`,
        item.meaning_unit_id, item.message_id, item.exact_source_text,
        item.source_language, `CO${item.preliminary_code_number}`,
        item.preliminary_code_id, item.preliminary_code_label,
        item.preliminary_code_definition, item.preliminary_code_rationale,
        `RCO${item.refined_code_number}`, item.refined_code_id,
        item.refined_code_label, item.refined_code_definition,
        item.semantic_decision, item.semantic_rationale, item.assignment_model,
        item.assignment_created_at, "", ""
    ]);
    caseFailures.forEach(item => rows.push([
        "preliminary-code failure", ...prefix, item.case_number, item.session_id,
        item.stage1_report_id, "", "", "", "", "", "", "", "", "", "",
        "", "", "", "", "", "", "", item.updated_at,
        item.attempt_count, item.last_error
    ]));
    refinementFailures.forEach(item => rows.push([
        "refined-code failure", ...prefix, item.case_number, "", "", "", "", "", "", "",
        `CO${item.code_number}`, item.preliminary_code_id, "", "", "", "", "", "", "",
        "", "", "", item.updated_at, item.attempt_count, item.last_error
    ]));
    const csv = [headers, ...rows]
        .map(row => row.map(csvCell).join(","))
        .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="sleeping-habits-stage2-refined-codes-${stage2.id}.csv"`
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
    let capability;
    try {
        const configuredProvider = createAnalysisProviderClient(plan.provider);
        capability = await probeAdvancedPreliminaryModel(
            configuredProvider.client,
            { provider: plan.provider, model: plan.model, reasoningEffort }
        );
    } catch (error) {
        console.error("Stage 1 model capability probe failed:", error);
        throw Object.assign(
            new Error(
                `${plan.provider} / ${plan.model} is not currently available or does not support the required Stage 1 capabilities. Enter another exact provider or model ID.`
            ),
            { status: 422 }
        );
    }
    const { data: runId, error } = await supabase.rpc(
        "create_fresh_independent_analysis_run",
        {
            p_project_id: plan.project.id,
            p_provider: capability.provider,
            p_model: capability.model,
            p_resolved_model: capability.resolvedModel,
            p_reasoning_effort: capability.reasoningEffort,
            p_analysis_version: ADVANCED_PRELIMINARY_ANALYSIS_VERSION,
            p_prompt_version: ADVANCED_PRELIMINARY_PROMPT_VERSION,
            p_execution_contract_version: EXECUTION_CONTRACT_VERSION,
            p_execution_plan_hash: prepared.executionPlanHash,
            p_rules_snapshot: plan.analysisRules,
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
            if (req.query?.download === "stage2-csv") {
                return await downloadStage2Csv(supabase, req, res);
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
