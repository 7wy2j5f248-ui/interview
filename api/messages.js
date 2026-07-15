import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

function textFromResponse(response) {
    const candidates = [
        response?.output_text,
        ...(response?.output || []).flatMap(item =>
            (item?.content || []).map(content => content?.text)
        )
    ];

    return candidates.find(candidate =>
        typeof candidate === "string" && candidate.trim()
    )?.trim() || "";
}

export async function translateMessageToEnglish(openaiClient, message) {
    const response = await openaiClient.responses.create({
        model: "gpt-5.1",
        input: [
            {
                role: "system",
                content: "Translate the interview message into natural English. Preserve its meaning, tone, names, numbers, and formatting. Return only the English translation."
            },
            {
                role: "user",
                content: message
            }
        ]
    });

    return textFromResponse(response);
}

function needsEnglishTranslation(item) {
    const language = typeof item.Language === "string"
        ? item.Language.trim().toLowerCase()
        : "";
    const existingTranslation = typeof item.EnglishTranslation === "string"
        ? item.EnglishTranslation.trim()
        : "";

    return Boolean(language && language !== "en" && !existingTranslation);
}

export async function handleMessages(
    req,
    res,
    { supabaseClient, openaiClient, translateMessage = translateMessageToEnglish }
) {
    const session = typeof req.query?.session === "string"
        ? req.query.session.trim()
        : "";

    if (!session) {
        return res.status(400).json({ error: "A session is required." });
    }

    try {
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Speaker, Message, Timestamp, Language, EnglishTranslation")
            .eq("Session", session)
            .order("Timestamp", { ascending: true });

        if (error) {
            throw new Error("Interview messages could not be loaded.", {
                cause: error
            });
        }

        const messages = data || [];

        for (const item of messages) {
            if (!needsEnglishTranslation(item)) {
                continue;
            }

            const translation = await translateMessage(openaiClient, item.Message);

            if (!translation) {
                throw new Error("Message translation was empty.");
            }

            const { error: updateError } = await supabaseClient
                .from("interview_messages")
                .update({ EnglishTranslation: translation })
                .eq("id", item.id);

            if (updateError) {
                throw new Error("Message translation could not be saved.", {
                    cause: updateError
                });
            }

            item.EnglishTranslation = translation;
        }

        return res.status(200).json(messages.map(item => ({
            Speaker: item.Speaker,
            Message: item.Message,
            Timestamp: item.Timestamp,
            Language: item.Language,
            EnglishTranslation: item.EnglishTranslation || null
        })));
    } catch (error) {
        console.error("Researcher message loading failed:", error);
        return res.status(500).json({
            error: "Unable to load interview messages."
        });
    }
}

export default async function handler(req, res) {
    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
    );
    const openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    return handleMessages(req, res, { supabaseClient, openaiClient });
}
