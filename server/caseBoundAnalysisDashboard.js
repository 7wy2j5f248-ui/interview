import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "./researcherAuth.js";
import {
    buildCaseBoundStage1Request,
    CASE_BOUND_PROMPT_VERSION,
    stage1ContractSnapshot
} from "./caseBoundAnalysisContract.js";
import {
    normalizeAnalysisProviderId,
    publicAnalysisProviderCatalog
} from "./analysisProvider.js";
import { configuredStage1Models } from "./analysisModelCatalog.js";
import { scheduleCaseBoundAnalysis } from "./stagedAnalysisWorker.js";

function client() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
}

async function requireRows(query, message) {
    const { data, error } = await query;
    if (error) throw new Error(message, { cause: error });
    return data || [];
}

async function projectById(supabase, projectId) {
    const { data, error } = await supabase
        .from("research_projects")
        .select("id, project_code, project_name, research_topic")
        .eq("id", projectId)
        .maybeSingle();
    if (error || !data) {
        throw Object.assign(new Error("Choose an existing research project."), {
            status: 400
        });
    }
    return data;
}

function projectContext(project) {
    return {
        project_name: project.project_name,
        research_topic: project.research_topic
    };
}

function proposedConfiguration(project, body) {
    return stage1ContractSnapshot({
        projectContext: projectContext(project),
        analysisSpecificGuidelines: body.analysisSpecificGuidelines,
        provider: normalizeAnalysisProviderId(body.provider),
        model: body.model,
        reasoningEffort: body.reasoningEffort,
        maxOutputTokens: body.maxOutputTokens
    });
}

function requestTemplate(configuration) {
    return buildCaseBoundStage1Request({
        caseNumber: "P00000",
        sourceSha256: "0".repeat(64),
        analyticalTranscript: [{
            turn_id: "T001",
            message_id: "<frozen-message-id>",
            session_id: "<frozen-session-id>",
            speaker: "participant",
            language: "en",
            original_text: "<frozen-original-text>",
            english_text: "<frozen-English-analytical-text>"
        }]
    }, configuration, { requestId: "00000000-0000-4000-8000-000000000000" }).request;
}

async function summary(supabase) {
    const [projects, activeConfigurations, cases, cohorts, attempts, stage2Runs] =
        await Promise.all([
            requireRows(supabase.from("research_projects")
                .select("id, project_code, project_name, research_topic")
                .order("project_name"), "Research projects could not be loaded."),
            requireRows(supabase.from("active_analysis_project_configurations_v2")
                .select("project_id, configuration_id, activated_at, activated_by, analysis_project_configurations_v2(provider, model, reasoning_effort, max_output_tokens, contract_version, prompt_version, configuration_sha256)"),
            "Active case-bound configurations could not be loaded."),
            requireRows(supabase.from("analysis_cases_v2")
                .select("id, project_id, configuration_id, case_number, source_completed_at, stage1_status, frozen_at, completed_at, unresolved_at")
                .order("case_number"), "Case-bound Stage 1 cases could not be loaded."),
            requireRows(supabase.from("analysis_cohorts_v2")
                .select("id, project_id, configuration_id, name, status, created_at, closed_at, blocked_reason")
                .order("created_at", { ascending: false }), "Cohorts could not be loaded."),
            requireRows(supabase.from("stage1_attempts_v2")
                .select("id, case_id, attempt_number, status, researcher_reason, queued_at, provider_status, terminal_at, technical_error, completion_authority, completion_record")
                .order("attempt_number"), "Stage 1 attempts could not be loaded."),
            requireRows(supabase.from("stage2_runs_v2")
                .select("id, cohort_id, status, provider, model, reasoning_effort, queued_at, provider_status, terminal_at, technical_error")
                .order("queued_at", { ascending: false }), "Stage 2A runs could not be loaded.")
        ]);
    return {
        projects,
        activeConfigurations,
        cases,
        cohorts,
        attempts,
        stage2Runs,
        availableProviders: publicAnalysisProviderCatalog(),
        availableModels: configuredStage1Models(),
        automaticRefresh: false
    };
}

async function caseRecord(supabase, caseId) {
    const [analysisCase, sessions, source, attempts] = await Promise.all([
        requireRows(supabase.from("analysis_cases_v2").select("*")
            .eq("id", caseId), "The case record could not be loaded."),
        requireRows(supabase.from("analysis_case_sessions_v2").select("*")
            .eq("case_id", caseId).order("session_order"),
        "The case session lineage could not be loaded."),
        requireRows(supabase.from("stage1_source_snapshots_v2").select("*")
            .eq("case_id", caseId), "The frozen case source could not be loaded."),
        requireRows(supabase.from("stage1_attempts_v2").select("*")
            .eq("case_id", caseId).order("attempt_number"),
        "The Stage 1 attempts could not be loaded.")
    ]);
    if (!analysisCase[0]) {
        throw Object.assign(new Error("The case does not exist."), { status: 404 });
    }
    const attemptIds = attempts.map(item => item.id);
    const [requests, presentations] = attemptIds.length ? await Promise.all([
        requireRows(supabase.from("stage1_requests_v2").select("*")
            .in("attempt_id", attemptIds), "Frozen Stage 1 requests could not be loaded."),
        requireRows(supabase.from("stage1_presentations_v2").select("*")
            .in("attempt_id", attemptIds), "Stage 1 presentations could not be loaded.")
    ]) : [[], []];
    const presentedAttempts = attempts.map(attempt => {
        const frozenRequest = requests.find(item =>
            item.attempt_id === attempt.id) || null;
        const explicitPresentation = presentations.find(item =>
            item.attempt_id === attempt.id) || null;
        const researcherResolution =
            attempt.completion_authority === "researcher_pilot_assumption"
                ? {
                    current_stage1_status: analysisCase[0].stage1_status,
                    stage2_readiness: attempt.status === "completed"
                        && explicitPresentation?.presentation_json
                        ? "ready" : "not_ready",
                    completion_authority: attempt.completion_authority,
                    historical_provider_status: attempt.provider_status,
                    historical_provider_status_preserved: true,
                    resolution_record: attempt.completion_record,
                    explanation: "The historical provider status remains immutable. The researcher separately resolved this case for the Stage 2 pilot using the preserved preliminary Codes."
                }
                : null;
        return {
            ...attempt,
            researcherResolution,
            frozenRequest,
            explicitPresentation
        };
    });
    return {
        case: analysisCase[0],
        sessions,
        frozenSource: source[0] || null,
        attempts: presentedAttempts
    };
}

async function post(supabase, req) {
    const body = req.body || {};
    if (["preview_configuration", "activate_configuration"].includes(body.action)) {
        const project = await projectById(supabase, body.projectId);
        const proposed = proposedConfiguration(project, body);
        const preview = {
            configuration: proposed.snapshot,
            configurationSha256: proposed.snapshotSha256,
            requestTemplate: requestTemplate(proposed.snapshot)
        };
        if (body.action === "preview_configuration") return preview;
        if (body.confirmedConfigurationSha256 !== proposed.snapshotSha256) {
            throw Object.assign(new Error(
                "The configuration changed after preview. Preview it again before activation."
            ), { status: 409 });
        }
        const provider = publicAnalysisProviderCatalog()
            .find(item => item.id === proposed.snapshot.provider);
        if (!provider?.configured) {
            throw Object.assign(new Error(
                "The selected provider is not connected to its existing server-side credential."
            ), { status: 409 });
        }
        const { data, error } = await supabase.rpc(
            "save_analysis_project_configuration_v2",
            {
                p_project_id: project.id,
                p_provider: proposed.snapshot.provider,
                p_model: proposed.snapshot.model,
                p_reasoning_effort: proposed.snapshot.reasoningEffort,
                p_max_output_tokens: proposed.snapshot.maxOutputTokens,
                p_contract_version: proposed.snapshot.contractVersion,
                p_prompt_version: CASE_BOUND_PROMPT_VERSION,
                p_configuration_json: proposed.snapshot,
                p_configuration_sha256: proposed.snapshotSha256,
                p_actor: "researcher"
            }
        );
        if (error) throw new Error("The case-bound configuration could not be activated.", { cause: error });
        return { activated: true, configurationId: data, ...preview };
    }

    const procedures = {
        create_cohort: ["create_analysis_cohort_v2", {
            p_project_id: body.projectId,
            p_name: body.name,
            p_actor: "researcher"
        }],
        close_cohort: ["close_analysis_cohort_v2", { p_cohort_id: body.cohortId }],
        authorize_new_attempt: ["authorize_stage1_v2_new_attempt", {
            p_case_id: body.caseId,
            p_reason: body.reason
        }]
    };
    const operation = procedures[body.action];
    if (!operation) {
        throw Object.assign(new Error("Unknown case-bound analysis action."), { status: 400 });
    }
    const { data, error } = await supabase.rpc(operation[0], operation[1]);
    if (error) throw new Error("The requested case-bound action could not be saved.", { cause: error });
    if (["close_cohort", "authorize_new_attempt"].includes(body.action)) {
        scheduleCaseBoundAnalysis(req);
    }
    return { saved: true, id: data };
}

export async function handleCaseBoundAnalysisDashboard(req, res) {
    const authorization = authorizeResearcher(
        req,
        process.env.RESEARCHER_DASHBOARD_TOKEN
    );
    if (!authorization.authorized) {
        return res.status(authorization.status).json({ error: authorization.error });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
        return res.status(500).json({ error: "Server configuration is incomplete." });
    }
    const supabase = client();
    try {
        if (req.method === "GET") {
            const caseId = typeof req.query?.caseId === "string"
                ? req.query.caseId.trim() : "";
            return res.status(200).json(caseId
                ? await caseRecord(supabase, caseId)
                : await summary(supabase));
        }
        if (req.method === "POST") return res.status(200).json(await post(supabase, req));
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed." });
    } catch (error) {
        console.error("Case-bound dashboard request failed:", error);
        return res.status(error.status || 500).json({
            error: error.status ? error.message : "The case-bound analysis workspace could not be updated."
        });
    }
}
