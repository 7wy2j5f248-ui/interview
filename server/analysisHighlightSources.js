import {
    createTaskLimiter,
    rowsForIds
} from "./supabaseBatching.js";

export async function enrichAnalysisHighlightSources(
    supabase,
    highlights,
    { schedule = createTaskLimiter() } = {}
) {
    const sourceMessages = await rowsForIds(
        (highlights || []).map(highlight => highlight.message_id),
        chunk => supabase
            .from("interview_messages")
            .select("id, Language, EnglishTranslation")
            .in("id", chunk)
            .order("id", { ascending: true }),
        "Stored English source translations could not be loaded.",
        { schedule }
    );
    const sourceMessageById = new Map(sourceMessages.map(message => [
        String(message.id),
        message
    ]));

    return (highlights || []).map(highlight => {
        const source = sourceMessageById.get(String(highlight.message_id));
        return {
            ...highlight,
            source_language: source?.Language || null,
            english_translation: source?.EnglishTranslation || null
        };
    });
}
