import OpenAI from "openai";

export const TRANSLATION_PROVIDER = "openai-api";
export const TRANSLATION_API_BASE_URL = "https://api.openai.com/v1";

export function createTranslationClient(
    environment = process.env,
    OpenAIClient = OpenAI
) {
    const apiKey = typeof environment.OPENAI_API_KEY === "string"
        ? environment.OPENAI_API_KEY.trim()
        : "";

    if (!apiKey) {
        throw new Error(
            "The existing OpenAI API key is not configured for translation."
        );
    }

    return new OpenAIClient({
        apiKey,
        baseURL: TRANSLATION_API_BASE_URL
    });
}
