import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "./researcherAuth.js";
import { loadParticipantCodeMap } from "./participantCodes.js";

const PAGE_SIZE = 100;
const DATABASE_PAGE_SIZE = 1000;
const DEMOGRAPHIC_FIELDS = Object.freeze([
    "current_country",
    "current_region",
    "country_of_origin",
    "diaspora_status",
    "gender",
    "age",
    "birth_year",
    "birth_cohort",
    "youth_status",
    "education_level",
    "social_identity",
    "additional_descriptors"
]);

function demographicSnapshot(descriptor) {
    return Object.fromEntries(DEMOGRAPHIC_FIELDS.map(field => [
        field,
        descriptor?.[field] ?? null
    ]));
}

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

async function requireAllData(queryFactory, message) {
    const records = [];

    for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
        const { data, error } = await queryFactory().range(
            from,
            from + DATABASE_PAGE_SIZE - 1
        );

        if (error) {
            throw new Error(message, { cause: error });
        }

        records.push(...(data || []));
        if (!data || data.length < DATABASE_PAGE_SIZE) break;
    }

    return records;
}

function archiveScope(query, scope) {
    return scope === "archived"
        ? query.not("archived_at", "is", null)
        : query.is("archived_at", null);
}

async function loadCounts(supabase, scope) {
    const statuses = ["pending", "processing", "completed", "failed"];
    const values = await Promise.all(statuses.map(async status => {
        const { count, error } = await archiveScope(
            supabase
                .from("automatic_case_analysis_jobs")
                .select("session_id", { count: "exact", head: true })
                .eq("status", status),
            scope
        );

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
    res.setHeader(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Vary", "Authorization");

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
    const scope = req.query?.scope === "archived" ? "archived" : "active";
    const from = (page - 1) * PAGE_SIZE;

    try {
        const jobsQuery = archiveScope(
            supabase
                .from("automatic_case_analysis_jobs")
                .select("session_id, participant_id, case_number, source_completed_at, status, attempt_count, completed_at, last_error, archived_at, archived_by, archive_note"),
            scope
        )
            .order(
                scope === "archived" ? "archived_at" : "source_completed_at",
                { ascending: scope !== "archived" }
            )
            .order("session_id", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        const [counts, jobs] = await Promise.all([
            loadCounts(supabase, scope),
            requireData(
                jobsQuery,
                "Automatic case-analysis progress could not be loaded."
            )
        ]);
        const sessionIds = jobs.map(job => job.session_id);

        if (!sessionIds.length) {
            return res.status(200).json({
                page,
                pageSize: PAGE_SIZE,
                scope,
                counts,
                cases: []
            });
        }

        const [reports, sessions, descriptors, participantCodes] =
            await Promise.all([
                requireData(
                    supabase
                        .from("qualitative_case_reports")
                        .select("id, session_id, case_number, participant_id, participant_code, language, demographics, case_interpretation, analysis_version, model, source_completed_at, completed_at")
                        .is("superseded_at", null)
                        .in("session_id", sessionIds),
                    "Individual case reports could not be loaded."
                ),
                requireData(
                    supabase
                        .from("interview_sessions")
                        .select("session_id, participant_id, language")
                        .in("session_id", sessionIds),
                    "Case session details could not be loaded."
                ),
                requireData(
                    supabase
                        .from("participant_descriptors")
                        .select("session_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors")
                        .in("session_id", sessionIds),
                    "Case demographic details could not be loaded."
                ),
                loadParticipantCodeMap(
                    supabase,
                    jobs.map(job => job.participant_id)
                )
            ]);
        const reportIds = reports.map(report => report.id);
        const [codes, themes, highlights, themeCodes] =
            await Promise.all([
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_codes")
                        .select("id, report_id, code_number, code_label, rationale, color_slot")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("code_number", { ascending: true }),
                    "Case codes could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_themes")
                        .select("id, report_id, theme_number, theme_label, rationale")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("theme_number", { ascending: true }),
                    "Case themes could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_keyword_highlights")
                        .select("id, report_id, code_id, keyword_number, message_id, exact_text, start_offset, end_offset")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("keyword_number", { ascending: true }),
                    "Transcript keyword highlights could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_theme_codes")
                        .select("report_id, theme_id, code_id")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("theme_id", { ascending: true })
                        .order("code_id", { ascending: true }),
                    "Theme-to-code relationships could not be loaded."
                ) : []
            ]);

        const reportBySession = new Map(reports.map(report => [
            report.session_id,
            report
        ]));
        const sessionById = new Map(sessions.map(session => [
            session.session_id,
            session
        ]));
        const descriptorBySession = new Map(descriptors.map(descriptor => [
            descriptor.session_id,
            descriptor
        ]));
        const codesByReport = groupedBy(codes, "report_id");
        const themesByReport = groupedBy(themes, "report_id");
        const highlightsByReport = groupedBy(highlights, "report_id");
        const mappingsByReport = groupedBy(themeCodes, "report_id");

        const cases = jobs.map(job => {
            const report = reportBySession.get(job.session_id);
            const session = sessionById.get(job.session_id);
            const descriptor = descriptorBySession.get(job.session_id) || {};
            const participantCode = report?.participant_code
                || participantCodes.get(job.participant_id)
                || null;
            const sharedCase = {
                caseNumber: job.case_number,
                status: job.status,
                sourceCompletedAt: job.source_completed_at,
                attemptCount: job.attempt_count,
                lastError: job.status === "failed" ? job.last_error : null,
                archivedAt: job.archived_at,
                archivedBy: job.archived_by,
                archiveNote: job.archive_note,
                language: report?.language || session?.language || null,
                demographics: report?.demographics
                    || demographicSnapshot(descriptor),
                transcriptIdentity: {
                    participantCode,
                    participantId: job.participant_id,
                    sessionId: job.session_id
                }
            };

            if (!report) {
                return sharedCase;
            }

            return {
                ...sharedCase,
                analysisCompletedAt: report.completed_at,
                caseInterpretation: report.case_interpretation,
                analysisVersion: report.analysis_version,
                model: report.model,
                codes: codesByReport.get(report.id) || [],
                themes: themesByReport.get(report.id) || [],
                highlights: highlightsByReport.get(report.id) || [],
                themeCodes: mappingsByReport.get(report.id) || []
            };
        });

        return res.status(200).json({
            page,
            pageSize: PAGE_SIZE,
            scope,
            generatedAt: new Date().toISOString(),
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

export async function handleCaseArchiveMutation(req, res) {
    const authorization = authorizeResearcher(
        req,
        process.env.RESEARCHER_DASHBOARD_TOKEN
    );

    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }

    const action = req.body?.action;
    const sessionId = typeof req.body?.sessionId === "string"
        ? req.body.sessionId.trim()
        : "";
    const note = typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (!["archive", "restore"].includes(action) || !sessionId) {
        return res.status(400).json({
            error: "A valid archive action and session are required."
        });
    }

    if (note.length > 500) {
        return res.status(400).json({
            error: "Archive notes must be 500 characters or fewer."
        });
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: changed, error } = await supabase.rpc(
        "set_automatic_case_archive",
        {
            p_session_id: sessionId,
            p_action: action,
            p_note: note || null
        }
    );

    if (error) {
        console.error("Automatic case archive action failed:", error);
        return res.status(500).json({
            error: "The archive could not be updated."
        });
    }

    if (!changed) {
        return res.status(409).json({
            error: action === "archive"
                ? "Only a completed active case can be archived."
                : "This case is not currently archived."
        });
    }

    return res.status(200).json({
        archived: action === "archive",
        sessionId
    });
}
