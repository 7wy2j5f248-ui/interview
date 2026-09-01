export const DEFAULT_OPENAI_MODEL = "gpt-5.1";

const OPENAI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidOpenAIModelId(value) {
    return typeof value === "string"
        && OPENAI_MODEL_ID_PATTERN.test(value.trim());
}

export function normalizeOpenAIModel(
    value,
    fallback = DEFAULT_OPENAI_MODEL
) {
    const candidate = typeof value === "string" && value.trim()
        ? value.trim()
        : fallback;

    if (!isValidOpenAIModelId(candidate)) {
        throw new Error(
            "OpenAI model ID must contain only letters, numbers, periods, underscores, colons, or hyphens."
        );
    }

    return candidate;
}

export function normalizeAnalysisModel(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("An exact researcher-selected analysis model ID is required.");
    }
    return normalizeOpenAIModel(value, value.trim());
}
