import { ensureEnglishTranslations, needsEnglishTranslation } from "./messageTranslation.js";

const TRANSLATION_CHUNK_SIZE = 12;
const WORKER_PATH = "/api/transcript-translation";

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
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Message, Language, EnglishTranslation, Timestamp")
            .eq("Session", job.session_id)
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
            { concurrency: 4, failOnError: true }
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
        body: JSON.stringify({ source: "translation-continuation" })
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
