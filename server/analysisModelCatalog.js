import { normalizeOpenAIModel } from "./modelConfiguration.js";

// This is the server-side model catalog, not dashboard UI logic. Production
// may replace it through ADVANCED_PRELIMINARY_ANALYSIS_MODELS without a UI
// code change. Every selected model still receives a live capability probe.
export const STAGE1_MODEL_CATALOG = Object.freeze([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.1"
]);

export function configuredStage1Models(environment = process.env) {
    const configured = String(
        environment.ADVANCED_PRELIMINARY_ANALYSIS_MODELS || ""
    ).split(",").map(value => value.trim()).filter(Boolean);
    const candidates = configured.length ? configured : STAGE1_MODEL_CATALOG;
    return [...new Set(candidates.map(value => normalizeOpenAIModel(value)))];
}

export function configuredStage1DefaultModel(models, environment = process.env) {
    const requested = normalizeOpenAIModel(
        environment.ADVANCED_PRELIMINARY_ANALYSIS_MODEL || models[0]
    );
    return models.includes(requested) ? requested : models[0];
}
