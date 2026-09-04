import { waitUntil } from "@vercel/functions";

const WORKER_PATH = "/api/automatic-analysis";
const STAGE2A_POLL_DELAY_MS = 15000;
const CASE_BOUND_POLL_DELAY_MS = 15000;

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

export function scheduleCaseBoundAnalysis(req) {
    const secret = configuredWorkerSecret();
    const baseUrl = requestBaseUrl(req);
    if (!secret || !baseUrl) return false;
    waitUntil(fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ worker: "case-bound-analysis-v2" })
    }).catch(error => {
        console.error("Case-bound analysis trigger failed:", error);
    }));
    return true;
}

export function scheduleParallelStage2(req) {
    const secret = configuredWorkerSecret();
    const baseUrl = requestBaseUrl(req);
    if (!secret || !baseUrl) return false;
    waitUntil(fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            worker: "case-bound-parallel-stage2-v2-continuation"
        })
    }).catch(error => {
        console.error("Parallel Stage 2 trigger failed:", error);
    }));
    return true;
}

export async function continueCaseBoundAnalysis(baseUrl) {
    const secret = configuredWorkerSecret();
    if (!secret || !baseUrl) return;
    await new Promise(resolve => setTimeout(resolve, CASE_BOUND_POLL_DELAY_MS));
    const response = await fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ worker: "case-bound-analysis-v2-continuation" })
    });
    if (!response.ok) {
        throw new Error(`Case-bound analysis continuation returned ${response.status}.`);
    }
}

export async function continueParallelStage2(baseUrl) {
    const secret = configuredWorkerSecret();
    if (!secret || !baseUrl) return;
    await new Promise(resolve => setTimeout(resolve, CASE_BOUND_POLL_DELAY_MS));
    const response = await fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ worker: "case-bound-parallel-stage2-v2-continuation" })
    });
    if (!response.ok) {
        throw new Error(`Parallel Stage 2 continuation returned ${response.status}.`);
    }
}

export function scheduleStage2AHarmonization(req, runId) {
    const secret = configuredWorkerSecret();
    const baseUrl = requestBaseUrl(req);
    if (!secret || !baseUrl || !runId) return false;
    waitUntil(fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            worker: "stage2a-code-harmonization",
            runId
        })
    }).catch(error => {
        console.error("Stage 2A harmonization trigger failed:", error);
    }));
    return true;
}

export async function continueStage2AHarmonization(baseUrl, runId) {
    const secret = configuredWorkerSecret();
    if (!secret || !baseUrl || !runId) return;
    await new Promise(resolve => setTimeout(resolve, STAGE2A_POLL_DELAY_MS));
    const response = await fetch(`${baseUrl}${WORKER_PATH}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            worker: "stage2a-code-harmonization-continuation",
            runId
        })
    });
    if (!response.ok) {
        throw new Error(`Stage 2A continuation returned ${response.status}.`);
    }
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
