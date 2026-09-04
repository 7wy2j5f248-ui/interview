import { ensureEnglishTranslations, needsEnglishTranslation } from "./messageTranslation.js";

const TRANSLATION_CHUNK_SIZE = 12;
const WORKER_PATH = "/api/automatic-analysis";

function configuredWorkerSecret() {
    return process.env.RESEARCHER_DASHBOARD_TOKEN || null;
}

function firstRow(data) {
    return Array.isArray(data) ? data[0] || null : data || null;
}

export function transcriptTranslationRequestIsAuthorized(req) {
    const secret = configuredWorkerSecret();
    return Boolean(secret)
        && req?.headers?.authorization === `Bearer ${secret}`;
}

async function claimTranslation(supabaseClient, sessionId) {
    const procedure = sessionId
        ? "claim_transcript_translation_session"
        : "claim_next_transcript_translation";
    const parameters = sessionId ? { p_session_id: sessionId } : undefined;
    const { data, error } = await supabaseClient.rpc(procedure, parameters);

    if (error) {
        throw new Error("A transcript translation job could not be claimed.", {
            cause: error
        });
    }

    return firstRow(data);
}

async function markFailed(supabaseClient, sessionId, error) {
    const { error: persistenceError } = await supabaseClient.rpc(
        "fail_transcript_translation",
        {
            p_session_id: sessionId,
            p_error: error instanceof Error ? error.message : String(error)
        }
    );

    if (persistenceError) {
        console.error("Transcript translation failure state could not be saved:", persistenceError);
    }
}

async function caseSessionIds(supabaseClient, terminalSessionId) {
    const ids = [];
    const seen = new Set();
    let sessionId = terminalSessionId;
    while (sessionId && !seen.has(sessionId)) {
        seen.add(sessionId);
        ids.push(sessionId);
        const { data, error } = await supabaseClient
            .from("interview_sessions")
            .select("continuation_of_session_id")
            .eq("session_id", sessionId)
            .maybeSingle();
        if (error) {
            throw new Error("The resumed-session chain could not be loaded.", {
                cause: error
            });
        }
        sessionId = data?.continuation_of_session_id || null;
    }
    return ids;
}

export async function processTranscriptTranslation(
    supabaseClient,
    openaiClient,
    sessionId = null
) {
    const job = await claimTranslation(supabaseClient, sessionId);

    if (!job) {
        return { claimed: false };
    }

    try {
        const sessionIds = await caseSessionIds(
            supabaseClient,
            job.session_id
        );
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Message, Language, EnglishTranslation, Timestamp")
            .in("Session", sessionIds)
            .order("Timestamp", { ascending: true });

        if (error) {
            throw new Error("The transcript translation source could not be loaded.", {
                cause: error
            });
        }

        const pending = (data || [])
            .filter(needsEnglishTranslation)
            .slice(0, TRANSLATION_CHUNK_SIZE);

        await ensureEnglishTranslations(
            supabaseClient,
            openaiClient,
            pending,
            { concurrency: 1, failOnError: true }
        );

        const { data: completed, error: completionError } =
            await supabaseClient.rpc("finish_transcript_translation", {
                p_session_id: job.session_id
            });

        if (completionError) {
            throw new Error("Transcript translation progress could not be saved.", {
                cause: completionError
            });
        }

        if (completed === true) {
            const { error: freezeError } = await supabaseClient.rpc(
                "try_freeze_analysis_case_v2",
                { p_session_id: job.session_id }
            );
            if (freezeError) {
                throw new Error("The translated case could not be frozen for Stage 1.", {
                    cause: freezeError
                });
            }
        }

        console.log("Transcript translation advanced", {
            sessionId: job.session_id,
            translatedMessages: pending.length,
            completed: completed === true
        });

        return {
            claimed: true,
            completed: completed === true,
            sessionId: job.session_id,
            translatedMessages: pending.length
        };
    } catch (error) {
        await markFailed(supabaseClient, job.session_id, error);
        console.error("Transcript translation failed", {
            sessionId: job.session_id,
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            claimed: true,
            completed: false,
            sessionId: job.session_id
        };
    }
}

export async function continueTranscriptTranslation(baseUrl) {
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
        body: JSON.stringify({
            source: "translation-continuation",
            worker: "translation"
        })
    });

    if (!response.ok) {
        throw new Error(
            `Transcript translation continuation returned ${response.status}.`
        );
    }
}

export function transcriptTranslationBaseUrl(req) {
    const forwardedHost = req?.headers?.["x-forwarded-host"];
    const host = forwardedHost || req?.headers?.host;
    const protocol = req?.headers?.["x-forwarded-proto"] || "https";
    return host ? `${protocol}://${host}` : null;
}
