import OpenAI from "openai";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export function normalizeAnalysisProviderId(value) {
    const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!PROVIDER_ID_PATTERN.test(provider)) {
        throw new Error("Analysis provider ID is required and may contain lowercase letters, numbers, underscores, or hyphens.");
    }
    return provider;
}

function additionalProviderConfigurations(environment) {
    const raw = String(environment.ANALYSIS_PROVIDER_CONFIG_JSON || "").trim();
    if (!raw) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error("ANALYSIS_PROVIDER_CONFIG_JSON is not valid JSON.", {
            cause: error
        });
    }
    if (!Array.isArray(parsed)) {
        throw new Error("ANALYSIS_PROVIDER_CONFIG_JSON must be an array.");
    }
    return parsed.map(item => {
        const id = normalizeAnalysisProviderId(item?.id);
        const apiKeyEnvironmentVariable = String(
            item?.apiKeyEnvironmentVariable || ""
        ).trim();
        if (!ENV_NAME_PATTERN.test(apiKeyEnvironmentVariable)) {
            throw new Error(`Provider ${id} has an invalid API-key environment variable name.`);
        }
        const baseURL = typeof item?.baseURL === "string"
            ? item.baseURL.trim() : "";
        if (!baseURL || !/^https:\/\//i.test(baseURL)) {
            throw new Error(`Provider ${id} requires an HTTPS base URL.`);
        }
        return {
            id,
            label: typeof item?.label === "string" && item.label.trim()
                ? item.label.trim() : id,
            adapter: "openai-compatible-responses",
            apiKeyEnvironmentVariable,
            baseURL
        };
    });
}

export function configuredAnalysisProviders(environment = process.env) {
    const providers = [{
        id: "openai",
        label: "OpenAI",
        adapter: "openai-responses",
        apiKeyEnvironmentVariable: "OPENAI_API_KEY",
        baseURL: typeof environment.OPENAI_BASE_URL === "string"
            && environment.OPENAI_BASE_URL.trim()
            ? environment.OPENAI_BASE_URL.trim() : null
    }, ...additionalProviderConfigurations(environment)];
    return [...new Map(providers.map(provider => [provider.id, provider])).values()];
}

export function publicAnalysisProviderCatalog(environment = process.env) {
    return configuredAnalysisProviders(environment).map(provider => ({
        id: provider.id,
        label: provider.label,
        adapter: provider.adapter,
        configured: Boolean(environment[provider.apiKeyEnvironmentVariable])
    }));
}

export function createAnalysisProviderClient(
    providerId,
    environment = process.env,
    OpenAIClient = OpenAI
) {
    const normalizedProvider = normalizeAnalysisProviderId(providerId);
    const provider = configuredAnalysisProviders(environment)
        .find(candidate => candidate.id === normalizedProvider);
    if (!provider) {
        throw new Error(`Analysis provider ${normalizedProvider} is not configured.`);
    }
    const apiKey = environment[provider.apiKeyEnvironmentVariable];
    if (!apiKey) {
        throw new Error(`Analysis provider ${normalizedProvider} has no production credential.`);
    }
    return {
        provider,
        client: new OpenAIClient({
            apiKey,
            ...(provider.baseURL ? { baseURL: provider.baseURL } : {})
        })
    };
}
