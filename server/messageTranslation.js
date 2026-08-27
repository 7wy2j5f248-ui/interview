import { waitUntil } from "@vercel/functions";

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

export function needsEnglishTranslation(item) {
    const language = typeof item?.Language === "string"
        ? item.Language.trim().toLowerCase()
        : "";
    const translation = typeof item?.EnglishTranslation === "string"
        ? item.EnglishTranslation.trim()
        : "";

    return Boolean(
        language
        && language !== "en"
        && !translation
        && typeof item?.Message === "string"
        && item.Message.trim()
    );
}

export async function translateMessageToEnglish(openaiClient, message) {
    const response = await openaiClient.responses.create({
        model: "gpt-5.1",
        input: [
            {
                role: "system",
                content: "Translate the interview message into natural English. Preserve its meaning, tone, names, numbers, and formatting. Return only the English translation."
            },
            { role: "user", content: message }
        ]
    });

    return textFromResponse(response);
}

export async function ensureEnglishTranslations(
    supabaseClient,
    openaiClient,
    messages,
    {
        concurrency = 4,
        failOnError = false,
        translateMessage = translateMessageToEnglish,
        onError = () => {}
    } = {}
) {
    const pending = (Array.isArray(messages) ? messages : [])
        .filter(needsEnglishTranslation);
    const failures = [];
    let nextIndex = 0;

    async function translateNext() {
        while (nextIndex < pending.length) {
            const item = pending[nextIndex];
            nextIndex += 1;
            let stage = "generation";

            try {
                const translation = String(
                    await translateMessage(openaiClient, item.Message) || ""
                ).trim();

                if (!translation) {
                    throw new Error("Message translation was empty.");
                }

                stage = "persistence";
                const { error } = await supabaseClient
                    .from("interview_messages")
                    .update({ EnglishTranslation: translation })
                    .eq("id", item.id);

                if (error) {
                    throw new Error("Message translation could not be saved.", {
                        cause: error
                    });
                }

                item.EnglishTranslation = translation;
            } catch (error) {
                failures.push({ item, stage, error });
                onError(item, stage, error);
            }
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(Math.max(1, concurrency), pending.length) },
        () => translateNext()
    ));

    if (failOnError && failures.length) {
        throw new Error(
            `${failures.length} transcript message translations could not be completed.`
        );
    }

    return {
        requested: pending.length,
        translated: pending.length - failures.length,
        failures
    };
}

function requestBaseUrl(req) {
    const forwardedHost = req?.headers?.["x-forwarded-host"];
    const host = forwardedHost || req?.headers?.host;
    const protocol = req?.headers?.["x-forwarded-proto"] || "https";
    return host ? `${protocol}://${host}` : null;
}

export function scheduleCompletedTranscriptTranslation(
    req,
    sessionId,
    language
) {
    if (String(language || "").toLowerCase() === "en") {
        return true;
    }

    const baseUrl = requestBaseUrl(req);
    const secret = process.env.RESEARCHER_DASHBOARD_TOKEN;

    if (!baseUrl || !secret || !sessionId) {
        return false;
    }

    const url = new URL("/api/automatic-analysis", baseUrl);
    waitUntil(fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            source: "formal-completion",
            worker: "translation",
            sessionId
        })
    }).then(response => {
        if (!response.ok) {
            throw new Error(
                `Completed transcript translation returned ${response.status}.`
            );
        }
    }).catch(error => {
        console.error("Completed transcript translation failed:", error);
    }));

    return true;
}

export function scheduleTranscriptTranslationBackfill(req) {
    const baseUrl = requestBaseUrl(req);
    const secret = process.env.RESEARCHER_DASHBOARD_TOKEN;

    if (!baseUrl || !secret) {
        return false;
    }

    const url = new URL("/api/automatic-analysis", baseUrl);
    waitUntil(fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            source: "backfill-wakeup",
            worker: "translation"
        })
    }).catch(error => {
        console.error("Transcript translation backfill trigger failed:", error);
    }));

    return true;
}
