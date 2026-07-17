const TEXT_DESCRIPTOR_FIELDS = Object.freeze([
    "current_country",
    "current_region",
    "country_of_origin",
    "diaspora_status",
    "gender",
    "birth_cohort",
    "youth_status",
    "education_level",
    "social_identity"
]);

function requiredIdentifier(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required.`);
    }

    return value.trim();
}

function nullableText(value, label) {
    if (value === null) {
        return null;
    }

    if (typeof value !== "string") {
        throw new Error(`${label} must be text or null.`);
    }

    return value.trim() || null;
}

function nullableInteger(value, label) {
    if (value === null) {
        return null;
    }

    if (!Number.isInteger(value)) {
        throw new Error(`${label} must be an integer or null.`);
    }

    return value;
}

export function normalizedDescriptorChanges(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Participant descriptor changes must be an object.");
    }

    const changes = {};

    TEXT_DESCRIPTOR_FIELDS.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
            changes[field] = nullableText(input[field], field);
        }
    });

    if (Object.prototype.hasOwnProperty.call(input, "age")) {
        changes.age = nullableInteger(input.age, "age");
    }

    if (Object.prototype.hasOwnProperty.call(input, "birth_year")) {
        changes.birth_year = nullableInteger(input.birth_year, "birth_year");
    }

    ["additional_descriptors", "descriptor_sources"].forEach(field => {
        if (!Object.prototype.hasOwnProperty.call(input, field)) {
            return;
        }

        const value = input[field];

        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${field} must be a JSON object.`);
        }

        changes[field] = value;
    });

    return changes;
}

export async function ensureParticipantDescriptor(
    supabaseClient,
    { sessionId, participantId }
) {
    const { error } = await supabaseClient
        .from("participant_descriptors")
        .upsert({
            session_id: requiredIdentifier(sessionId, "Session"),
            participant_id: requiredIdentifier(participantId, "Participant")
        }, {
            onConflict: "session_id",
            ignoreDuplicates: true
        });

    if (error) {
        throw new Error("Participant descriptor initialization failed.", {
            cause: error
        });
    }
}

export async function loadParticipantDescriptor(supabaseClient, sessionId) {
    const { data, error } = await supabaseClient
        .from("participant_descriptors")
        .select("*")
        .eq("session_id", requiredIdentifier(sessionId, "Session"))
        .maybeSingle();

    if (error) {
        throw new Error("Participant descriptor loading failed.", {
            cause: error
        });
    }

    return data || null;
}

export async function updateParticipantDescriptor(
    supabaseClient,
    sessionId,
    input
) {
    const changes = normalizedDescriptorChanges(input);

    if (!Object.keys(changes).length) {
        return loadParticipantDescriptor(supabaseClient, sessionId);
    }

    const { data, error } = await supabaseClient
        .from("participant_descriptors")
        .update(changes)
        .eq("session_id", requiredIdentifier(sessionId, "Session"))
        .select("*")
        .maybeSingle();

    if (error || !data) {
        throw new Error("Participant descriptor update failed.", {
            cause: error || undefined
        });
    }

    return data;
}
