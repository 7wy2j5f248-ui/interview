import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "./researcherAuth.js";
import {
    STAGE1_PARTICIPANT_INCLUSION_POLICY,
    STAGE1_VALIDATION_REGISTRY_VERSION,
    STAGE1_VALIDATION_RULES,
    stage1ValidationRegistrySummary
} from "./stage1ValidationRules.js";
import {
    RECENT_PLATFORM_CONTROL_INVENTORY_VERSION,
    RECENT_PLATFORM_CONTROLS
} from "./recentPlatformControlInventory.js";

function client() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
}

async function latestRun(supabase) {
    const { data, error } = await supabase
        .from("advanced_preliminary_analysis_runs")
        .select("id, run_number, status, provider, model, resolved_model, reasoning_effort, analysis_version, prompt_version, requested_at, model_verified_at, operation_type, authoritative_source, legacy_analysis_input, execution_contract_version, execution_plan_hash, rules_snapshot")
        .order("requested_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw new Error("The current Stage 1 model and rule context could not be loaded.", {
            cause: error
        });
    }
    return data || null;
}

export async function handleStage1ValidationRulesDashboard(req, res) {
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed." });
    }
    const authorization = authorizeResearcher(
        req,
        process.env.RESEARCHER_DASHBOARD_TOKEN
    );
    if (!authorization.authorized) {
        return res.status(authorization.status).json({ error: authorization.error });
    }
    try {
        let run = null;
        let modelContextError = null;
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
            try {
                run = await latestRun(client());
            } catch (error) {
                modelContextError = error instanceof Error
                    ? error.message : "The current run context is unavailable.";
            }
        } else {
            modelContextError = "Database context is unavailable; the repository rule registry remains fully disclosed.";
        }
        return res.status(200).json({
            registryVersion: STAGE1_VALIDATION_REGISTRY_VERSION,
            effectiveAsOf: "2026-09-01",
            repositoryCommit: process.env.VERCEL_GIT_COMMIT_SHA || null,
            participantInclusionPolicy: STAGE1_PARTICIPANT_INCLUSION_POLICY,
            summary: stage1ValidationRegistrySummary(),
            modelContextError,
            modelContext: run ? {
                runId: run.id,
                runNumber: run.run_number,
                status: run.status,
                provider: run.provider,
                requestedModel: run.model,
                resolvedModel: run.resolved_model,
                reasoningEffort: run.reasoning_effort,
                analysisVersion: run.analysis_version,
                promptVersion: run.prompt_version,
                modelVerifiedAt: run.model_verified_at,
                operationType: run.operation_type,
                authoritativeSource: run.authoritative_source,
                legacyAnalysisInput: run.legacy_analysis_input,
                executionContractVersion: run.execution_contract_version,
                executionPlanHash: run.execution_plan_hash,
                requestedAt: run.requested_at
            } : null,
            frozenResearcherRules: run?.rules_snapshot || null,
            rules: STAGE1_VALIDATION_RULES,
            recentPlatformControlInventoryVersion:
                RECENT_PLATFORM_CONTROL_INVENTORY_VERSION,
            recentPlatformControls: RECENT_PLATFORM_CONTROLS
        });
    } catch (error) {
        console.error("Stage 1 validation-rule registry failed:", error);
        return res.status(500).json({
            error: error instanceof Error
                ? error.message
                : "The Stage 1 validation-rule registry could not be loaded."
        });
    }
}
