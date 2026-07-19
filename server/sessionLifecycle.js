import { normalizeOpenAIModel } from "./modelConfiguration.js";

export const DEFAULT_INTERVIEW_INACTIVITY_TIMEOUT_MINUTES = 30;

const MINIMUM_TIMEOUT_MINUTES = 1;
const MAXIMUM_TIMEOUT_MINUTES = 7 * 24 * 60;

function requiredIdentifier(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required.`);
    }

    return value.trim();
}

export function resolveInactivityTimeoutMinutes(value) {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_INTERVIEW_INACTIVITY_TIMEOUT_MINUTES;
    }

    const minutes = typeof value === "number"
        ? value
        : Number(value);

    if (!Number.isInteger(minutes)
        || minutes < MINIMUM_TIMEOUT_MINUTES
        || minutes > MAXIMUM_TIMEOUT_MINUTES) {
        throw new Error(
            "Interview inactivity timeout must be a whole number of minutes between 1 and 10080."
        );
    }

    return minutes;
}

function normalizedRequestTime(value) {
    const timestamp = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(timestamp.getTime())) {
        throw new Error("Interview request time is invalid.");
    }

    return timestamp.toISOString();
}

export async function prepareInterviewSession(
    supabaseClient,
    {
        sessionId,
        participantId,
        language,
        interviewModel,
        requestTime,
        inactivityTimeoutMinutes
    }
) {
    const timeoutMinutes = resolveInactivityTimeoutMinutes(
        inactivityTimeoutMinutes
    );
    const requestedModel = normalizeOpenAIModel(interviewModel);
    const { data, error } = await supabaseClient.rpc(
        "prepare_interview_session_with_model",
        {
            p_session_id: requiredIdentifier(sessionId, "Session"),
            p_participant_id: requiredIdentifier(
                participantId,
                "Participant"
            ),
            p_language: requiredIdentifier(language, "Language"),
            p_interview_model: requestedModel,
            p_request_at: normalizedRequestTime(requestTime),
            p_timeout_minutes: timeoutMinutes
        }
    );

    const result = Array.isArray(data) ? data[0] : data;

    if (error || !result?.accepted_session_id) {
        throw new Error("Interview session preparation failed.", {
            cause: error || undefined
        });
    }

    return {
        sessionId: result.accepted_session_id,
        previousSessionId: result.previous_session_id || null,
        expired: result.expired === true,
        created: result.created === true,
        timeoutAt: result.timeout_at || null,
        inactivityTimeoutMinutes: timeoutMinutes,
        interviewModel: normalizeOpenAIModel(
            result.selected_interview_model,
            requestedModel
        )
    };
}

export async function refreshInterviewSessionMetrics(
    supabaseClient,
    sessionId,
    inactivityTimeoutMinutes
) {
    const { data, error } = await supabaseClient.rpc(
        "refresh_interview_session_metrics",
        {
            p_session_id: requiredIdentifier(sessionId, "Session"),
            p_timeout_minutes: resolveInactivityTimeoutMinutes(
                inactivityTimeoutMinutes
            )
        }
    );

    if (error || data !== true) {
        throw new Error("Interview session timing persistence failed.", {
            cause: error || undefined
        });
    }
}
