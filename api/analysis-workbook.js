import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
    ANALYSIS_WORKBOOK_STAGES,
    createAnalysisWorkbook,
    parseAnalysisWorkbook,
    workbookFilename
} from "../server/analysisWorkbook.js";
import { authorizeResearcher } from "../server/researcherAuth.js";

const MAX_WORKBOOK_BYTES = 3_500_000;
const IMPORT_TABLE = "qualitative_analysis_workbook_imports";

class WorkbookRequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function safeFilename(value) {
    const filename = typeof value === "string"
        ? value.trim().replace(/[\\/\u0000-\u001f]/g, "-").slice(0, 180)
        : "researcher-analysis.xlsx";
    return filename || "researcher-analysis.xlsx";
}

function safeStage(value) {
    if (!ANALYSIS_WORKBOOK_STAGES.has(value)) {
        throw new WorkbookRequestError(400, "A valid workbook stage is required.");
    }
    return value;
}

async function requireRun(supabaseClient, runId) {
    if (typeof runId !== "string" || !runId.trim()) {
        throw new WorkbookRequestError(
            400,
            "Generate or select a stored analysis run before using Excel round-trip."
        );
    }
    const { data, error } = await supabaseClient
        .from("qualitative_analysis_runs")
        .select("id")
        .eq("id", runId.trim())
        .maybeSingle();
    if (error || !data) {
        throw new WorkbookRequestError(404, "The analysis run was not found.");
    }
    return data.id;
}

async function latestParentImport(supabaseClient, runId, stage) {
    const previousStage = stage === "codes"
        ? "themes"
        : stage === "keywords"
            ? "codes"
            : null;
    if (!previousStage) {
        return null;
    }
    const { data, error } = await supabaseClient
        .from(IMPORT_TABLE)
        .select("id")
        .eq("analysis_run_id", runId)
        .eq("stage", previousStage)
        .order("imported_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw new WorkbookRequestError(500, "The previous researcher decision layer could not be loaded.");
    }
    return data?.id || null;
}

async function exportWorkbook(req, res, supabaseClient) {
    const snapshot = req.body?.snapshot || {};
    const stage = safeStage(snapshot.stage);
    const runId = await requireRun(supabaseClient, snapshot.runId);
    const exportedAt = new Date();
    const buffer = await createAnalysisWorkbook(
        { ...snapshot, stage, runId },
        exportedAt
    );
    res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${workbookFilename(stage, exportedAt)}"`
    );
    return res.status(200).send(buffer);
}

async function importWorkbook(req, res, supabaseClient) {
    const expectedStage = safeStage(req.body?.stage);
    const encoded = typeof req.body?.fileBase64 === "string"
        ? req.body.fileBase64
        : "";
    if (!encoded) {
        throw new WorkbookRequestError(400, "Choose an Excel workbook to upload.");
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > MAX_WORKBOOK_BYTES) {
        throw new WorkbookRequestError(
            413,
            "The workbook must be smaller than 3.5 MB."
        );
    }
    let parsed;
    try {
        parsed = await parseAnalysisWorkbook(buffer, expectedStage);
    } catch (error) {
        throw new WorkbookRequestError(400, error.message);
    }
    const runId = await requireRun(supabaseClient, parsed.runId);
    if (req.body?.runId && req.body.runId !== runId) {
        throw new WorkbookRequestError(
            409,
            "This workbook belongs to a different analysis run. Select that run before uploading it."
        );
    }
    const fileSha256 = createHash("sha256").update(buffer).digest("hex");
    const sourceFilename = safeFilename(req.body?.filename);
    const parentImportId = await latestParentImport(
        supabaseClient,
        runId,
        expectedStage
    );
    const record = {
        analysis_run_id: runId,
        stage: expectedStage,
        parent_import_id: parentImportId,
        source_filename: sourceFilename,
        file_sha256: fileSha256,
        workbook_format_version: parsed.version,
        source_selection: parsed.sourceSelection,
        row_order: parsed.rowOrder,
        grouping_data: parsed.groupingData,
        workbook_snapshot: {
            ...parsed.workbookSnapshot,
            exportedAt: parsed.exportedAt
        }
    };
    const { data, error } = await supabaseClient
        .from(IMPORT_TABLE)
        .insert(record)
        .select("*")
        .single();
    if (error?.code === "23505") {
        const existing = await supabaseClient
            .from(IMPORT_TABLE)
            .select("*")
            .eq("analysis_run_id", runId)
            .eq("stage", expectedStage)
            .eq("file_sha256", fileSha256)
            .maybeSingle();
        return res.status(200).json({
            workbookImport: existing.data,
            duplicate: true
        });
    }
    if (error) {
        throw new WorkbookRequestError(
            500,
            "The researcher workbook decision layer could not be stored."
        );
    }
    return res.status(200).json({ workbookImport: data, duplicate: false });
}

export default async function handler(req, res) {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const configuredToken = process.env.RESEARCHER_DASHBOARD_TOKEN;
    if (!secretKey || !configuredToken) {
        return res.status(500).json({ error: "Server configuration is incomplete." });
    }
    const authorization = authorizeResearcher(req, configuredToken);
    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed." });
    }
    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        secretKey,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    try {
        if (req.body?.action === "export") {
            return await exportWorkbook(req, res, supabaseClient);
        }
        if (req.body?.action === "import") {
            return await importWorkbook(req, res, supabaseClient);
        }
        throw new WorkbookRequestError(400, "Unknown workbook action.");
    } catch (error) {
        console.error("Analysis workbook request failed:", {
            action: req.body?.action,
            status: Number.isInteger(error?.status) ? error.status : 500
        });
        return res.status(Number.isInteger(error?.status) ? error.status : 500)
            .json({
                error: Number.isInteger(error?.status)
                    ? error.message
                    : "The Excel round-trip request could not be completed."
            });
    }
}
