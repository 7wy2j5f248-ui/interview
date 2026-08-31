import {
    AUTOMATIC_CASE_REANALYSIS_VERSION,
    detectCompoundQuestionTurns,
    generateAutomaticCaseReanalysis,
    prepareParticipantMessages
} from "./analysisCore.js";
import { loadAnalysisFrameworkById } from "./analysisFramework.js";
import { normalizeOpenAIModel } from "./modelConfiguration.js";

const REQUESTS = "automatic_case_reanalysis_requests";
const PROPOSALS = "automatic_case_reanalysis_proposals";
const EVENTS = "automatic_case_reanalysis_events";

function model() {
    return normalizeOpenAIModel(
        process.env.AUTOMATIC_ANALYSIS_MODEL
            || process.env.QUALITATIVE_ANALYSIS_MODEL
    );
}

async function storeEvent(supabase, requestId, eventType, details) {
    const { error } = await supabase.from(EVENTS).insert({
        request_id: requestId,
        event_type: eventType,
        actor: "system",
        details
    });
    if (error) {
        throw new Error(`The ${eventType} provenance event could not be stored.`);
    }
}

export async function processCaseReanalysisRequest(
    supabase,
    openaiClient,
    requestId,
    { alreadyProcessing = false } = {}
) {
    const selectedModel = model();
    const { data: request, error: requestError } = await supabase
        .from(REQUESTS)
        .select("id, session_id, source_report_id, request_number, reason_code, researcher_notes, requested_by, status, attempt_count, project_id, analysis_framework_id")
        .eq("id", requestId)
        .single();
    if (requestError || !request) {
        throw new Error("The stored re-analysis request could not be loaded.");
    }

    if (!alreadyProcessing) {
        const { data: started, error: startError } = await supabase
            .from(REQUESTS)
            .update({
                status: "processing",
                processing_started_at: new Date().toISOString(),
                attempt_count: request.attempt_count + 1,
                model: selectedModel,
                last_error: null
            })
            .eq("id", requestId)
            .eq("status", "queued")
            .select("id")
            .maybeSingle();
        if (startError || !started) {
            throw new Error("The re-analysis request could not enter processing.");
        }
    } else {
        const { error: modelError } = await supabase
            .from(REQUESTS)
            .update({ model: selectedModel, last_error: null })
            .eq("id", requestId)
            .eq("status", "processing");
        if (modelError) {
            throw new Error("The re-analysis model lineage could not be stored.");
        }
    }

    await storeEvent(supabase, requestId, "processing_started", {
        model: selectedModel,
        analysisVersion: AUTOMATIC_CASE_REANALYSIS_VERSION,
        projectId: request.project_id,
        analysisFrameworkId: request.analysis_framework_id
    });

    try {
        const analysisFramework = await loadAnalysisFrameworkById(
            supabase,
            request.analysis_framework_id
        );
        if (!analysisFramework
            || analysisFramework.projectId !== request.project_id) {
            throw new Error(
                "The request framework does not match its research project/topic lineage."
            );
        }
        const [{ data: sourceReport, error: sourceError }, messageResult] =
            await Promise.all([
                supabase
                    .from("qualitative_case_reports")
                    .select("id, session_id, case_number, participant_code, language, demographics, case_interpretation, analysis_version, model, completed_at, project_id, analysis_framework_id")
                    .eq("id", request.source_report_id)
                    .single(),
                supabase
                    .from("interview_messages")
                    .select("id, Participant, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                    .eq("Session", request.session_id)
                    .order("Timestamp", { ascending: true })
                    .order("id", { ascending: true })
            ]);
        if (sourceError || !sourceReport) {
            throw new Error("The preserved source report could not be loaded.");
        }
        if (sourceReport.project_id !== request.project_id) {
            throw new Error(
                "The preserved report belongs to a different research project/topic lineage."
            );
        }
        if (messageResult.error) {
            throw new Error("The preserved transcript could not be loaded.");
        }
        const transcriptRows = messageResult.data || [];
        const prepared = prepareParticipantMessages(transcriptRows);
        if (!prepared.messages.length) {
            throw new Error("The preserved transcript has no participant evidence.");
        }
        const analysis = await generateAutomaticCaseReanalysis(
            openaiClient,
            prepared.messages,
            {
                requestId,
                requestNumber: request.request_number,
                reasonCode: request.reason_code,
                researcherNotes: request.researcher_notes,
                sourceReportId: sourceReport.id,
                sourceAnalysisVersion: sourceReport.analysis_version,
                researchProjectId: analysisFramework.projectId,
                researchProjectName: analysisFramework.projectName,
                researchTopic: analysisFramework.researchTopic,
                analysisFrameworkId: analysisFramework.id,
                analysisFrameworkVersion: analysisFramework.versionNumber
            },
            { model: selectedModel, analysisFramework }
        );
        const proposedReport = {
            participantCode: sourceReport.participant_code,
            language: sourceReport.language,
            demographics: sourceReport.demographics,
            caseInterpretation: analysis.caseInterpretation,
            codes: analysis.codes,
            themes: analysis.themes,
            researchProjectId: analysisFramework.projectId,
            researchProjectName: analysisFramework.projectName,
            researchTopic: analysisFramework.researchTopic,
            analysisFrameworkId: analysisFramework.id,
            analysisFrameworkVersion: analysisFramework.versionNumber
        };
        const sourceQualityFlags = detectCompoundQuestionTurns(transcriptRows);
        const { data: currentRequest, error: currentRequestError } =
            await supabase
                .from(REQUESTS)
                .select("status, cancelled_at, cancellation_reason")
                .eq("id", requestId)
                .single();
        if (currentRequestError) {
            throw new Error("The re-analysis cancellation state could not be checked.");
        }
        if (currentRequest.status === "cancelled") {
            await storeEvent(supabase, requestId, "cancellation_observed", {
                cancelledAt: currentRequest.cancelled_at,
                cancellationReason: currentRequest.cancellation_reason,
                modelOutputDiscarded: true,
                currentReportPreserved: true
            });
            return {
                requestId,
                status: "cancelled",
                caseNumber: sourceReport.case_number,
                modelOutputDiscarded: true,
                analysisFramework
            };
        }
        const { data: proposal, error: proposalError } = await supabase
            .from(PROPOSALS)
            .insert({
                request_id: requestId,
                source_report_id: sourceReport.id,
                proposal_version: AUTOMATIC_CASE_REANALYSIS_VERSION,
                model: selectedModel,
                proposed_report: proposedReport,
                relevance_audit: analysis.relevanceAudit,
                source_quality_flags: sourceQualityFlags,
                input_token_count: analysis.inputTokenCount,
                project_id: analysisFramework.projectId,
                analysis_framework_id: analysisFramework.id
            })
            .select("id, created_at")
            .single();
        if (proposalError || !proposal) {
            throw new Error("The proposed report version could not be stored.");
        }
        const proposalReadyAt = new Date().toISOString();
        const { error: readyError } = await supabase
            .from(REQUESTS)
            .update({
                status: "proposal_ready",
                proposal_ready_at: proposalReadyAt,
                last_error: null
            })
            .eq("id", requestId)
            .eq("status", "processing");
        if (readyError) {
            throw new Error("The proposal-ready status could not be stored.");
        }
        await storeEvent(supabase, requestId, "proposal_ready", {
            proposalId: proposal.id,
            sourceReportId: sourceReport.id,
            sourceQualityFlagCount: sourceQualityFlags.length,
            relevanceCheckCount: analysis.relevanceAudit.checks.length,
            projectId: analysisFramework.projectId,
            projectName: analysisFramework.projectName,
            researchTopic: analysisFramework.researchTopic,
            analysisFrameworkId: analysisFramework.id,
            analysisFrameworkVersion: analysisFramework.versionNumber,
            currentReportPreserved: true,
            researcherApprovalRequired: true
        });
        return {
            requestId,
            proposalId: proposal.id,
            status: "proposal_ready",
            caseNumber: sourceReport.case_number,
            sourceQualityFlagCount: sourceQualityFlags.length,
            analysisFramework
        };
    } catch (error) {
        const failure = (error instanceof Error ? error.message : String(error))
            .slice(0, 2_000);
        const { data: failedRequest } = await supabase
            .from(REQUESTS)
            .update({ status: "failed", last_error: failure })
            .eq("id", requestId)
            .eq("status", "processing")
            .select("id")
            .maybeSingle();
        if (failedRequest) {
            await supabase.from(EVENTS).insert({
                request_id: requestId,
                event_type: "failed",
                actor: "system",
                details: {
                    error: failure,
                    projectId: request.project_id,
                    analysisFrameworkId: request.analysis_framework_id
                }
            });
        }
        throw new Error(failure);
    }
}

export async function processOldestFrameworkReanalysis(
    supabase,
    openaiClient
) {
    const { data, error } = await supabase.rpc(
        "claim_next_framework_reanalysis"
    );
    if (error) {
        throw new Error("The oldest framework re-analysis could not be claimed.", {
            cause: error
        });
    }
    const job = Array.isArray(data) ? data[0] || null : data || null;
    if (!job) return { claimed: false };
    try {
        const result = await processCaseReanalysisRequest(
            supabase,
            openaiClient,
            job.request_id,
            { alreadyProcessing: true }
        );
        return { claimed: true, completed: true, ...result };
    } catch (error) {
        console.error("Framework historical re-analysis failed", {
            requestId: job.request_id,
            error: error instanceof Error ? error.message : String(error)
        });
        return { claimed: true, completed: false, requestId: job.request_id };
    }
}
