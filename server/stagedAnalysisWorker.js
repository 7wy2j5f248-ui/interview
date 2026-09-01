import { waitUntil } from "@vercel/functions";

const WORKER_PATH = "/api/automatic-analysis";

function configuredWorkerSecret() {
    return process.env.AUTOMATIC_ANALYSIS_SECRET
        || process.env.RESEARCHER_DASHBOARD_TOKEN
        || null;
}

function requestBaseUrl(req) {
    const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
    const protocol = req?.headers?.["x-forwarded-proto"] || "https";
    return host ? `${protocol}://${host}` : null;
}

export function stagedAnalysisWorkerRequestIsAuthorized(req) {
    const authorization = req?.headers?.authorization;
    const workerSecret = configuredWorkerSecret();
    const cronSecret = process.env.CRON_SECRET || null;
    return (Boolean(workerSecret)
        && authorization === `Bearer ${workerSecret}`)
        || (Boolean(cronSecret)
            && authorization === `Bearer ${cronSecret}`);
}

export function scheduleStagedAnalysis(req) {
    const secret = configuredWorkerSecret();
    const baseUrl = requestBaseUrl(req);
    if (!secret || !baseUrl) return false;
    waitUntil(fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ worker: "staged-analysis" })
    }).catch(error => {
        console.error("Staged-analysis trigger failed:", error);
    }));
    return true;
}

export async function continueStagedAnalysis(baseUrl) {
    const secret = configuredWorkerSecret();
    if (!secret || !baseUrl) return;
    const response = await fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ worker: "staged-analysis-continuation" })
    });
    if (!response.ok) {
        throw new Error(`Staged-analysis continuation returned ${response.status}.`);
    }
}

export function stagedAnalysisBaseUrl(req) {
    return requestBaseUrl(req);
}
