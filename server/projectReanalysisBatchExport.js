import ExcelJS from "exceljs";
import {
    allRows,
    createTaskLimiter,
    rowsForIds
} from "./supabaseBatching.js";

const READY_BATCH_STATUSES = new Set([
    "completed",
    "completed_with_failures"
]);

function requireUuid(value, message = "Choose a valid project-wide run.") {
    const id = typeof value === "string" ? value.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(message);
    return id;
}

function cellText(value) {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    return text.length > 32_000 ? `${text.slice(0, 31_980)}…` : text;
}

function groupBy(rows, key) {
    return (rows || []).reduce((groups, row) => {
        const values = groups.get(row[key]) || [];
        values.push(row);
        groups.set(row[key], values);
        return groups;
    }, new Map());
}

function naturalCaseOrder(left, right) {
    return String(left.case_number || left.session_id).localeCompare(
        String(right.case_number || right.session_id),
        undefined,
        { numeric: true }
    );
}

async function requiredSingle(query, message) {
    const { data, error } = await query.single();
    if (error || !data) throw new Error(message, { cause: error || undefined });
    return data;
}

export async function loadProjectReanalysisBatchExport(supabase, batchIdValue) {
    const batchId = requireUuid(batchIdValue);
    const batch = await requiredSingle(
        supabase
            .from("analysis_framework_reanalysis_batches")
            .select("id, project_id, analysis_framework_id, reason_code, researcher_notes, requested_by, status, eligible_case_count, queued_case_count, processing_case_count, proposal_ready_case_count, approved_case_count, rejected_case_count, failed_case_count, cancelled_case_count, scope_snapshot, requested_at, updated_at, completed_at")
            .eq("id", batchId),
        "The project-wide re-analysis run was not found."
    );
    if (!READY_BATCH_STATUSES.has(batch.status)
        || batch.queued_case_count > 0
        || batch.processing_case_count > 0) {
        const error = new Error(
            "The complete batch review will be available after every eligible case has a proposal or a documented terminal failure."
        );
        error.status = 409;
        throw error;
    }

    const [project, framework, requests] = await Promise.all([
        requiredSingle(
            supabase
                .from("research_projects")
                .select("id, project_code, project_name, research_topic")
                .eq("id", batch.project_id),
            "The research-project lineage could not be loaded."
        ),
        requiredSingle(
            supabase
                .from("analysis_frameworks")
                .select("id, project_id, version_number, predecessor_id, study_scope, theme_requirements, code_derivation_rules, theme_code_fit_rules, inclusion_rules, exclusion_rules, provenance_expectations, application_scope, version_notes, created_at")
                .eq("id", batch.analysis_framework_id),
            "The Analysis Framework lineage could not be loaded."
        ),
        allRows(
            () => supabase
                .from("automatic_case_reanalysis_requests")
                .select("id, session_id, source_report_id, request_number, reason_code, researcher_notes, requested_by, status, analysis_version, model, attempt_count, requested_at, processing_started_at, proposal_ready_at, reviewed_at, last_error, project_id, analysis_framework_id, project_reanalysis_batch_id, cancelled_at, cancellation_reason")
                .eq("project_reanalysis_batch_id", batchId)
                .order("requested_at", { ascending: true }),
            "The batch's individual case requests could not be loaded."
        )
    ]);
    if (framework.project_id !== project.id) {
        throw new Error("The framework does not match the batch's research project/topic.");
    }

    const schedule = createTaskLimiter();
    const relatedRows = (ids, queryFactory, message) => rowsForIds(
        ids,
        queryFactory,
        message,
        { schedule }
    );
    const requestIds = requests.map(request => request.id);
    const sourceReportIds = requests.map(request => request.source_report_id);
    const [proposals, reviews, sourceReports] = await Promise.all([
        relatedRows(requestIds, chunk => supabase
            .from("automatic_case_reanalysis_proposals")
            .select("id, request_id, source_report_id, proposal_version, model, proposed_report, relevance_audit, source_quality_flags, input_token_count, created_at, project_id, analysis_framework_id")
            .in("request_id", chunk), "Batch proposals could not be loaded."),
        relatedRows(requestIds, chunk => supabase
            .from("automatic_case_reanalysis_reviews")
            .select("id, request_id, proposal_id, decision, reviewer_notes, reviewed_by, new_report_id, reviewed_at")
            .in("request_id", chunk), "Batch review lineage could not be loaded."),
        relatedRows(sourceReportIds, chunk => supabase
            .from("qualitative_case_reports")
            .select("id, session_id, case_number, participant_code, language, demographics, case_interpretation, analysis_version, model, created_at, completed_at, superseded_at, superseded_reason, source_report_id, reanalysis_request_id, project_id, analysis_framework_id")
            .in("id", chunk), "Preserved source reports could not be loaded.")
    ]);
    const reportIds = sourceReports.map(report => report.id);
    const [sourceCodes, sourceThemes, sourceHighlights, sourceThemeCodes] =
        await Promise.all([
            relatedRows(reportIds, chunk => supabase
                .from("qualitative_case_codes")
                .select("id, report_id, code_number, code_label, rationale, color_slot")
                .in("report_id", chunk), "Source codes could not be loaded."),
            relatedRows(reportIds, chunk => supabase
                .from("qualitative_case_themes")
                .select("id, report_id, theme_number, theme_label, rationale")
                .in("report_id", chunk), "Source themes could not be loaded."),
            relatedRows(reportIds, chunk => supabase
                .from("qualitative_case_keyword_highlights")
                .select("id, report_id, code_id, keyword_number, message_id, exact_text, start_offset, end_offset")
                .in("report_id", chunk), "Source keyword evidence could not be loaded."),
            relatedRows(reportIds, chunk => supabase
                .from("qualitative_case_theme_codes")
                .select("report_id, theme_id, code_id")
                .in("report_id", chunk), "Source theme-to-code links could not be loaded.")
        ]);

    const proposedMessageIds = proposals.flatMap(proposal =>
        (proposal.proposed_report?.codes || []).flatMap(code =>
            (code.highlights || []).map(highlight => highlight.messageId)
        )
    );
    const messageIds = [
        ...sourceHighlights.map(highlight => highlight.message_id),
        ...proposedMessageIds
    ];
    const messages = await relatedRows(messageIds, chunk => supabase
        .from("interview_messages")
        .select("id, Language, Message, EnglishTranslation")
        .in("id", chunk), "Transcript evidence translations could not be loaded.");

    return {
        batch,
        project,
        framework,
        requests,
        proposals,
        reviews,
        sourceReports,
        sourceCodes,
        sourceThemes,
        sourceHighlights,
        sourceThemeCodes,
        messages
    };
}

function configureSheet(sheet, columns) {
    sheet.columns = columns;
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length }
    };
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F4E78" }
    };
    header.alignment = { vertical: "middle", wrapText: true };
    header.commit();
}

function appendRow(sheet, value, tint = null) {
    const row = sheet.addRow(value);
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 30;
    if (tint) {
        row.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: tint }
        };
    }
    row.commit();
}

function finishSheet(sheet) {
    sheet.commit();
}

function summarizeThemes(report) {
    return (report?.themes || []).map((theme, index) =>
        `T${index + 1} ${theme.label}`
    ).join("; ");
}

function summarizeCodes(report) {
    return (report?.codes || []).map((code, index) =>
        `C${index + 1} ${code.label}`
    ).join("; ");
}

function summaryRows(data, createdAt) {
    const { batch, project, framework, requests, proposals, sourceReports } = data;
    const statusCount = status => requests.filter(
        request => request.status === status
    ).length;
    const preserved = sourceReports.filter(report => !report.superseded_at).length;
    return [
        ["Export type", "Complete project-wide revised analysis — proposed output only"],
        ["Research project", project.project_name],
        ["Research topic", project.research_topic],
        ["Project code", project.project_code],
        ["Analysis Framework version", framework.version_number],
        ["Analysis Framework ID", framework.id],
        ["Framework predecessor", framework.predecessor_id || "None"],
        ["Batch ID", batch.id],
        ["Batch status", batch.status],
        ["Requested at", batch.requested_at],
        ["Completed at", batch.completed_at],
        ["Exported at", createdAt.toISOString()],
        ["Eligible cases", batch.eligible_case_count],
        ["Stored case requests", requests.length],
        ["Proposal-ready cases", statusCount("proposal_ready")],
        ["Failed cases", statusCount("failed")],
        ["Cancelled cases", statusCount("cancelled")],
        ["Stored proposals", proposals.length],
        ["Current source reports preserved", `${preserved}/${sourceReports.length}`],
        ["Promotion caused by download", "None — downloading does not approve, promote, supersede, or overwrite any report"],
        ["Batch reason", batch.reason_code],
        ["Researcher notes", batch.researcher_notes],
        ["Study scope", framework.study_scope],
        ["Theme requirements", framework.theme_requirements],
        ["Code derivation rules", framework.code_derivation_rules],
        ["Theme-to-code fit rules", framework.theme_code_fit_rules],
        ["Inclusion rules", framework.inclusion_rules],
        ["Exclusion rules", framework.exclusion_rules],
        ["Provenance expectations", framework.provenance_expectations],
        ["Scope/exclusion snapshot", cellText(batch.scope_snapshot)]
    ];
}

function addSummarySheet(workbook, data, createdAt) {
    const sheet = workbook.addWorksheet("1 Batch summary", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    configureSheet(sheet, [
        { header: "Field", key: "field", width: 34 },
        { header: "Verified value", key: "value", width: 100 }
    ]);
    summaryRows(data, createdAt).forEach(([field, value], index) => {
        appendRow(sheet, {
            field,
            value: cellText(value)
        }, index === 0 || index === 19 ? "FFFFF2CC" : null);
    });
    finishSheet(sheet);
}

function mappedData(data) {
    return {
        requestById: new Map(data.requests.map(item => [item.id, item])),
        proposalByRequest: new Map(data.proposals.map(item => [item.request_id, item])),
        reviewByRequest: new Map(data.reviews.map(item => [item.request_id, item])),
        reportById: new Map(data.sourceReports.map(item => [item.id, item])),
        codesByReport: groupBy(data.sourceCodes, "report_id"),
        themesByReport: groupBy(data.sourceThemes, "report_id"),
        highlightsByReport: groupBy(data.sourceHighlights, "report_id"),
        linksByReport: groupBy(data.sourceThemeCodes, "report_id"),
        messageById: new Map(data.messages.map(item => [String(item.id), item]))
    };
}

function orderedRequests(data, maps) {
    return [...data.requests].sort((left, right) => {
        const leftReport = maps.reportById.get(left.source_report_id) || left;
        const rightReport = maps.reportById.get(right.source_report_id) || right;
        return naturalCaseOrder(leftReport, rightReport);
    });
}

function sourceHierarchySummary(report, maps) {
    const themes = (maps.themesByReport.get(report.id) || [])
        .sort((a, b) => a.theme_number - b.theme_number)
        .map(theme => `T${theme.theme_number} ${theme.theme_label}`)
        .join("; ");
    const codes = (maps.codesByReport.get(report.id) || [])
        .sort((a, b) => a.code_number - b.code_number)
        .map(code => `C${code.code_number} ${code.code_label}`)
        .join("; ");
    return { themes, codes };
}

function addComparisonSheet(workbook, data, maps) {
    const sheet = workbook.addWorksheet("2 Case comparison", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    configureSheet(sheet, [
        { header: "Case", key: "case", width: 16 },
        { header: "Participant", key: "participant", width: 12 },
        { header: "Session ID", key: "session", width: 22 },
        { header: "Request status", key: "status", width: 18 },
        { header: "Request #", key: "requestNumber", width: 10 },
        { header: "Source report ID", key: "sourceId", width: 38 },
        { header: "Source/current status", key: "sourceStatus", width: 20 },
        { header: "Source analysis version", key: "sourceVersion", width: 24 },
        { header: "Source case interpretation", key: "sourceInterpretation", width: 55 },
        { header: "Source themes", key: "sourceThemes", width: 55 },
        { header: "Source codes", key: "sourceCodes", width: 55 },
        { header: "Proposed report ID", key: "proposalId", width: 38 },
        { header: "Proposed analysis version", key: "proposalVersion", width: 28 },
        { header: "Proposed case interpretation", key: "proposedInterpretation", width: 55 },
        { header: "Proposed themes", key: "proposedThemes", width: 55 },
        { header: "Proposed codes", key: "proposedCodes", width: 55 },
        { header: "Relevance audit", key: "audit", width: 42 },
        { header: "Theme hierarchy audit", key: "hierarchyAudit", width: 55 },
        { header: "Source-quality flags", key: "flags", width: 20 },
        { header: "Failure / exclusion", key: "failure", width: 45 },
        { header: "Researcher reason", key: "reason", width: 30 },
        { header: "Researcher notes", key: "notes", width: 55 },
        { header: "Framework version", key: "frameworkVersion", width: 18 },
        { header: "Project / topic", key: "projectTopic", width: 40 },
        { header: "Proposal created", key: "proposalCreated", width: 24 },
        { header: "Review decision", key: "decision", width: 18 }
    ]);
    orderedRequests(data, maps).forEach(request => {
        const report = maps.reportById.get(request.source_report_id) || {};
        const proposal = maps.proposalByRequest.get(request.id);
        const review = maps.reviewByRequest.get(request.id);
        const source = sourceHierarchySummary(report, maps);
        const checks = proposal?.relevance_audit?.checks || [];
        appendRow(sheet, {
            case: report.case_number || request.session_id,
            participant: report.participant_code || "",
            session: request.session_id,
            status: request.status,
            requestNumber: request.request_number,
            sourceId: request.source_report_id,
            sourceStatus: report.superseded_at
                ? `Superseded ${report.superseded_at}`
                : "Current report preserved",
            sourceVersion: report.analysis_version || "",
            sourceInterpretation: cellText(report.case_interpretation),
            sourceThemes: cellText(source.themes),
            sourceCodes: cellText(source.codes),
            proposalId: proposal?.id || "",
            proposalVersion: proposal?.proposal_version || "",
            proposedInterpretation: cellText(
                proposal?.proposed_report?.caseInterpretation
            ),
            proposedThemes: cellText(summarizeThemes(proposal?.proposed_report)),
            proposedCodes: cellText(summarizeCodes(proposal?.proposed_report)),
            audit: proposal
                ? `${checks.filter(check => check.accepted).length}/${checks.length} accepted · ${proposal.relevance_audit?.overallSummary || ""}`
                : "",
            hierarchyAudit: proposal
                ? (() => {
                    const hierarchy = proposal.relevance_audit
                        ?.labelQualityAudit?.themeHierarchy;
                    return hierarchy
                        ? `${(hierarchy.checks || []).filter(check => check.accepted).length}/${(hierarchy.checks || []).length} themes accepted · ${(hierarchy.ungroupedCodes || []).length} ungrouped review-needed codes · no automatic promotion`
                        : "Not audited under the expanded global theme hierarchy standard";
                })()
                : "",
            flags: (proposal?.source_quality_flags || []).length,
            failure: request.last_error || request.cancellation_reason || "",
            reason: request.reason_code,
            notes: cellText(request.researcher_notes),
            frameworkVersion: data.framework.version_number,
            projectTopic: `${data.project.project_name} / ${data.project.research_topic}`,
            proposalCreated: proposal?.created_at || "",
            decision: review?.decision || "Not reviewed — proposal only"
        }, proposal ? "FFFFF2CC" : request.status === "failed" ? "FFFCE4D6" : null);
    });
    finishSheet(sheet);
}

function evidenceTranslation(maps, messageId) {
    const message = maps.messageById.get(String(messageId));
    return {
        language: message?.Language || "",
        message: cellText(message?.Message),
        english: cellText(message?.EnglishTranslation)
    };
}

function addSourceEvidenceSheet(workbook, data, maps) {
    const sheet = workbook.addWorksheet("3 Current source evidence", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    configureSheet(sheet, [
        { header: "Case", key: "case", width: 16 },
        { header: "Source report ID", key: "sourceId", width: 38 },
        { header: "Tn", key: "themePosition", width: 7 },
        { header: "Current theme", key: "theme", width: 28 },
        { header: "Theme rationale", key: "themeRationale", width: 55 },
        { header: "Cn", key: "codePosition", width: 7 },
        { header: "Current code", key: "code", width: 30 },
        { header: "Code rationale", key: "codeRationale", width: 55 },
        { header: "Kn", key: "keywordPosition", width: 7 },
        { header: "Message ID", key: "messageId", width: 28 },
        { header: "Exact keyword evidence", key: "exact", width: 45 },
        { header: "Source language", key: "language", width: 14 },
        { header: "Stored source message", key: "message", width: 55 },
        { header: "Stored English translation", key: "english", width: 55 }
    ]);
    orderedRequests(data, maps).forEach(request => {
        const report = maps.reportById.get(request.source_report_id) || {};
        const themes = maps.themesByReport.get(report.id) || [];
        const codes = maps.codesByReport.get(report.id) || [];
        const highlights = maps.highlightsByReport.get(report.id) || [];
        const links = maps.linksByReport.get(report.id) || [];
        const linkedCodeIds = new Set();
        themes.sort((a, b) => a.theme_number - b.theme_number).forEach(theme => {
            const themeCodes = links.filter(link => link.theme_id === theme.id)
                .map(link => codes.find(code => code.id === link.code_id))
                .filter(Boolean)
                .sort((a, b) => a.code_number - b.code_number);
            if (!themeCodes.length) {
                appendRow(sheet, {
                    case: report.case_number,
                    sourceId: report.id,
                    themePosition: `T${theme.theme_number}`,
                    theme: theme.theme_label,
                    themeRationale: cellText(theme.rationale)
                });
            }
            themeCodes.forEach(code => {
                linkedCodeIds.add(code.id);
                const codeHighlights = highlights.filter(
                    highlight => highlight.code_id === code.id
                ).sort((a, b) => a.keyword_number - b.keyword_number);
                (codeHighlights.length ? codeHighlights : [null]).forEach(highlight => {
                    const translation = evidenceTranslation(
                        maps,
                        highlight?.message_id
                    );
                    appendRow(sheet, {
                        case: report.case_number,
                        sourceId: report.id,
                        themePosition: `T${theme.theme_number}`,
                        theme: theme.theme_label,
                        themeRationale: cellText(theme.rationale),
                        codePosition: `C${code.code_number}`,
                        code: code.code_label,
                        codeRationale: cellText(code.rationale),
                        keywordPosition: highlight ? `K${highlight.keyword_number}` : "",
                        messageId: highlight?.message_id || "",
                        exact: cellText(highlight?.exact_text),
                        ...translation
                    });
                });
            });
        });
        codes.filter(code => !linkedCodeIds.has(code.id)).forEach(code => {
            const codeHighlights = highlights.filter(
                highlight => highlight.code_id === code.id
            );
            (codeHighlights.length ? codeHighlights : [null]).forEach(highlight => {
                appendRow(sheet, {
                    case: report.case_number,
                    sourceId: report.id,
                    theme: "Unassigned in preserved source",
                    codePosition: `C${code.code_number}`,
                    code: code.code_label,
                    codeRationale: cellText(code.rationale),
                    keywordPosition: highlight ? `K${highlight.keyword_number}` : "",
                    messageId: highlight?.message_id || "",
                    exact: cellText(highlight?.exact_text),
                    ...evidenceTranslation(maps, highlight?.message_id)
                });
            });
        });
    });
    finishSheet(sheet);
}

function addProposedEvidenceSheet(workbook, data, maps) {
    const sheet = workbook.addWorksheet("4 Revised proposed evidence", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    configureSheet(sheet, [
        { header: "Case", key: "case", width: 16 },
        { header: "Proposal ID", key: "proposalId", width: 38 },
        { header: "Tn", key: "themePosition", width: 7 },
        { header: "PROPOSED theme", key: "theme", width: 28 },
        { header: "Proposed theme rationale", key: "themeRationale", width: 55 },
        { header: "Cn", key: "codePosition", width: 7 },
        { header: "PROPOSED code", key: "code", width: 30 },
        { header: "Proposed code rationale", key: "codeRationale", width: 55 },
        { header: "Kn", key: "keywordPosition", width: 7 },
        { header: "Message ID", key: "messageId", width: 28 },
        { header: "Exact proposed evidence", key: "exact", width: 45 },
        { header: "Source language", key: "language", width: 14 },
        { header: "Stored source message", key: "message", width: 55 },
        { header: "Stored English translation", key: "english", width: 55 },
        { header: "Framework version", key: "frameworkVersion", width: 18 },
        { header: "Proposal status", key: "status", width: 18 }
    ]);
    orderedRequests(data, maps).forEach(request => {
        const source = maps.reportById.get(request.source_report_id) || {};
        const proposal = maps.proposalByRequest.get(request.id);
        if (!proposal) return;
        const report = proposal.proposed_report || {};
        const codes = report.codes || [];
        const linkedCodes = new Set();
        (report.themes || []).forEach((theme, themeIndex) => {
            const codeNumbers = theme.codeNumbers || [];
            if (!codeNumbers.length) {
                appendRow(sheet, {
                    case: source.case_number || request.session_id,
                    proposalId: proposal.id,
                    themePosition: `T${themeIndex + 1}`,
                    theme: theme.label,
                    themeRationale: cellText(theme.rationale),
                    frameworkVersion: data.framework.version_number,
                    status: "Proposal only"
                }, "FFFFF2CC");
            }
            codeNumbers.forEach(codeNumber => {
                const code = codes[codeNumber - 1];
                if (!code) return;
                linkedCodes.add(codeNumber);
                const highlights = code.highlights || [];
                (highlights.length ? highlights : [null]).forEach((highlight, index) => {
                    appendRow(sheet, {
                        case: source.case_number || request.session_id,
                        proposalId: proposal.id,
                        themePosition: `T${themeIndex + 1}`,
                        theme: theme.label,
                        themeRationale: cellText(theme.rationale),
                        codePosition: `C${codeNumber}`,
                        code: code.label,
                        codeRationale: cellText(code.rationale),
                        keywordPosition: highlight ? `K${index + 1}` : "",
                        messageId: highlight?.messageId || "",
                        exact: cellText(highlight?.exactText),
                        ...evidenceTranslation(maps, highlight?.messageId),
                        frameworkVersion: data.framework.version_number,
                        status: "Proposal only — not current"
                    }, "FFFFF2CC");
                });
            });
        });
        codes.forEach((code, codeIndex) => {
            if (linkedCodes.has(codeIndex + 1)) return;
            const highlights = code.highlights || [];
            (highlights.length ? highlights : [null]).forEach((highlight, index) => {
                appendRow(sheet, {
                    case: source.case_number || request.session_id,
                    proposalId: proposal.id,
                    theme: "Ungrouped review-needed code — no theme invented",
                    codePosition: `C${codeIndex + 1}`,
                    code: code.label,
                    codeRationale: cellText(code.rationale),
                    keywordPosition: highlight ? `K${index + 1}` : "",
                    messageId: highlight?.messageId || "",
                    exact: cellText(highlight?.exactText),
                    ...evidenceTranslation(maps, highlight?.messageId),
                    frameworkVersion: data.framework.version_number,
                    status: "Proposal only — not current"
                }, "FFFFF2CC");
            });
        });
    });
    finishSheet(sheet);
}

function addAuditSheet(workbook, data, maps) {
    const sheet = workbook.addWorksheet("5 Relevance & quality audit", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    configureSheet(sheet, [
        { header: "Case", key: "case", width: 16 },
        { header: "Request status", key: "status", width: 18 },
        { header: "Record type", key: "type", width: 24 },
        { header: "Cn", key: "codePosition", width: 7 },
        { header: "Code", key: "code", width: 30 },
        { header: "Themes", key: "themes", width: 40 },
        { header: "Message ID", key: "messageId", width: 28 },
        { header: "Exact evidence / source turn", key: "exact", width: 50 },
        { header: "Transcript grounded", key: "grounded", width: 20 },
        { header: "Supports code", key: "supportsCode", width: 16 },
        { header: "Supports theme", key: "supportsTheme", width: 18 },
        { header: "Project-scope relevant", key: "scope", width: 22 },
        { header: "Accepted", key: "accepted", width: 12 },
        { header: "Explanation", key: "explanation", width: 65 },
        { header: "Failure / cancellation", key: "failure", width: 50 }
    ]);
    orderedRequests(data, maps).forEach(request => {
        const source = maps.reportById.get(request.source_report_id) || {};
        const proposal = maps.proposalByRequest.get(request.id);
        const checks = proposal?.relevance_audit?.checks || [];
        const hierarchy = proposal?.relevance_audit
            ?.labelQualityAudit?.themeHierarchy;
        const flags = proposal?.source_quality_flags || [];
        if (!checks.length && !flags.length && !hierarchy) {
            appendRow(sheet, {
                case: source.case_number || request.session_id,
                status: request.status,
                type: request.status === "failed" ? "Terminal failure" : "No stored audit row",
                failure: request.last_error || request.cancellation_reason || ""
            }, request.status === "failed" ? "FFFCE4D6" : null);
        }
        checks.forEach(check => appendRow(sheet, {
            case: source.case_number || request.session_id,
            status: request.status,
            type: "Independent relevance check",
            codePosition: `C${check.codeNumber}`,
            code: check.codeLabel,
            themes: (check.themeLabels || []).join("; "),
            messageId: check.messageId,
            exact: cellText(check.exactText),
            grounded: check.transcriptGrounded,
            supportsCode: check.supportsCode,
            supportsTheme: check.supportsTheme,
            scope: check.researchScopeRelevant,
            accepted: check.accepted,
            explanation: cellText(check.explanation)
        }, check.accepted ? "FFE2F0D9" : "FFFCE4D6"));
        (hierarchy?.checks || []).forEach(check => appendRow(sheet, {
            case: source.case_number || request.session_id,
            status: request.status,
            type: "Theme hierarchy audit",
            themes: `T${check.number} ${check.label} ← ${(check.codeNumbers || []).map(number => `C${number}`).join(", ")}`,
            supportsTheme: check.themeHasMultipleCodes
                && check.themeSemanticCoverage
                && check.themeHigherLevelAbstraction
                && check.themeNotOneToOneParaphrase
                && check.themeCoherentStory,
            scope: check.topicRelevant,
            accepted: check.accepted,
            explanation: cellText(check.explanation)
        }, check.accepted ? "FFE2F0D9" : "FFFCE4D6"));
        (hierarchy?.ungroupedCodes || []).forEach(check => appendRow(sheet, {
            case: source.case_number || request.session_id,
            status: request.status,
            type: "Ungrouped review-needed code",
            codePosition: `C${check.codeNumber}`,
            code: check.label,
            supportsTheme: false,
            accepted: check.accepted,
            explanation: cellText(`${check.reason} No theme was invented.`)
        }, "FFFFF2CC"));
        flags.forEach(flag => appendRow(sheet, {
            case: source.case_number || request.session_id,
            status: request.status,
            type: `Source-quality flag: ${flag.issueType || "issue"}`,
            messageId: flag.messageId || "",
            exact: cellText(flag.exactText),
            explanation: cellText(flag.explanation)
        }, "FFFCE4D6"));
    });
    finishSheet(sheet);
}

export async function writeProjectReanalysisBatchWorkbook(
    stream,
    data,
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
    const maps = mappedData(data);
    addSummarySheet(workbook, data, createdAt);
    addComparisonSheet(workbook, data, maps);
    addSourceEvidenceSheet(workbook, data, maps);
    addProposedEvidenceSheet(workbook, data, maps);
    addAuditSheet(workbook, data, maps);
    await workbook.commit();
}
