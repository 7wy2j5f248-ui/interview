import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "../server/researcherAuth.js";
import { rankAnalysisCase } from "../server/analysisFrequencyRanking.js";
import {
    allRows,
    createTaskLimiter,
    rowsForIds
} from "../server/supabaseBatching.js";

export const config = { maxDuration: 300 };

const DEMOGRAPHIC_FIELDS = Object.freeze([
    ["current_country", "Country of residence"],
    ["current_region", "Region of residence"],
    ["country_of_origin", "Country of origin"],
    ["diaspora_status", "Diaspora status"],
    ["gender", "Gender"],
    ["age", "Age"],
    ["birth_year", "Year of birth"],
    ["birth_cohort", "Birth cohort"],
    ["youth_status", "Youth status"],
    ["occupation", "Occupation"],
    ["education_level", "Education"],
    ["social_identity", "Social identity"]
]);

function cleanValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return value;
}

function mergedDemographics(report, descriptor) {
    const result = {};
    DEMOGRAPHIC_FIELDS.forEach(([field]) => {
        result[field] = descriptor?.[field]
            ?? descriptor?.additional_descriptors?.[field]
            ?? null;
        const reported = report?.demographics?.[field]
            ?? report?.demographics?.additional_descriptors?.[field];
        if (reported !== null && reported !== undefined && reported !== "") {
            result[field] = reported;
        }
    });
    return result;
}

function groupBy(rows, key) {
    const result = new Map();
    (rows || []).forEach(row => {
        const values = result.get(row[key]) || [];
        values.push(row);
        result.set(row[key], values);
    });
    return result;
}

function participantCode(caseRecord) {
    return caseRecord.participantCode || String(caseRecord.caseNumber || "").split("-S")[0] || "";
}

function sessionNumber(caseRecord) {
    if (Number.isInteger(caseRecord.sessionNumber) && caseRecord.sessionNumber > 0) {
        return caseRecord.sessionNumber;
    }
    const match = String(caseRecord.caseNumber || "").match(/-S(\d+)$/i);
    return match ? Number.parseInt(match[1], 10) : "";
}

function sortCases(cases) {
    return [...cases].sort((left, right) => {
        const participantOrder = participantCode(left).localeCompare(
            participantCode(right), undefined, { numeric: true }
        );
        return participantOrder || Number(sessionNumber(left) || 0) - Number(sessionNumber(right) || 0);
    });
}

function prepareSheet(sheet, rowCount, streaming) {
    if (!streaming) {
        sheet.views = [{ state: "frozen", ySplit: 1 }];
    }
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, rowCount), column: Math.max(1, sheet.columnCount) }
    };
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
    sheet.columns.forEach(column => {
        column.width = Math.min(48, Math.max(14, String(column.header || "").length + 3));
        column.alignment = { vertical: "top", wrapText: true };
    });
    if (streaming) sheet.getRow(1).commit();
}

function appendRow(sheet, values, streaming) {
    const row = sheet.addRow(values);
    if (streaming) row.commit();
}

function finishSheet(sheet, streaming) {
    if (streaming) sheet.commit();
}

export async function loadActiveCases(supabase) {
    const schedule = createTaskLimiter();
    const relatedRows = (ids, queryFactory, message) => rowsForIds(
        ids,
        queryFactory,
        message,
        { schedule }
    );
    const jobs = await allRows(
        () => supabase
            .from("automatic_case_analysis_jobs")
            .select("session_id, participant_id, case_number, status, source_completed_at")
            .is("archived_at", null)
            .order("source_completed_at", { ascending: true })
            .order("session_id", { ascending: true }),
        "Active case-analysis jobs could not be loaded."
    );

    const sessionIds = jobs.map(job => job.session_id);
    const participantIds = jobs.map(job => job.participant_id);
    const [reports, sessions, descriptors, caseCodes, participantCodeRows] = await Promise.all([
        relatedRows(sessionIds, chunk => supabase
            .from("qualitative_case_reports")
            .select("id, session_id, participant_id, participant_code, language, demographics, case_interpretation")
            .is("superseded_at", null)
            .in("session_id", chunk)
            .order("session_id", { ascending: true }), "Case reports could not be loaded for export."),
        relatedRows(sessionIds, chunk => supabase
            .from("interview_sessions")
            .select("session_id, participant_id, language")
            .in("session_id", chunk)
            .order("session_id", { ascending: true }), "Interview sessions could not be loaded for export."),
        relatedRows(sessionIds, chunk => supabase
            .from("participant_descriptors")
            .select("session_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors")
            .in("session_id", chunk)
            .order("session_id", { ascending: true }), "Participant descriptors could not be loaded for export."),
        relatedRows(sessionIds, chunk => supabase
            .from("case_code_map")
            .select("session_id, case_number, session_number")
            .in("session_id", chunk)
            .order("session_id", { ascending: true }), "Case identifiers could not be loaded for export."),
        relatedRows(participantIds, chunk => supabase
            .from("participant_code_map")
            .select("participant_id, participant_code")
            .in("participant_id", chunk)
            .order("participant_id", { ascending: true }), "Participant codes could not be loaded for export.")
    ]);
    const participantCodes = new Map(participantCodeRows.map(row => [
        row.participant_id,
        row.participant_code
    ]));

    const reportIds = reports.map(report => report.id);
    const [codes, themes, highlights, themeCodes] = await Promise.all([
        relatedRows(reportIds, chunk => supabase
            .from("qualitative_case_codes")
            .select("id, report_id, code_number, code_label")
            .in("report_id", chunk)
            .order("report_id", { ascending: true }), "Case codes could not be loaded for export."),
        relatedRows(reportIds, chunk => supabase
            .from("qualitative_case_themes")
            .select("id, report_id, theme_number, theme_label")
            .in("report_id", chunk)
            .order("report_id", { ascending: true }), "Case themes could not be loaded for export."),
        relatedRows(reportIds, chunk => supabase
            .from("qualitative_case_keyword_highlights")
            .select("id, report_id, code_id, keyword_number, exact_text")
            .in("report_id", chunk)
            .order("report_id", { ascending: true }), "Case keywords could not be loaded for export."),
        relatedRows(reportIds, chunk => supabase
            .from("qualitative_case_theme_codes")
            .select("report_id, theme_id, code_id")
            .in("report_id", chunk)
            .order("report_id", { ascending: true }), "Theme-code mappings could not be loaded for export.")
    ]);

    const reportBySession = new Map(reports.map(row => [row.session_id, row]));
    const sessionById = new Map(sessions.map(row => [row.session_id, row]));
    const descriptorBySession = new Map(descriptors.map(row => [row.session_id, row]));
    const caseCodeBySession = new Map(caseCodes.map(row => [row.session_id, row]));
    const codesByReport = groupBy(codes, "report_id");
    const themesByReport = groupBy(themes, "report_id");
    const highlightsByReport = groupBy(highlights, "report_id");
    const themeCodesByReport = groupBy(themeCodes, "report_id");

    return sortCases(jobs.map(job => {
        const report = reportBySession.get(job.session_id);
        const session = sessionById.get(job.session_id);
        const caseCode = caseCodeBySession.get(job.session_id);
        return rankAnalysisCase({
            caseNumber: caseCode?.case_number || job.case_number,
            sessionNumber: caseCode?.session_number || null,
            sessionId: job.session_id,
            participantCode: report?.participant_code
                || participantCodes.get(job.participant_id)
                || null,
            status: job.status,
            hasReport: Boolean(report),
            language: report?.language || session?.language || null,
            demographics: mergedDemographics(report, descriptorBySession.get(job.session_id) || {}),
            caseInterpretation: report?.case_interpretation || "",
            codes: report ? (codesByReport.get(report.id) || []) : [],
            themes: report ? (themesByReport.get(report.id) || []) : [],
            highlights: report ? (highlightsByReport.get(report.id) || []) : [],
            themeCodes: report ? (themeCodesByReport.get(report.id) || []) : []
        });
    }));
}

function addCasesSheet(workbook, cases, { streaming = false } = {}) {
    const maximumKeywords = Math.max(0, ...cases.map(item => item.rankedKeywords.length));
    const sheet = workbook.addWorksheet(
        "1 Cases & keywords",
        streaming ? { views: [{ state: "frozen", ySplit: 1 }] } : undefined
    );
    sheet.columns = [
        { header: "Participant code", key: "participant" },
        { header: "Session number", key: "sessionNumber" },
        { header: "Session ID", key: "sessionId" },
        { header: "Language", key: "language" },
        ...DEMOGRAPHIC_FIELDS.map(([key, label]) => ({ header: label, key })),
        { header: "Case report status", key: "reportStatus" },
        { header: "Case interpretation", key: "caseInterpretation" },
        ...Array.from({ length: maximumKeywords }, (_, index) => ({
            header: `K${index + 1} (frequency)`,
            key: `keyword_${index + 1}`
        }))
    ];
    prepareSheet(sheet, cases.length + 1, streaming);
    cases.forEach(item => {
        const row = {
            participant: participantCode(item),
            sessionNumber: sessionNumber(item),
            sessionId: item.sessionId,
            language: item.language || "",
            reportStatus: item.hasReport ? "Available" : item.status,
            caseInterpretation: item.caseInterpretation || ""
        };
        DEMOGRAPHIC_FIELDS.forEach(([key]) => {
            row[key] = cleanValue(item.demographics?.[key]);
        });
        item.rankedKeywords.forEach((keyword, index) => {
            row[`keyword_${index + 1}`] = `${keyword.text} (${keyword.count})`;
        });
        appendRow(sheet, row, streaming);
    });
    finishSheet(sheet, streaming);
}

function addCodesSheet(workbook, cases, { streaming = false } = {}) {
    const completed = cases.filter(item => item.hasReport);
    const maximum = Math.max(0, ...completed.map(item => item.rankedCodes.length));
    const sheet = workbook.addWorksheet(
        "2 Codes",
        streaming ? { views: [{ state: "frozen", ySplit: 1 }] } : undefined
    );
    sheet.columns = [
        { header: "Participant code", key: "participant" },
        { header: "Session number", key: "sessionNumber" },
        { header: "Session ID", key: "sessionId" },
        ...Array.from({ length: maximum }, (_, index) => ({
            header: `C${index + 1} · distinct keywords, mentions`,
            key: `C${index + 1}`
        }))
    ];
    prepareSheet(sheet, completed.length + 1, streaming);
    completed.forEach(item => {
        const row = {
            participant: participantCode(item),
            sessionNumber: sessionNumber(item),
            sessionId: item.sessionId
        };
        item.rankedCodes.forEach((code, index) => {
            row[`C${index + 1}`] = `${code.code_label} · ${code.keywordCount}, ${code.occurrenceCount}`;
        });
        appendRow(sheet, row, streaming);
    });
    finishSheet(sheet, streaming);
}

function addThemesSheet(workbook, cases, { streaming = false } = {}) {
    const completed = cases.filter(item => item.hasReport);
    const maximum = Math.max(0, ...completed.map(item => item.rankedThemes.length));
    const sheet = workbook.addWorksheet(
        "3 Themes",
        streaming ? { views: [{ state: "frozen", ySplit: 1 }] } : undefined
    );
    sheet.columns = [
        { header: "Participant code", key: "participant" },
        { header: "Session number", key: "sessionNumber" },
        { header: "Session ID", key: "sessionId" },
        ...Array.from({ length: maximum }, (_, index) => ({
            header: `T${index + 1} · mentions, supporting codes, distinct keywords`,
            key: `T${index + 1}`
        }))
    ];
    prepareSheet(sheet, completed.length + 1, streaming);
    completed.forEach(item => {
        const row = {
            participant: participantCode(item),
            sessionNumber: sessionNumber(item),
            sessionId: item.sessionId
        };
        item.rankedThemes.forEach((theme, index) => {
            row[`T${index + 1}`] = `${theme.theme_label} · ${theme.occurrenceCount}, ${theme.codeCount}, ${theme.keywordCount}`;
        });
        appendRow(sheet, row, streaming);
    });
    finishSheet(sheet, streaming);
}

export async function writeRankedAnalysisWorkbook(
    stream,
    cases,
    createdAt = new Date()
) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream,
        useStyles: true,
        useSharedStrings: false
    });
    workbook.creator = "PLI Researcher Dashboard";
    workbook.created = createdAt;
    workbook.modified = createdAt;
    addCasesSheet(workbook, cases, { streaming: true });
    addCodesSheet(workbook, cases, { streaming: true });
    addThemesSheet(workbook, cases, { streaming: true });
    await workbook.commit();
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed." });
    }
    const authorization = authorizeResearcher(req, process.env.RESEARCHER_DASHBOARD_TOKEN);
    if (!authorization.authorized) {
        return res.status(authorization.status).json({ error: authorization.error });
    }
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SECRET_KEY,
            { auth: { persistSession: false, autoRefreshToken: false } }
        );
        const cases = await loadActiveCases(supabase);
        const createdAt = new Date();
        const stamp = createdAt.toISOString().slice(0, 10);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="PLI-frequency-ranked-analysis-${stamp}.xlsx"`);
        res.setHeader("X-PLI-Case-Count", String(cases.length));
        res.status(200);
        await writeRankedAnalysisWorkbook(res, cases, createdAt);
        return undefined;
    } catch (error) {
        console.error("Frequency-ranked analysis export failed:", error);
        if (res.headersSent) {
            res.destroy(error);
            return undefined;
        }
        return res.status(500).json({
            error: "The frequency-ranked Excel export could not be generated."
        });
    }
}
