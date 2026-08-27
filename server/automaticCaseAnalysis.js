import { waitUntil } from "@vercel/functions";
import {
    AUTOMATIC_CASE_ANALYSIS_VERSION,
    generateAutomaticCaseAnalysis,
    prepareParticipantMessages
} from "./analysisCore.js";
import { normalizeOpenAIModel } from "./modelConfiguration.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { ensureEnglishTranslations } from "./messageTranslation.js";

const WORKER_PATH = "/api/automatic-analysis";

function configuredWorkerSecret() {
    return process.env.AUTOMATIC_ANALYSIS_SECRET
        || process.env.RESEARCHER_DASHBOARD_TOKEN
        || null;
}

function requestBaseUrl(req) {
    const forwardedHost = req?.headers?.["x-forwarded-host"];
    const host = forwardedHost || req?.headers?.host;
    const forwardedProtocol = req?.headers?.["x-forwarded-proto"];

    if (!host) {
        return null;
    }

    return `${forwardedProtocol || "https"}://${host}`;
}

export function workerRequestIsAuthorized(req) {
    const secret = configuredWorkerSecret();
    const authorization = req?.headers?.authorization;
    return Boolean(secret) && authorization === `Bearer ${secret}`;
}

export function scheduleAutomaticCaseAnalysis(req) {
    const secret = configuredWorkerSecret();
    const baseUrl = requestBaseUrl(req);

    if (!secret || !baseUrl) {
        return false;
    }

    waitUntil(fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ source: "automatic-trigger" })
    }).catch(error => {
        console.error("Automatic case-analysis trigger failed:", error);
    }));
    return true;
}

async function claimOldestCase(supabaseClient) {
    const { data, error } = await supabaseClient.rpc(
        "claim_next_automatic_case_analysis",
        { p_analysis_version: AUTOMATIC_CASE_ANALYSIS_VERSION }
    );

    if (error) {
        throw new Error("The oldest automatic case could not be claimed.", {
            cause: error
        });
    }

    return Array.isArray(data) ? data[0] || null : data || null;
}

async function loadCompletedCase(supabaseClient, openaiClient, job) {
    const [{ data: session, error: sessionError }, messageResult] =
        await Promise.all([
            supabaseClient
                .from("interview_sessions")
                .select("session_id, participant_id, language, completed, completed_at")
                .eq("session_id", job.session_id)
                .maybeSingle(),
            supabaseClient
                .from("interview_messages")
                .select("id, Participant, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                .eq("Session", job.session_id)
                .order("Timestamp", { ascending: true })
        ]);

    if (sessionError || !session?.completed || !session.completed_at) {
        throw new Error("The claimed interview session is not formally completed.", {
            cause: sessionError || undefined
        });
    }

    if (messageResult.error) {
        throw new Error("The completed transcript could not be loaded.", {
            cause: messageResult.error
        });
    }

    const transcriptMessages = messageResult.data || [];
    await ensureEnglishTranslations(
        supabaseClient,
        openaiClient,
        transcriptMessages,
        { concurrency: 4, failOnError: true }
    );
    const prepared = prepareParticipantMessages(transcriptMessages);

    if (!prepared.messages.length) {
        throw new Error("The completed transcript has no participant evidence.");
    }

    const participantCodes = await loadParticipantCodeMap(
        supabaseClient,
        [job.participant_id]
    );

    return {
        session,
        messages: prepared.messages,
        participantCode: participantCodes.get(job.participant_id) || null
    };
}

async function markCaseFailed(supabaseClient, sessionId, error) {
    const { error: persistenceError } = await supabaseClient.rpc(
        "fail_automatic_case_analysis",
        {
            p_session_id: sessionId,
            p_error: error instanceof Error ? error.message : String(error),
            p_retryable: true
        }
    );

    if (persistenceError) {
        console.error(
            "Automatic case-analysis failure state could not be saved:",
            persistenceError
        );
    }
}

export async function processOldestAutomaticCase(
    supabaseClient,
    openaiClient
) {
    const job = await claimOldestCase(supabaseClient);

    if (!job) {
        return { claimed: false };
    }

    try {
        const source = await loadCompletedCase(
            supabaseClient,
            openaiClient,
            job
        );
        const model = normalizeOpenAIModel(
            process.env.AUTOMATIC_ANALYSIS_MODEL
                || process.env.QUALITATIVE_ANALYSIS_MODEL
        );
        const analysis = await generateAutomaticCaseAnalysis(
            openaiClient,
            source.messages,
            { model }
        );
        const { error: demographicError } = await supabaseClient.rpc(
            "save_automatic_case_demographics",
            {
                p_session_id: job.session_id,
                p_analysis_version: AUTOMATIC_CASE_ANALYSIS_VERSION,
                p_demographics: analysis.demographics,
                p_descriptor_sources: analysis.descriptorSources
            }
        );

        if (demographicError) {
            throw new Error(
                "Transcript-evidenced demographics were not saved.",
                { cause: demographicError }
            );
        }

        if (!analysis.complete || !source.participantCode) {
            throw new Error(
                "The automatic individual case report was incomplete and was not saved. "
                + `Validated ${analysis.codes.length} codes, `
                + `${analysis.themes.length} themes, and `
                + `${analysis.invalidEvidence} invalid evidence records; `
                + `${analysis.droppedCodes} codes were dropped and `
                + `${analysis.unassignedCodeNumbers.length} codes were unassigned.`
            );
        }

        const payload = {
            participantCode: source.participantCode,
            language: source.session.language,
            demographics: analysis.demographics,
            descriptorSources: analysis.descriptorSources,
            caseInterpretation: analysis.caseInterpretation,
            codes: analysis.codes,
            themes: analysis.themes
        };
        const { data: reportId, error: completionError } =
            await supabaseClient.rpc(
                "complete_automatic_case_analysis",
                {
                    p_session_id: job.session_id,
                    p_model: model,
                    p_analysis_version: AUTOMATIC_CASE_ANALYSIS_VERSION,
                    p_input_token_count: analysis.inputTokenCount,
                    p_payload: payload
                }
            );

        if (completionError || !reportId) {
            throw new Error("The complete individual case report was not saved.", {
                cause: completionError || undefined
            });
        }

        console.log("Automatic case analysis completed", {
            caseNumber: job.case_number,
            reportId
        });
        return {
            claimed: true,
            completed: true,
            caseNumber: job.case_number,
            reportId
        };
    } catch (error) {
        await markCaseFailed(supabaseClient, job.session_id, error);
        console.error("Automatic case analysis failed", {
            caseNumber: job.case_number,
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            claimed: true,
            completed: false,
            caseNumber: job.case_number
        };
    }
}

export async function continueAutomaticCaseAnalysis(baseUrl) {
    const secret = configuredWorkerSecret();

    if (!secret || !baseUrl) {
        return;
    }

    const response = await fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ source: "fifo-continuation" })
    });

    if (!response.ok) {
        throw new Error(
            `Automatic case-analysis continuation returned ${response.status}.`
        );
    }
}

export function automaticCaseAnalysisBaseUrl(req) {
    return requestBaseUrl(req);
}
