import { createHash } from "node:crypto";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    AUTOMATIC_REVIEW_WORKBOOK_VERSION,
    MAX_AUTOMATIC_REVIEW_WORKBOOK_BYTES,
    automaticReviewThreadTitle,
    discussAutomaticCaseAnalysisReview,
    normalizeAutomaticReviewSelection,
    parseAutomaticReviewWorkbook
} from "../server/automaticAnalysisReview.js";
import { authorizeResearcher } from "../server/researcherAuth.js";

export const config = { maxDuration: 300 };

const TABLES = Object.freeze({
    workbookImports: "automatic_analysis_review_workbook_imports",
    threads: "automatic_analysis_review_threads",
    messages: "automatic_analysis_review_messages"
});

class ReviewRequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function safeFilename(value) {
    const filename = typeof value === "string"
        ? value.trim().replace(/[\\/\u0000-\u001f]/g, "-").slice(0, 180)
        : "researcher-review.xlsx";
    return filename || "researcher-review.xlsx";
}

function safeId(value) {
    return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value.trim())
        ? value.trim()
        : null;
}

function safeMessage(value) {
    const message = typeof value === "string"
        ? value.trim().slice(0, 5_000)
        : "";
    if (!message) {
        throw new ReviewRequestError(400, "A discussion message is required.");
    }
    return message;
}

async function requireData(query, message) {
    const { data, error } = await query;
    if (error) throw new ReviewRequestError(500, message);
    return data || [];
}

async function latestWorkbookImport(supabase, requestedId = null) {
    let query = supabase
        .from(TABLES.workbookImports)
        .select("id, source_filename, source_size_bytes, file_sha256, workbook_format_version, sheet_manifest, case_index, imported_by, imported_at");
    query = requestedId
        ? query.eq("id", requestedId)
        : query.order("imported_at", { ascending: false }).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) {
        throw new ReviewRequestError(
            500,
            "The researcher workbook layer could not be loaded."
        );
    }
    if (requestedId && !data) {
        throw new ReviewRequestError(404, "The researcher workbook layer was not found.");
    }
    return data || null;
}

async function listWorkspace(req, res, supabase) {
    const threadId = safeId(req.query?.threadId);
    const [imports, threads, messages] = await Promise.all([
        requireData(
            supabase
                .from(TABLES.workbookImports)
                .select("id, source_filename, source_size_bytes, file_sha256, workbook_format_version, sheet_manifest, imported_by, imported_at")
                .order("imported_at", { ascending: false })
                .limit(10),
            "Researcher workbook uploads could not be loaded."
        ),
        requireData(
            supabase
                .from(TABLES.threads)
                .select("id, title, workbook_import_id, created_by, created_at, updated_at")
                .order("updated_at", { ascending: false })
                .limit(30),
            "Researcher discussion threads could not be loaded."
        ),
        threadId ? requireData(
            supabase
                .from(TABLES.messages)
                .select("id, thread_id, role, content, selected_sources, provenance, model, created_at")
                .eq("thread_id", threadId)
                .order("created_at", { ascending: true })
                .limit(200),
            "The selected researcher discussion could not be loaded."
        ) : []
    ]);
    return res.status(200).json({
        workbookImports: imports,
        threads,
        activeThreadId: threadId,
        messages
    });
}

async function uploadWorkbook(req, res, supabase) {
    const encoded = typeof req.body?.fileBase64 === "string"
        ? req.body.fileBase64
        : "";
    if (!encoded) {
        throw new ReviewRequestError(400, "Choose an Excel workbook to upload.");
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > MAX_AUTOMATIC_REVIEW_WORKBOOK_BYTES) {
        throw new ReviewRequestError(413, "The workbook must be smaller than 3 MB.");
    }
    let parsed;
    try {
        parsed = await parseAutomaticReviewWorkbook(buffer);
    } catch (error) {
        throw new ReviewRequestError(400, error.message);
    }
    const fileSha256 = createHash("sha256").update(buffer).digest("hex");
    const sourceFilename = safeFilename(req.body?.filename);
    const record = {
        source_filename: sourceFilename,
        source_size_bytes: buffer.length,
        file_sha256: fileSha256,
        workbook_format_version: AUTOMATIC_REVIEW_WORKBOOK_VERSION,
        sheet_manifest: parsed.sheetManifest,
        case_index: parsed.caseIndex,
        workbook_snapshot: parsed.workbookSnapshot
    };
    const { data, error } = await supabase
        .from(TABLES.workbookImports)
        .insert(record)
        .select("id, source_filename, source_size_bytes, file_sha256, workbook_format_version, sheet_manifest, imported_by, imported_at")
        .single();
    if (error?.code === "23505") {
        const existing = await latestWorkbookImportByHash(
            supabase,
            fileSha256
        );
        return res.status(200).json({ workbookImport: existing, duplicate: true });
    }
    if (error) {
        throw new ReviewRequestError(
            500,
            "The researcher workbook layer could not be stored."
        );
    }
    return res.status(200).json({ workbookImport: data, duplicate: false });
}

async function latestWorkbookImportByHash(supabase, fileSha256) {
    const { data, error } = await supabase
        .from(TABLES.workbookImports)
        .select("id, source_filename, source_size_bytes, file_sha256, workbook_format_version, sheet_manifest, imported_by, imported_at")
        .eq("file_sha256", fileSha256)
        .maybeSingle();
    if (error || !data) {
        throw new ReviewRequestError(
            500,
            "The existing researcher workbook layer could not be loaded."
        );
    }
    return data;
}

async function loadSelectedCaseContext(supabase, selection) {
    const sessionIds = [...new Set(selection.map(source => source.sessionId))];
    const reports = await requireData(
        supabase
            .from("qualitative_case_reports")
            .select("id, session_id, case_number, participant_id, participant_code, language, demographics, case_interpretation, analysis_version, model, source_completed_at, completed_at")
            .is("superseded_at", null)
            .in("session_id", sessionIds),
        "Selected individual case reports could not be loaded."
    );
    if (reports.length !== sessionIds.length) {
        throw new ReviewRequestError(
            409,
            "At least one selected source is no longer an available completed case report. Refresh the dashboard and select it again."
        );
    }
    const reportIds = reports.map(report => report.id);
    const [codes, themes, highlights, themeCodes, messages] = await Promise.all([
        requireData(
            supabase
                .from("qualitative_case_codes")
                .select("id, report_id, code_number, code_label, rationale, color_slot")
                .in("report_id", reportIds)
                .order("report_id", { ascending: true })
                .order("code_number", { ascending: true }),
            "Selected case codes could not be loaded."
        ),
        requireData(
            supabase
                .from("qualitative_case_themes")
                .select("id, report_id, theme_number, theme_label, rationale")
                .in("report_id", reportIds)
                .order("report_id", { ascending: true })
                .order("theme_number", { ascending: true }),
            "Selected case themes could not be loaded."
        ),
        requireData(
            supabase
                .from("qualitative_case_keyword_highlights")
                .select("id, report_id, code_id, keyword_number, message_id, exact_text, start_offset, end_offset")
                .in("report_id", reportIds)
                .order("report_id", { ascending: true })
                .order("keyword_number", { ascending: true }),
            "Selected keyword evidence could not be loaded."
        ),
        requireData(
            supabase
                .from("qualitative_case_theme_codes")
                .select("report_id, theme_id, code_id")
                .in("report_id", reportIds),
            "Selected theme-to-code links could not be loaded."
        ),
        requireData(
            supabase
                .from("interview_messages")
                .select("id, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                .in("Session", sessionIds)
                .order("Session", { ascending: true })
                .order("Timestamp", { ascending: true })
                .order("id", { ascending: true }),
            "Selected transcript evidence could not be loaded."
        )
    ]);
    const byReport = (items, key = "report_id") => items.reduce(
        (groups, item) => {
            const values = groups.get(item[key]) || [];
            values.push(item);
            groups.set(item[key], values);
            return groups;
        },
        new Map()
    );
    const codesByReport = byReport(codes);
    const themesByReport = byReport(themes);
    const highlightsByReport = byReport(highlights);
    const mappingsByReport = byReport(themeCodes);
    const messagesBySession = byReport(messages, "Session");
    const reportBySession = new Map(reports.map(report => [
        report.session_id,
        report
    ]));

    return selection.map(source => {
        const report = reportBySession.get(source.sessionId);
        const reportThemes = themesByReport.get(report.id) || [];
        const reportCodes = codesByReport.get(report.id) || [];
        const number = Number.parseInt(source.position.slice(1), 10);
        const focus = source.kind === "theme"
            ? reportThemes.find(theme => theme.theme_number === number)
            : source.kind === "code"
                ? reportCodes.find(code => code.code_number === number)
                : null;
        if (source.kind !== "case" && !focus) {
            throw new ReviewRequestError(
                409,
                `${source.caseNumber} ${source.position} is no longer present in the source case report. Refresh and select it again.`
            );
        }
        return {
            selectedSource: {
                ...source,
                label: focus?.theme_label || focus?.code_label
                    || source.label
            },
            report: {
                caseNumber: report.case_number,
                participantCode: report.participant_code,
                sessionId: report.session_id,
                language: report.language,
                demographics: report.demographics,
                caseInterpretation: report.case_interpretation,
                analysisVersion: report.analysis_version,
                model: report.model,
                sourceCompletedAt: report.source_completed_at,
                completedAt: report.completed_at
            },
            themes: reportThemes,
            codes: reportCodes,
            themeCodes: mappingsByReport.get(report.id) || [],
            keywordEvidence: (highlightsByReport.get(report.id) || []).map(
                highlight => ({
                    codeId: highlight.code_id,
                    keywordNumber: highlight.keyword_number,
                    messageId: highlight.message_id,
                    exactText: highlight.exact_text
                })
            ),
            transcript: (messagesBySession.get(report.session_id) || [])
                .filter(message => String(message.Speaker).toLowerCase() === "user")
                .slice(0, 120)
                .map(message => ({
                    messageId: message.id,
                    language: message.Language,
                    originalText: String(message.Message || "").slice(0, 2_000),
                    englishTranslation: String(
                        message.EnglishTranslation || ""
                    ).slice(0, 2_000)
                }))
        };
    });
}

async function loadComparableThemeIndex(supabase, selectedCases) {
    const activeJobs = await requireData(
        supabase
            .from("automatic_case_analysis_jobs")
            .select("session_id, case_number")
            .eq("status", "completed")
            .is("archived_at", null)
            .order("source_completed_at", { ascending: true }),
        "The active case index could not be loaded."
    );
    const sessionIds = activeJobs.map(job => job.session_id);
    const reports = sessionIds.length ? await requireData(
        supabase
            .from("qualitative_case_reports")
            .select("id, session_id, case_number, participant_code")
            .is("superseded_at", null)
            .in("session_id", sessionIds),
        "The active report index could not be loaded."
    ) : [];
    const reportIds = reports.map(report => report.id);
    const themes = reportIds.length ? await requireData(
        supabase
            .from("qualitative_case_themes")
            .select("report_id, theme_number, theme_label")
            .in("report_id", reportIds)
            .order("report_id", { ascending: true })
            .order("theme_number", { ascending: true }),
        "The comparable theme index could not be loaded."
    ) : [];
    const reportById = new Map(reports.map(report => [report.id, report]));
    const index = themes.map(theme => {
        const report = reportById.get(theme.report_id);
        return {
            caseNumber: report.case_number,
            participantCode: report.participant_code,
            sessionId: report.session_id,
            position: `T${theme.theme_number}`,
            label: theme.theme_label
        };
    });
    selectedCases.forEach(caseContext => {
        caseContext.themes.forEach(theme => {
            const source = {
                caseNumber: caseContext.report.caseNumber,
                participantCode: caseContext.report.participantCode,
                sessionId: caseContext.report.sessionId,
                position: `T${theme.theme_number}`,
                label: theme.theme_label
            };
            if (!index.some(item =>
                item.caseNumber === source.caseNumber
                && item.position === source.position
            )) index.push(source);
        });
    });
    return index.slice(0, 3_000);
}

async function loadThread(supabase, threadId) {
    if (!threadId) return null;
    const { data, error } = await supabase
        .from(TABLES.threads)
        .select("id, title, workbook_import_id, created_by, created_at, updated_at")
        .eq("id", threadId)
        .maybeSingle();
    if (error || !data) {
        throw new ReviewRequestError(404, "The selected discussion was not found.");
    }
    return data;
}

async function discussionMessages(supabase, threadId) {
    return requireData(
        supabase
            .from(TABLES.messages)
            .select("id, thread_id, role, content, selected_sources, provenance, model, created_at")
            .eq("thread_id", threadId)
            .order("created_at", { ascending: true })
            .limit(200),
        "The discussion history could not be loaded."
    );
}

async function createThread(supabase, selection, workbookImportId) {
    const { data, error } = await supabase
        .from(TABLES.threads)
        .insert({
            title: automaticReviewThreadTitle(selection),
            workbook_import_id: workbookImportId
        })
        .select("id, title, workbook_import_id, created_by, created_at, updated_at")
        .single();
    if (error) {
        throw new ReviewRequestError(500, "A new discussion could not be created.");
    }
    return data;
}

async function discuss(req, res, supabase, openaiClient) {
    const message = safeMessage(req.body?.message);
    const selection = normalizeAutomaticReviewSelection(req.body?.selection);
    if (!selection.length) {
        throw new ReviewRequestError(
            400,
            "Select at least one case, theme, or code from Forms 1–3 before sending a discussion message."
        );
    }
    const requestedWorkbookId = safeId(req.body?.workbookImportId);
    let thread = await loadThread(supabase, safeId(req.body?.threadId));
    const workbookImport = await latestWorkbookImport(
        supabase,
        requestedWorkbookId || thread?.workbook_import_id || null
    );
    if (!thread) {
        thread = await createThread(
            supabase,
            selection,
            workbookImport?.id || null
        );
    } else if (workbookImport?.id
        && thread.workbook_import_id !== workbookImport.id) {
        const { data, error } = await supabase
            .from(TABLES.threads)
            .update({
                workbook_import_id: workbookImport.id,
                updated_at: new Date().toISOString()
            })
            .eq("id", thread.id)
            .select("id, title, workbook_import_id, created_by, created_at, updated_at")
            .single();
        if (error) {
            throw new ReviewRequestError(
                500,
                "The discussion workbook link could not be updated."
            );
        }
        thread = data;
    }
    const previousMessages = await discussionMessages(supabase, thread.id);
    const { error: researcherError } = await supabase
        .from(TABLES.messages)
        .insert({
            thread_id: thread.id,
            role: "researcher",
            content: message,
            selected_sources: selection,
            provenance: {
                workbookImportId: workbookImport?.id || null,
                interface: "automatic_case_analysis_review"
            }
        });
    if (researcherError) {
        throw new ReviewRequestError(
            500,
            "The researcher discussion message could not be stored."
        );
    }

    const selectedCases = await loadSelectedCaseContext(
        supabase,
        selection
    );
    const comparableThemeIndex = await loadComparableThemeIndex(
        supabase,
        selectedCases
    );
    const result = await discussAutomaticCaseAnalysisReview(
        openaiClient,
        {
            selection,
            selectedCases,
            comparableThemeIndex,
            workbookImport,
            conversation: [
                ...previousMessages,
                { role: "researcher", content: message }
            ]
        }
    );
    const provenance = {
        interface: "automatic_case_analysis_review",
        workbookImportId: workbookImport?.id || null,
        selectedCaseNumbers: selectedCases.map(item =>
            item.report.caseNumber
        ),
        comparableThemeCount: comparableThemeIndex.length,
        sourceAssessments: result.sourceAssessments,
        proposedGroupings: result.proposedGroupings,
        uncertainty: result.uncertainty
    };
    const { data: assistantMessage, error: assistantError } = await supabase
        .from(TABLES.messages)
        .insert({
            thread_id: thread.id,
            role: "assistant",
            content: result.reply,
            selected_sources: selection,
            provenance,
            model: result.model
        })
        .select("id, thread_id, role, content, selected_sources, provenance, model, created_at")
        .single();
    if (assistantError) {
        throw new ReviewRequestError(
            500,
            "The AI discussion response could not be stored."
        );
    }
    await supabase
        .from(TABLES.threads)
        .update({ updated_at: new Date().toISOString() })
        .eq("id", thread.id);

    return res.status(200).json({
        thread,
        assistantMessage,
        sourceAssessments: result.sourceAssessments,
        proposedGroupings: result.proposedGroupings,
        uncertainty: result.uncertainty,
        workbookImport: workbookImport ? {
            id: workbookImport.id,
            source_filename: workbookImport.source_filename,
            imported_at: workbookImport.imported_at
        } : null
    });
}

export default async function handler(req, res) {
    const configuredToken = process.env.RESEARCHER_DASHBOARD_TOKEN;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!configuredToken || !secretKey || !process.env.SUPABASE_URL) {
        return res.status(500).json({ error: "Server configuration is incomplete." });
    }
    const authorization = authorizeResearcher(req, configuredToken);
    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }
    const supabase = createClient(
        process.env.SUPABASE_URL,
        secretKey,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    try {
        if (req.method === "GET") {
            return await listWorkspace(req, res, supabase);
        }
        if (req.method !== "POST") {
            res.setHeader("Allow", "GET, POST");
            return res.status(405).json({ error: "Method not allowed." });
        }
        if (req.body?.action === "upload_workbook") {
            return await uploadWorkbook(req, res, supabase);
        }
        if (req.body?.action === "discuss") {
            if (!process.env.OPENAI_API_KEY) {
                throw new ReviewRequestError(
                    500,
                    "AI discussion configuration is incomplete."
                );
            }
            return await discuss(
                req,
                res,
                supabase,
                new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            );
        }
        throw new ReviewRequestError(400, "Unknown review action.");
    } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        console.error("Automatic analysis review request failed:", {
            action: req.body?.action || req.query?.action || "workspace",
            status
        });
        return res.status(status).json({
            error: status === 500
                ? "The second-layer analysis workspace could not complete this request."
                : error.message
        });
    }
}
