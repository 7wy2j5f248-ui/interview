import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "../server/researcherAuth.js";
import { loadParticipantCodeMap } from "../server/participantCodes.js";
import {
    ensureEnglishTranslations,
    translateMessageToEnglish
} from "../server/messageTranslation.js";

export { translateMessageToEnglish };

function normalizedLanguage(item) {
    return typeof item.Language === "string"
        ? item.Language.trim().toLowerCase()
        : "";
}

function normalizedTranslation(item) {
    return typeof item.EnglishTranslation === "string"
        ? item.EnglishTranslation.trim()
        : "";
}

function translationState(item) {
    const language = normalizedLanguage(item);

    if (language === "en") {
        return "original_english";
    }

    if (language && normalizedTranslation(item)) {
        return "translated";
    }

    if (language) {
        return "translation_unavailable";
    }

    return null;
}

function logTranslationFailure(item, stage, error) {
    const details = {
        messageId: item.id,
        language: normalizedLanguage(item),
        stage,
        reason: error?.message === "Message translation was empty."
            ? "empty_translation"
            : `translation_${stage}_failed`
    };

    if (typeof error?.status === "number") {
        details.status = error.status;
    }

    console.error("Researcher message translation failed:", details);
}

export async function handleMessages(
    req,
    res,
    {
        supabaseClient,
        openaiClient,
        configuredToken,
        translateMessage = translateMessageToEnglish
    }
) {
    const authorization = authorizeResearcher(req, configuredToken);

    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }

    const session = typeof req.query?.session === "string"
        ? req.query.session.trim()
        : "";

    if (!session) {
        return res.status(400).json({ error: "A session is required." });
    }

    try {
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Participant, Speaker, Message, Timestamp, Language, EnglishTranslation")
            .eq("Session", session)
            .order("Timestamp", { ascending: true });

        if (error) {
            throw new Error("Interview messages could not be loaded.", {
                cause: error
            });
        }

        const messages = data || [];
        const participantIds = [...new Set(messages.map(item =>
            typeof item.Participant === "string"
                ? item.Participant.trim()
                : ""
        ).filter(Boolean))];

        if (participantIds.length !== 1) {
            return res.status(409).json({
                error: "Transcript identity could not be verified."
            });
        }

        const participantId = participantIds[0];
        const participantCode = (await loadParticipantCodeMap(
            supabaseClient,
            [participantId]
        )).get(participantId);

        if (!participantCode) {
            return res.status(409).json({
                error: "Transcript participant code is unavailable."
            });
        }

        await ensureEnglishTranslations(
            supabaseClient,
            openaiClient,
            messages,
            {
                concurrency: 4,
                translateMessage,
                onError: logTranslationFailure
            }
        );

        return res.status(200).json({
            identity: {
                sessionId: session,
                participantId,
                participantCode
            },
            messages: messages.map(item => ({
                id: item.id,
                Speaker: item.Speaker,
                Message: item.Message,
                Timestamp: item.Timestamp,
                Language: item.Language,
                EnglishTranslation: normalizedTranslation(item)
                    ? item.EnglishTranslation
                    : null,
                TranslationState: translationState(item)
            }))
        });
    } catch (error) {
        console.error("Researcher message loading failed:", error);
        return res.status(500).json({
            error: "Unable to load interview messages."
        });
    }
}

export default async function handler(req, res) {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const configuredToken = process.env.RESEARCHER_DASHBOARD_TOKEN;

    if (!secretKey || !configuredToken) {
        return res.status(500).json({
            error: "Server configuration is incomplete."
        });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        secretKey,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        }
    );
    const openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    return handleMessages(req, res, {
        supabaseClient,
        openaiClient,
        configuredToken
    });
}
