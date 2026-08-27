function storedParticipantId(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
}

export async function loadParticipantCodeMap(
    supabaseClient,
    participantIds
) {
    const identifiers = [...new Set(
        (Array.isArray(participantIds) ? participantIds : [])
            .map(storedParticipantId)
            .filter(Boolean)
    )];
    const participantCodes = new Map();

    for (let index = 0; index < identifiers.length; index += 100) {
        const { data, error } = await supabaseClient
            .from("participant_code_map")
            .select("participant_id, participant_code")
            .in("participant_id", identifiers.slice(index, index + 100));

        if (error) {
            throw new Error("Participant codes could not be loaded.", {
                cause: error
            });
        }

        (data || []).forEach(row => {
            const participantId = storedParticipantId(row?.participant_id);
            const participantCode = storedParticipantId(row?.participant_code);

            if (participantId && participantCode) {
                participantCodes.set(participantId, participantCode);
            }
        });
    }

    return participantCodes;
}
