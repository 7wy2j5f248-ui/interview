import ExcelJS from "exceljs";
import { buildCaseInspection } from "./caseBoundInspection.js";
import { rowsForIds } from "./supabaseBatching.js";

export const CASE_BOUND_STAGE1_WORKBOOK_VERSION =
    "case-bound-stage1-cohort-workbook-v3";

export const CASE_BOUND_STAGE1_WORKBOOK_SHEETS = Object.freeze([
    "1 Participant Information",
    "2 Meaning Units",
    "3 Codes",
    "4 Categories",
    "5 Themes",
    "6 Notes & Sources"
]);

const DESCRIPTOR_COLUMNS = Object.freeze([
    "current_country", "current_region", "country_of_origin",
    "diaspora_status", "gender", "age", "birth_year", "birth_cohort",
    "youth_status", "education_level", "social_identity",
    "additional_descriptors"
]);

const PARTICIPANT_INFORMATION_COLUMNS = Object.freeze([
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

function requireUuid(value, message) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
        throw Object.assign(new Error(message), { status: 400 });
    }
    return id;
}

async function requireRows(query, message) {
    const { data, error } = await query;
    if (error) throw new Error(message, { cause: error });
    return data || [];
}

function value(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "boolean"
        || value instanceof Date) return value;
    if (typeof value === "object" && (value.formula || value.hyperlink
        || value.richText)) return value;
    const result = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (result.length > 32_767) {
        throw new Error(
            "A Stage 1 workbook value exceeds Excel's cell limit. The stored analysis was not changed."
        );
    }
    return result;
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function title(value) {
    return String(value).replaceAll("_", " ")
        .replace(/\b\w/gu, character => character.toUpperCase());
}

function participantCode(caseNumber) {
    return String(caseNumber || "").split("-S")[0];
}

function sessionNumber(caseNumber) {
    const match = String(caseNumber || "").match(/-S(\d+)$/iu);
    return match ? Number.parseInt(match[1], 10) : 1;
}

function naturalCaseOrder(left, right) {
    return participantCode(left.caseNumber).localeCompare(
        participantCode(right.caseNumber), undefined, { numeric: true }
    ) || sessionNumber(left.caseNumber) - sessionNumber(right.caseNumber);
}

function descriptorValues(row) {
    if (!row) return {};
    const result = {};
    DESCRIPTOR_COLUMNS.filter(column => column !== "additional_descriptors")
        .forEach(column => {
            if (row[column] !== null && row[column] !== undefined
                && row[column] !== "") result[column] = row[column];
        });
    Object.entries(row.additional_descriptors || {}).forEach(([key, entry]) => {
        if (entry !== null && entry !== undefined && entry !== "") {
            result[key] = entry;
        }
    });
    return result;
}

function reportParticipantInformation(report) {
    const information = report?.participant_information;
    if (!information || typeof information !== "object"
        || Array.isArray(information)) return {};
    const result = {};
    PARTICIPANT_INFORMATION_COLUMNS.forEach(([field]) => {
        const entry = information[field];
        const entryValue = entry && typeof entry === "object"
            && !Array.isArray(entry) ? entry.value : entry;
        if (entryValue !== null && entryValue !== undefined
            && entryValue !== "") result[field] = entryValue;
    });
    const additional = information.additional_descriptors;
    if (Array.isArray(additional)) {
        additional.forEach(entry => {
            const field = typeof entry?.name === "string"
                ? entry.name.trim() : "";
            if (field && entry.value !== null && entry.value !== undefined
                && entry.value !== "") result[field] = entry.value;
        });
    } else if (additional && typeof additional === "object") {
        Object.entries(additional).forEach(([field, entry]) => {
            const entryValue = entry && typeof entry === "object"
                && !Array.isArray(entry) ? entry.value : entry;
            if (entryValue !== null && entryValue !== undefined
                && entryValue !== "") result[field] = entryValue;
        });
    }
    return result;
}

function workbookCase(
    analysisCase,
    attempt,
    reportRow,
    sourceSnapshot,
    storedMessages,
    descriptor
) {
    const inspection = buildCaseInspection({
        caseNumber: analysisCase.case_number,
        sourceSnapshot,
        storedMessages,
        presentation: reportRow.report_json,
        attempt,
        normalizedPilotReport: null,
        submittedReport: reportRow
    });
    const participantTurn = inspection.transcript.find(message =>
        message.speaker === "participant");
    return {
        caseNumber: analysisCase.case_number,
        stage1Status: analysisCase.stage1_status,
        language: participantTurn?.language
            || inspection.transcript[0]?.language || "",
        demographics: {
            ...descriptorValues(descriptor),
            ...reportParticipantInformation(reportRow.report_json)
        },
        inspection
    };
}

export async function loadCaseBoundStage1Workbook(supabase, selection = {}) {
    const suppliedCohortId = typeof selection.cohortId === "string"
        ? selection.cohortId.trim() : "";
    if (!suppliedCohortId) {
        throw Object.assign(new Error(
            "Choose the completed cohort for the single Stage 1 workbook."
        ), { status: 400 });
    }

    let cohort = null;
    let caseIds = [];
    const cohortId = requireUuid(suppliedCohortId, "Choose a valid cohort.");
    const cohorts = await requireRows(
        supabase.from("analysis_cohorts_v2")
            .select("id, project_id, name, status, closed_at")
            .eq("id", cohortId),
        "The Stage 1 workbook cohort could not be loaded."
    );
    cohort = cohorts[0] || null;
    if (!cohort) {
        throw Object.assign(new Error("The cohort does not exist."), {
            status: 404
        });
    }
    if (!cohort.closed_at) {
        throw Object.assign(new Error(
            "The single Stage 1 workbook is unavailable until the cohort is closed."
        ), { status: 409 });
    }
    const members = await requireRows(
        supabase.from("analysis_cohort_cases_v2")
            .select("case_id").eq("cohort_id", cohortId),
        "The Stage 1 workbook cohort membership could not be loaded."
    );
    caseIds = members.map(member => member.case_id);
    if (!caseIds.length) {
        throw Object.assign(new Error("The Stage 1 workbook has no cases."), {
            status: 409
        });
    }

    const relatedRows = (ids, queryFactory, message) => rowsForIds(
        ids, queryFactory, message
    );
    const analysisCases = await relatedRows(caseIds, chunk => supabase
        .from("analysis_cases_v2")
        .select("id, project_id, case_number, stage1_status")
        .in("id", chunk), "The Stage 1 workbook cases could not be loaded.");
    if (analysisCases.length !== unique(caseIds).length) {
        throw Object.assign(new Error("A Stage 1 workbook case is missing."), {
            status: 404
        });
    }
    if (analysisCases.some(item => item.stage1_status !== "completed")) {
        throw Object.assign(new Error(
            "The Stage 1 workbook is unavailable until every selected case has completed Stage 1."
        ), { status: 409 });
    }
    const projectIds = unique(analysisCases.map(item => item.project_id));
    if (projectIds.length !== 1) {
        throw Object.assign(new Error(
            "A Stage 1 workbook must belong to one research project."
        ), { status: 409 });
    }

    const [projects, snapshots, caseSessions, attempts] = await Promise.all([
        requireRows(supabase.from("research_projects")
            .select("id, project_code, project_name, research_topic")
            .eq("id", projectIds[0]),
        "The Stage 1 workbook project could not be loaded."),
        relatedRows(caseIds, chunk => supabase
            .from("stage1_source_snapshots_v2")
            .select("case_id, source_json, source_sha256, message_count")
            .in("case_id", chunk),
        "The frozen Stage 1 workbook sources could not be loaded."),
        relatedRows(caseIds, chunk => supabase
            .from("analysis_case_sessions_v2")
            .select("case_id, session_id, session_order")
            .in("case_id", chunk)
            .order("session_order", { ascending: true }),
        "The frozen Stage 1 workbook session lineage could not be loaded."),
        relatedRows(caseIds, chunk => supabase
            .from("stage1_attempts_v2")
            .select("id, case_id, attempt_number, status, provider_status")
            .eq("status", "completed").in("case_id", chunk)
            .order("attempt_number", { ascending: false }),
        "The completed Stage 1 workbook attempts could not be loaded.")
    ]);
    const reports = await relatedRows(attempts.map(item => item.id), chunk =>
        supabase.from("stage1_readable_reports_v2")
            .select("attempt_id, report_json, report_sha256, source_response_sha256, source_kind, provider, model, reasoning_effort, provider_status, created_at")
            .in("attempt_id", chunk),
    "The frozen Stage 1 workbook reports could not be loaded.");
    const reportByAttempt = new Map(reports.map(item => [item.attempt_id, item]));
    const attemptByCase = new Map();
    attempts.forEach(attempt => {
        if (reportByAttempt.has(attempt.id)
            && !attemptByCase.has(attempt.case_id)) {
            attemptByCase.set(attempt.case_id, attempt);
        }
    });
    const snapshotByCase = new Map(snapshots.map(item => [item.case_id, item]));
    const sessionsByCase = new Map();
    caseSessions.forEach(session => {
        const entries = sessionsByCase.get(session.case_id) || [];
        entries.push(session);
        sessionsByCase.set(session.case_id, entries);
    });
    const sessionIds = unique(caseSessions.map(item => item.session_id));
    const storedMessages = sessionIds.length
        ? await relatedRows(sessionIds, chunk => supabase
            .from("interview_messages")
            .select("id, Session, Speaker, Language, Message, EnglishTranslation, Timestamp")
            .in("Session", chunk)
            .order("Timestamp", { ascending: true }),
        "The stored Stage 1 workbook transcript could not be loaded.")
        : [];
    const messagesBySession = new Map();
    storedMessages.forEach(message => {
        const entries = messagesBySession.get(message.Session) || [];
        entries.push(message);
        messagesBySession.set(message.Session, entries);
    });
    const terminalSessionIds = unique(analysisCases.map(analysisCase => {
        const source = snapshotByCase.get(analysisCase.id);
        const sessions = sessionsByCase.get(analysisCase.id) || [];
        return source?.source_json?.terminalSessionId
            || sessions.at(-1)?.session_id;
    }));
    const descriptors = terminalSessionIds.length
        ? await relatedRows(terminalSessionIds, chunk => supabase
            .from("participant_descriptors")
            .select(`session_id, ${DESCRIPTOR_COLUMNS.join(", ")}`)
            .in("session_id", chunk),
        "The Stage 1 workbook participant information could not be loaded.")
        : [];
    const descriptorBySession = new Map(descriptors.map(item =>
        [item.session_id, item]));

    const cases = analysisCases.map(analysisCase => {
        const attempt = attemptByCase.get(analysisCase.id);
        const report = attempt ? reportByAttempt.get(attempt.id) : null;
        const source = snapshotByCase.get(analysisCase.id) || null;
        const sessions = sessionsByCase.get(analysisCase.id) || [];
        const messages = sessions.flatMap(session =>
            messagesBySession.get(session.session_id) || []);
        if (!attempt || !report || (!source && !messages.length)) {
            throw Object.assign(new Error(
                `${analysisCase.case_number} does not have a complete frozen Stage 1 workbook source.`
            ), { status: 409 });
        }
        return workbookCase(
            analysisCase,
            attempt,
            report,
            source,
            messages,
            descriptorBySession.get(source?.source_json?.terminalSessionId
                || sessions.at(-1)?.session_id)
        );
    }).sort(naturalCaseOrder);

    return {
        workbookVersion: CASE_BOUND_STAGE1_WORKBOOK_VERSION,
        project: projects[0] || { project_name: "Research project" },
        cohort,
        selection: { type: "cohort", id: suppliedCohortId },
        cases
    };
}

function excelColumnName(columnNumber) {
    let value = columnNumber;
    let name = "";
    while (value > 0) {
        value -= 1;
        name = String.fromCharCode(65 + (value % 26)) + name;
        value = Math.floor(value / 26);
    }
    return name;
}

function internalLink(displayValue, sheetName, cellAddress) {
    return {
        text: value(displayValue),
        hyperlink: `#'${sheetName}'!${cellAddress}`
    };
}

function configureSheet(sheet, headers, frozenColumns = 2) {
    sheet.columns = headers.map((header, index) => ({
        header,
        key: `column_${index + 1}`,
        width: index < frozenColumns ? 11 : 32
    }));
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length }
    };
    const header = sheet.getRow(1);
    header.height = 28;
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "FF173968" }
    };
    header.alignment = {
        horizontal: "center", vertical: "middle", wrapText: true
    };
    header.commit();
}

function appendRow(sheet, entries, decorate) {
    const row = sheet.addRow(entries.map(value));
    row.alignment = { vertical: "top", wrapText: true };
    if (decorate) decorate(row);
    row.commit();
}

function dynamicDemographicFields(cases) {
    const standard = PARTICIPANT_INFORMATION_COLUMNS.map(([field]) => field);
    const extra = unique(cases.flatMap(item =>
        Object.keys(item.demographics || {})))
        .filter(field => !standard.includes(field))
        .sort((left, right) => left.localeCompare(right));
    return [...standard, ...extra];
}

function demographicHeading(field) {
    return PARTICIPANT_INFORMATION_COLUMNS.find(([key]) => key === field)?.[1]
        || title(field);
}

function referenceKey(caseNumber, type, id = "") {
    return `${caseNumber}:${type}:${id}`;
}

function presentationSource(unit, model) {
    const sources = unit.englishTextSources || [];
    if (sources.includes("stored_source_message_translation")) {
        return "Stored English translation of the MU source message";
    }
    if (sources.includes("exact_gpt56_english_mu")) {
        return `Exact English MU returned by ${model || "the selected model"}`;
    }
    return "English source evidence unavailable";
}

function buildReferences(cases) {
    const rows = [];
    const destinations = new Map();
    function add(key, row) {
        const rowNumber = rows.length + 2;
        destinations.set(key, rowNumber);
        rows.push({ reference: `R${String(rows.length + 1).padStart(6, "0")}`, ...row });
    }
    cases.forEach(item => {
        const inspection = item.inspection;
        add(referenceKey(item.caseNumber, "report"), {
            caseNumber: item.caseNumber,
            type: "Stage 1 report",
            localId: "",
            englishText: "Complete MU to CO to CA to TH workbook report",
            mentions: inspection.counts.linkedMeaningUnitMentions,
            linkedIds: "",
            messageIds: "",
            inlineStatus: `${inspection.report.meaningUnits.filter(unit =>
                unit.segments.some(segment => Number.isInteger(segment.startOffset)))
                .length} of ${inspection.counts.meaningUnits} MUs located in the frozen transcript`,
            originalEvidence: "",
            source: [
                `Provider: ${inspection.provenance.provider || "—"}`,
                `Model: ${inspection.provenance.model || "—"}`,
                `Reasoning: ${inspection.provenance.reasoningEffort || "—"}`,
                `Provider status: ${inspection.provenance.providerStatus || "—"}`,
                `Report SHA-256: ${inspection.provenance.reportSha256 || "—"}`,
                `Response SHA-256: ${inspection.provenance.sourceResponseSha256 || "—"}`
            ].join("\n")
        });
        inspection.report.meaningUnits.forEach(unit => add(
            referenceKey(item.caseNumber, "mu", unit.id), {
                caseNumber: item.caseNumber,
                type: "Meaning Unit",
                localId: unit.id,
                englishText: unit.englishText,
                mentions: inspection.report.codes.filter(code =>
                    code.meaningUnitIds.includes(unit.id)).length,
                linkedIds: inspection.report.codes.filter(code =>
                    code.meaningUnitIds.includes(unit.id)).map(code => code.id).join(", "),
                messageIds: unique(unit.segments.map(segment =>
                    segment.messageId)).join(", "),
                inlineStatus: unit.segments.every(segment =>
                    Number.isInteger(segment.startOffset)
                    && Number.isInteger(segment.endOffset))
                    ? "Located inline" : "Not located verbatim",
                originalEvidence: unit.originalEvidenceText,
                source: presentationSource(unit, inspection.provenance.model)
            }
        ));
        inspection.report.codes.forEach(code => add(
            referenceKey(item.caseNumber, "co", code.id), {
                caseNumber: item.caseNumber,
                type: "Preliminary Code",
                localId: code.id,
                englishText: code.label,
                mentions: code.mentionCount,
                linkedIds: code.meaningUnitIds.join(", "),
                messageIds: "",
                inlineStatus: `${code.meaningUnitIds.filter(id => {
                    const unit = inspection.report.meaningUnits.find(candidate =>
                        candidate.id === id);
                    return unit?.segments.every(segment =>
                        Number.isInteger(segment.startOffset)
                        && Number.isInteger(segment.endOffset));
                }).length} of ${code.meaningUnitIds.length} linked MUs located inline`,
                originalEvidence: "",
                source: `Exact ${inspection.provenance.model || "selected-model"} Code label and stored mappings`
            }
        ));
        inspection.report.categories.forEach(category => add(
            referenceKey(item.caseNumber, "ca", category.id), {
                caseNumber: item.caseNumber,
                type: "Preliminary Category",
                localId: category.id,
                englishText: category.label,
                mentions: category.mentionCount,
                linkedIds: category.codeIds.join(", "),
                messageIds: "",
                inlineStatus: "See linked Codes and MUs",
                originalEvidence: "",
                source: `Exact ${inspection.provenance.model || "selected-model"} Category label and stored mappings`
            }
        ));
        inspection.report.themes.forEach(theme => add(
            referenceKey(item.caseNumber, "th", theme.id), {
                caseNumber: item.caseNumber,
                type: "Preliminary Tentative Theme",
                localId: theme.id,
                englishText: theme.statement,
                mentions: theme.mentionCount,
                linkedIds: theme.categoryIds.join(", "),
                messageIds: "",
                inlineStatus: "See linked Categories, Codes, and MUs",
                originalEvidence: "",
                source: `Exact ${inspection.provenance.model || "selected-model"} Theme statement and stored mappings`
            }
        ));
    });
    return { rows, destinations };
}

function addParticipantInformationSheet(workbook, data) {
    const demographics = dynamicDemographicFields(data.cases);
    const sheet = workbook.addWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[0], {
        views: [{ state: "frozen", xSplit: 3, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", "S#", "Language", ...demographics.map(demographicHeading)
    ], 3);
    data.cases.forEach(item => appendRow(sheet, [
        participantCode(item.caseNumber), sessionNumber(item.caseNumber),
        item.language,
        ...demographics.map(field => item.demographics[field] ?? "")
    ], row => {
        row.height = 30;
    }));
    sheet.commit();
}

function addMeaningUnitsSheet(workbook, data, references) {
    const maximum = Math.max(...data.cases.map(item =>
        item.inspection.report.meaningUnits.length));
    const sheet = workbook.addWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[1], {
        views: [{ state: "frozen", xSplit: 2, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", "S#", "Stage 1 report",
        ...Array.from({ length: maximum }, (_, index) => `MU${index + 1}`)
    ]);
    data.cases.forEach(item => {
        const report = item.inspection.report;
        appendRow(sheet, [
            participantCode(item.caseNumber), sessionNumber(item.caseNumber),
            internalLink("Complete", CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5],
                `A${references.destinations.get(referenceKey(item.caseNumber, "report"))}`),
            ...Array.from({ length: maximum }, (_, index) => {
                const unit = report.meaningUnits[index];
                if (!unit) return "";
                return internalLink(unit.englishText,
                    CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5],
                    `A${references.destinations.get(referenceKey(
                        item.caseNumber, "mu", unit.id
                    ))}`);
            })
        ], row => {
            row.height = 42;
            row.getCell(3).font = {
                color: { argb: "FF0563C1" }, underline: true
            };
            report.meaningUnits.forEach((unit, index) => {
                row.getCell(index + 4).font = {
                    color: { argb: "FF0563C1" }, underline: true
                };
            });
        });
    });
    sheet.commit();
}

function layerCell(item, mentionCount) {
    const label = item.label || item.statement || "";
    return `${label}\n${mentionCount} MU mention${mentionCount === 1 ? "" : "s"}`;
}

function addLayerSheet(workbook, data, references, {
    sheetName, field, type
}) {
    const maximum = Math.max(...data.cases.map(item =>
        item.inspection.report[field].length));
    const prefix = type.toUpperCase();
    const sheet = workbook.addWorksheet(sheetName, {
        views: [{ state: "frozen", xSplit: 2, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", "S#",
        ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)
    ]);
    data.cases.forEach(item => {
        const values = item.inspection.report[field];
        appendRow(sheet, [
            participantCode(item.caseNumber), sessionNumber(item.caseNumber),
            ...Array.from({ length: maximum }, (_, index) => {
                const entry = values[index];
                if (!entry) return "";
                return internalLink(layerCell(entry, entry.mentionCount),
                    CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5],
                    `A${references.destinations.get(referenceKey(
                        item.caseNumber, type, entry.id
                    ))}`);
            })
        ], row => {
            row.height = 42;
            values.forEach((entry, index) => {
                row.getCell(index + 3).font = {
                    color: { argb: "FF0563C1" }, underline: true
                };
            });
        });
    });
    sheet.commit();
}

function addReferencesSheet(workbook, references) {
    const sheet = workbook.addWorksheet(CASE_BOUND_STAGE1_WORKBOOK_SHEETS[5], {
        views: [{ state: "frozen", xSplit: 3, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "Reference", "P#", "Item type", "Local ID", "English report text",
        "MU mention count", "Linked IDs", "Source message IDs",
        "Transcript location", "Exact original evidence", "Source and provenance"
    ], 3);
    references.rows.forEach(reference => appendRow(sheet, [
        reference.reference,
        participantCode(reference.caseNumber),
        reference.type,
        reference.localId,
        reference.englishText,
        reference.mentions,
        reference.linkedIds,
        reference.messageIds,
        reference.inlineStatus,
        reference.originalEvidence,
        reference.source
    ], row => {
        row.height = Math.min(180, Math.max(30,
            Math.ceil(Math.max(
                String(reference.englishText || "").length,
                String(reference.originalEvidence || "").length,
                String(reference.source || "").length
            ) / 80) * 15));
    }));
    sheet.commit();
}

export async function writeCaseBoundStage1Workbook(
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
    workbook.title = "PLI Stage 1 Report";
    workbook.subject = "Frozen case-bound MU to CO to CA to TH report";
    workbook.description = [
        "The Excel workbook is the Stage 1 report.",
        "Participant Information and Meaning Units are separate worksheets.",
        "It is a deterministic presentation of the immutable stored report.",
        "No AI call, validator, reviewer, repairer, or retry is used to create it."
    ].join(" ");
    workbook.created = createdAt;
    workbook.modified = createdAt;
    const references = buildReferences(data.cases);
    addParticipantInformationSheet(workbook, data);
    addMeaningUnitsSheet(workbook, data, references);
    addLayerSheet(workbook, data, references, {
        sheetName: CASE_BOUND_STAGE1_WORKBOOK_SHEETS[2],
        field: "codes", type: "co"
    });
    addLayerSheet(workbook, data, references, {
        sheetName: CASE_BOUND_STAGE1_WORKBOOK_SHEETS[3],
        field: "categories", type: "ca"
    });
    addLayerSheet(workbook, data, references, {
        sheetName: CASE_BOUND_STAGE1_WORKBOOK_SHEETS[4],
        field: "themes", type: "th"
    });
    addReferencesSheet(workbook, references);
    await workbook.commit();
}

export function caseBoundStage1WorkbookFilename(data) {
    const scope = data.cohort?.name || "cohort";
    const slug = String(scope || "stage1").toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "stage1";
    return `${slug}-stage1-report-v3-six-sheets.xlsx`;
}
