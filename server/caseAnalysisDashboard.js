import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "./researcherAuth.js";

const PAGE_SIZE = 100;

function groupedBy(items, key) {
    return (items || []).reduce((groups, item) => {
        const value = item[key];
        const group = groups.get(value) || [];
        group.push(item);
        groups.set(value, group);
        return groups;
    }, new Map());
}

async function requireData(query, message) {
    const { data, error } = await query;

    if (error) {
        throw new Error(message, { cause: error });
    }

    return data || [];
}

async function loadCounts(supabase) {
    const statuses = ["pending", "processing", "completed", "failed"];
    const values = await Promise.all(statuses.map(async status => {
        const { count, error } = await supabase
            .from("automatic_case_analysis_jobs")
            .select("session_id", { count: "exact", head: true })
            .eq("status", status);

        if (error) {
            throw new Error("Automatic analysis totals could not be loaded.", {
                cause: error
            });
        }

        return [status, count || 0];
    }));

    return Object.fromEntries(values);
}

export async function handleCaseAnalysisDashboard(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed." });
    }

    const authorization = authorizeResearcher(
        req,
        process.env.RESEARCHER_DASHBOARD_TOKEN
    );

    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const from = (page - 1) * PAGE_SIZE;

    try {
        const [counts, jobs] = await Promise.all([
            loadCounts(supabase),
            requireData(
                supabase
                    .from("automatic_case_analysis_jobs")
                    .select("session_id, case_number, source_completed_at, status, attempt_count, completed_at, last_error")
                    .order("source_completed_at", { ascending: true })
                    .order("session_id", { ascending: true })
                    .range(from, from + PAGE_SIZE - 1),
                "Automatic case-analysis progress could not be loaded."
            )
        ]);
        const sessionIds = jobs.map(job => job.session_id);

        if (!sessionIds.length) {
            return res.status(200).json({
                page,
                pageSize: PAGE_SIZE,
                counts,
                cases: []
            });
        }

        const reports = await requireData(
            supabase
                .from("qualitative_case_reports")
                .select("id, session_id, case_number, participant_id, participant_code, language, demographics, case_interpretation, analysis_version, model, source_completed_at, completed_at")
                .in("session_id", sessionIds),
            "Individual case reports could not be loaded."
        );
        const reportIds = reports.map(report => report.id);
        const [codes, themes, highlights, themeCodes, messages] =
            await Promise.all([
                reportIds.length ? requireData(
                    supabase
                        .from("qualitative_case_codes")
                        .select("id, report_id, code_number, code_label, rationale, color_slot")
                        .in("report_id", reportIds)
                        .order("code_number", { ascending: true }),
                    "Case codes could not be loaded."
                ) : [],
                reportIds.length ? requireData(
                    supabase
                        .from("qualitative_case_themes")
                        .select("id, report_id, theme_number, theme_label, rationale")
                        .in("report_id", reportIds)
                        .order("theme_number", { ascending: true }),
                    "Case themes could not be loaded."
                ) : [],
                reportIds.length ? requireData(
                    supabase
                        .from("qualitative_case_keyword_highlights")
                        .select("id, report_id, code_id, keyword_number, message_id, exact_text, start_offset, end_offset")
                        .in("report_id", reportIds)
                        .order("keyword_number", { ascending: true }),
                    "Transcript keyword highlights could not be loaded."
                ) : [],
                reportIds.length ? requireData(
                    supabase
                        .from("qualitative_case_theme_codes")
                        .select("report_id, theme_id, code_id")
                        .in("report_id", reportIds),
                    "Theme-to-code relationships could not be loaded."
                ) : [],
                reportIds.length ? requireData(
                    supabase
                        .from("interview_messages")
                        .select("id, Participant, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                        .in("Session", reports.map(report => report.session_id))
                        .order("Timestamp", { ascending: true }),
                    "Case transcripts could not be loaded."
                ) : []
            ]);

        const reportBySession = new Map(reports.map(report => [
            report.session_id,
            report
        ]));
        const codesByReport = groupedBy(codes, "report_id");
        const themesByReport = groupedBy(themes, "report_id");
        const highlightsByReport = groupedBy(highlights, "report_id");
        const mappingsByReport = groupedBy(themeCodes, "report_id");
        const messagesBySession = groupedBy(messages, "Session");

        const cases = jobs.map(job => {
            const report = reportBySession.get(job.session_id);

            if (!report) {
                return {
                    caseNumber: job.case_number,
                    status: job.status,
                    sourceCompletedAt: job.source_completed_at,
                    attemptCount: job.attempt_count,
                    lastError: job.status === "failed" ? job.last_error : null
                };
            }

            return {
                caseNumber: report.case_number,
                status: job.status,
                sourceCompletedAt: report.source_completed_at,
                analysisCompletedAt: report.completed_at,
                language: report.language,
                demographics: report.demographics,
                caseInterpretation: report.case_interpretation,
                analysisVersion: report.analysis_version,
                model: report.model,
                transcriptIdentity: {
                    participantCode: report.participant_code,
                    participantId: report.participant_id,
                    sessionId: report.session_id
                },
                codes: codesByReport.get(report.id) || [],
                themes: themesByReport.get(report.id) || [],
                highlights: highlightsByReport.get(report.id) || [],
                themeCodes: mappingsByReport.get(report.id) || [],
                transcript: messagesBySession.get(report.session_id) || []
            };
        });

        return res.status(200).json({
            page,
            pageSize: PAGE_SIZE,
            counts,
            cases
        });
    } catch (error) {
        console.error("Automatic case-analysis dashboard failed:", error);
        return res.status(500).json({
            error: "Unable to load automatic individual case analysis."
        });
    }
}
