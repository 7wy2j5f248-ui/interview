import { createClient } from "@supabase/supabase-js";
import { authorizeResearcher } from "./researcherAuth.js";
import { loadParticipantCodeMap } from "./participantCodes.js";
import { rankAnalysisCase } from "./analysisFrequencyRanking.js";
import { enrichAnalysisHighlightSources } from "./analysisHighlightSources.js";

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

function mergedDemographics(report, descriptor) {
    const stored = demographicSnapshot(descriptor);
    const reported = report?.demographics || {};

    DEMOGRAPHIC_FIELDS.forEach(field => {
        const value = reported[field];
        if (value !== null && value !== undefined && value !== "") {
            stored[field] = value;
        }
    });
    stored.additional_descriptors = {
        ...(descriptor?.additional_descriptors || {}),
        ...(reported.additional_descriptors || {})
    };
    return stored;
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

function incompleteCompletionRemark(session, now = Date.now()) {
    if (session?.session_status === "timed_out") {
        return "Partially completed — inactivity timeout";
    }

    if (session?.session_status === "abandoned") {
        return "Partially completed — interview ended";
    }

    const lastActivity = Date.parse(
        session?.last_activity_at || session?.created_at || ""
    );
    const timeoutMinutes = Number(session?.inactivity_timeout_minutes) || 30;
    const timeoutAt = Number.isFinite(lastActivity)
        ? lastActivity + timeoutMinutes * 60 * 1000
        : null;

    return timeoutAt !== null && timeoutAt <= now
        ? "Partially completed — inactive past timeout"
        : "In progress";
}

function compactEvidencePreview(value, maximumLength = 180) {
    const text = typeof value === "string"
        ? value.replace(/\s+/g, " ").trim()
        : "";

    if (text.length <= maximumLength) return text;
    return `${text.slice(0, maximumLength - 1).trimEnd()}…`;
}

function incompleteCaseSummary(session, messages) {
    const participantMessages = (messages || []).filter(message =>
        String(message.Speaker || "").toLowerCase() === "user"
    );
    const interviewerMessages = (messages || []).filter(message =>
        String(message.Speaker || "").toLowerCase() === "ai"
    );
    const latestParticipantMessage = participantMessages.at(-1);
    const language = String(
        latestParticipantMessage?.Language || session?.language || ""
    ).trim().toLowerCase();
    const preview = compactEvidencePreview(
        latestParticipantMessage?.EnglishTranslation
        || (language === "en" ? latestParticipantMessage?.Message : "")
    );
    const recorded = `${participantMessages.length} participant response${
        participantMessages.length === 1 ? "" : "s"
    } and ${interviewerMessages.length} interviewer turn${
        interviewerMessages.length === 1 ? "" : "s"
    } recorded.`;

    return {
        participantResponseCount: participantMessages.length,
        interviewerTurnCount: interviewerMessages.length,
        briefSummary: preview
            ? `${recorded} Latest available participant response: “${preview}”`
            : `${recorded} No English response preview is available; open the transcript to inspect the recorded material.`
    };
}

async function loadIncompleteDashboard(supabase, page, from) {
    const [{ count, error: countError }, sessions] = await Promise.all([
        supabase
            .from("interview_sessions")
            .select("session_id", { count: "exact", head: true })
            .eq("completed", false)
            .in("session_status", ["timed_out", "abandoned"]),
        requireData(
            supabase
                .from("interview_sessions")
                .select("session_id, participant_id, language, completed, created_at, updated_at, last_activity_at, ended_at, session_status, end_reason, timed_out_at, inactivity_timeout_minutes")
                .eq("completed", false)
                .in("session_status", ["timed_out", "abandoned"])
                .order("created_at", { ascending: true })
                .order("session_id", { ascending: true })
                .range(from, from + PAGE_SIZE - 1),
            "Incomplete interview sessions could not be loaded."
        )
    ]);

    if (countError) {
        throw new Error("Incomplete interview total could not be loaded.", {
            cause: countError
        });
    }

    const sessionIds = sessions.map(session => session.session_id);
    const participantIds = sessions.map(session => session.participant_id);
    const [descriptors, participantCodes, caseCodes, messages] =
        await Promise.all([
        sessionIds.length ? requireData(
            supabase
                .from("participant_descriptors")
                .select("session_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors")
                .in("session_id", sessionIds),
            "Incomplete-session demographic details could not be loaded."
        ) : [],
        loadParticipantCodeMap(supabase, participantIds),
        sessionIds.length ? requireData(
            supabase
                .from("case_code_map")
                .select("session_id, case_number, session_number")
                .in("session_id", sessionIds),
            "Incomplete-session case codes could not be loaded."
        ) : [],
        sessionIds.length ? requireAllData(
            () => supabase
                .from("interview_messages")
                .select("id, Session, Language, Speaker, Message, EnglishTranslation, Timestamp")
                .in("Session", sessionIds)
                .order("Session", { ascending: true })
                .order("Timestamp", { ascending: true })
                .order("id", { ascending: true }),
            "Incomplete-session transcript evidence could not be loaded."
        ) : []
    ]);
    const descriptorBySession = new Map(descriptors.map(descriptor => [
        descriptor.session_id,
        descriptor
    ]));
    const caseCodeBySession = new Map(caseCodes.map(caseCode => [
        caseCode.session_id,
        caseCode
    ]));
    const messagesBySession = groupedBy(messages, "Session");

    return {
        page,
        pageSize: PAGE_SIZE,
        scope: "incomplete",
        generatedAt: new Date().toISOString(),
        counts: { incomplete: count || 0 },
        cases: sessions.map(session => {
            const participantCode = participantCodes.get(
                session.participant_id
            ) || null;
            const caseCode = caseCodeBySession.get(session.session_id);
            const partial = incompleteCaseSummary(
                session,
                messagesBySession.get(session.session_id) || []
            );
            const lifecycleRemark = incompleteCompletionRemark(session);

            return {
                caseNumber: caseCode?.case_number || participantCode,
                sessionNumber: caseCode?.session_number || null,
                status: "incomplete",
                hasReport: false,
                language: session.language || null,
                createdAt: session.created_at,
                lastActivityAt: session.last_activity_at,
                endedAt: session.ended_at,
                sessionStatus: session.session_status,
                endReason: session.end_reason,
                timedOutAt: session.timed_out_at,
                inactivityTimeoutMinutes: session.inactivity_timeout_minutes,
                completionRemark: lifecycleRemark === "In progress"
                    ? `${lifecycleRemark} — ${partial.participantResponseCount} participant response${partial.participantResponseCount === 1 ? "" : "s"} recorded; formal completion signal not yet received`
                    : `${lifecycleRemark} — ${partial.participantResponseCount} participant response${partial.participantResponseCount === 1 ? "" : "s"} recorded; formal completion signal missing`,
                briefSummary: partial.briefSummary,
                participantResponseCount: partial.participantResponseCount,
                interviewerTurnCount: partial.interviewerTurnCount,
                demographics: mergedDemographics(
                    null,
                    descriptorBySession.get(session.session_id) || {}
                ),
                transcriptIdentity: {
                    participantCode,
                    participantId: session.participant_id,
                    sessionId: session.session_id
                }
            };
        })
    };
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
    const scope = ["active", "archived", "incomplete"].includes(
        req.query?.scope
    ) ? req.query.scope : "active";
    const from = (page - 1) * PAGE_SIZE;

    try {
        if (scope === "incomplete") {
            return res.status(200).json(
                await loadIncompleteDashboard(supabase, page, from)
            );
        }

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
                        .select("id, session_id, case_number, participant_id, participant_code, language, demographics, case_interpretation, analysis_version, model, source_completed_at, completed_at, project_id, analysis_framework_id, source_report_id, reanalysis_request_id, analysis_hierarchy_audit")
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
        const projectIds = [...new Set(reports.map(report => report.project_id)
            .filter(Boolean))];
        const frameworkIds = [...new Set(reports.map(
            report => report.analysis_framework_id
        ).filter(Boolean))];
        const [
            codes,
            categories,
            themes,
            meaningUnits,
            codeMeaningUnits,
            categoryCodes,
            themeCategories,
            highlights,
            themeCodes,
            projects,
            frameworks
        ] =
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
                        .from("qualitative_case_categories")
                        .select("id, report_id, category_number, category_label, rationale")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("category_number", { ascending: true }),
                    "Case categories could not be loaded."
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
                        .from("qualitative_case_meaning_units")
                        .select("id, report_id, unit_number, message_id, exact_text, start_offset, end_offset, anchor_expressions")
                        .in("report_id", reportIds)
                        .order("report_id", { ascending: true })
                        .order("unit_number", { ascending: true }),
                    "Transcript meaning units could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_code_meaning_units")
                        .select("report_id, code_id, meaning_unit_id")
                        .in("report_id", reportIds),
                    "Code-to-meaning-unit relationships could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_category_codes")
                        .select("report_id, category_id, code_id")
                        .in("report_id", reportIds),
                    "Category-to-code relationships could not be loaded."
                ) : [],
                reportIds.length ? requireAllData(
                    () => supabase
                        .from("qualitative_case_theme_categories")
                        .select("report_id, theme_id, category_id")
                        .in("report_id", reportIds),
                    "Theme-to-category relationships could not be loaded."
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
                ) : [],
                projectIds.length ? requireData(
                    supabase
                        .from("research_projects")
                        .select("id, project_code, project_name, research_topic")
                        .in("id", projectIds),
                    "Case research-project lineage could not be loaded."
                ) : [],
                frameworkIds.length ? requireData(
                    supabase
                        .from("analysis_frameworks")
                        .select("id, project_id, version_number, predecessor_id, created_at")
                        .in("id", frameworkIds),
                    "Case analysis-framework lineage could not be loaded."
                ) : []
            ]);
        const enrichedMeaningUnits = await enrichAnalysisHighlightSources(
            supabase,
            meaningUnits
        );
        const enrichedHighlights = await enrichAnalysisHighlightSources(
            supabase,
            highlights
        );

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
        const categoriesByReport = groupedBy(categories, "report_id");
        const themesByReport = groupedBy(themes, "report_id");
        const meaningUnitsByReport = groupedBy(
            enrichedMeaningUnits,
            "report_id"
        );
        const codeMeaningUnitsByReport = groupedBy(
            codeMeaningUnits,
            "report_id"
        );
        const categoryCodesByReport = groupedBy(categoryCodes, "report_id");
        const themeCategoriesByReport = groupedBy(
            themeCategories,
            "report_id"
        );
        const highlightsByReport = groupedBy(
            enrichedHighlights,
            "report_id"
        );
        const mappingsByReport = groupedBy(themeCodes, "report_id");
        const projectById = new Map(projects.map(project => [
            project.id,
            project
        ]));
        const frameworkById = new Map(frameworks.map(framework => [
            framework.id,
            framework
        ]));

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
                hasReport: Boolean(report),
                sourceCompletedAt: job.source_completed_at,
                attemptCount: job.attempt_count,
                lastError: job.status === "failed" ? job.last_error : null,
                archivedAt: job.archived_at,
                archivedBy: job.archived_by,
                archiveNote: job.archive_note,
                language: report?.language || session?.language || null,
                demographics: mergedDemographics(report, descriptor),
                transcriptIdentity: {
                    participantCode,
                    participantId: job.participant_id,
                    sessionId: job.session_id
                }
            };

            if (!report) {
                return rankAnalysisCase(sharedCase, {
                    includeRankedCollections: false
                });
            }

            return rankAnalysisCase({
                ...sharedCase,
                analysisCompletedAt: report.completed_at,
                caseInterpretation: report.case_interpretation,
                analysisVersion: report.analysis_version,
                model: report.model,
                analysisHierarchyAudit:
                    report.analysis_hierarchy_audit || null,
                researchProject: projectById.get(report.project_id) || null,
                analysisFramework: frameworkById.get(
                    report.analysis_framework_id
                ) || null,
                reportLineage: {
                    reportId: report.id,
                    sourceReportId: report.source_report_id || null,
                    reanalysisRequestId: report.reanalysis_request_id || null
                },
                codes: codesByReport.get(report.id) || [],
                categories: categoriesByReport.get(report.id) || [],
                themes: themesByReport.get(report.id) || [],
                meaningUnits: meaningUnitsByReport.get(report.id) || [],
                codeMeaningUnits:
                    codeMeaningUnitsByReport.get(report.id) || [],
                categoryCodes: categoryCodesByReport.get(report.id) || [],
                themeCategories:
                    themeCategoriesByReport.get(report.id) || [],
                highlights: highlightsByReport.get(report.id) || [],
                themeCodes: mappingsByReport.get(report.id) || []
            }, {
                includeRankedCollections: false
            });
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
