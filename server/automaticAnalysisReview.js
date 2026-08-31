import ExcelJS from "exceljs";
import { QUALITATIVE_ANALYSIS_MODEL } from "./analysisCore.js";

export const AUTOMATIC_REVIEW_WORKBOOK_VERSION =
    "automatic-review-workbook-v1";
export const MAX_AUTOMATIC_REVIEW_WORKBOOK_BYTES = 3_000_000;
export const MAX_AUTOMATIC_REVIEW_SELECTIONS = 8;

const MAX_WORKBOOK_SHEETS = 20;
const MAX_WORKBOOK_ROWS_PER_SHEET = 10_000;
const MAX_WORKBOOK_COLUMNS = 200;
const MAX_WORKBOOK_TEXT_CHARACTERS = 8_000_000;
const PARTICIPANT_HEADERS = new Set([
    "p#",
    "participant",
    "participant code",
    "participant id",
    "case",
    "case number"
]);
const SESSION_HEADERS = new Set([
    "s#",
    "session",
    "session number",
    "session id"
]);

const reviewDiscussionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        reply: { type: "string" },
        source_assessments: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    source_case_number: { type: "string" },
                    source_position: { type: "string" },
                    decision: {
                        type: "string",
                        enum: [
                            "confirmed_rare",
                            "regroup",
                            "reabstract",
                            "check_transcript"
                        ]
                    },
                    explanation: { type: "string" }
                },
                required: [
                    "source_case_number",
                    "source_position",
                    "decision",
                    "explanation"
                ]
            }
        },
        proposed_groupings: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    source_case_number: { type: "string" },
                    source_position: { type: "string" },
                    source_label: { type: "string" },
                    proposed_group: { type: "string" },
                    rationale: { type: "string" }
                },
                required: [
                    "source_case_number",
                    "source_position",
                    "source_label",
                    "proposed_group",
                    "rationale"
                ]
            }
        },
        uncertainty: { type: "string" }
    },
    required: [
        "reply",
        "source_assessments",
        "proposed_groupings",
        "uncertainty"
    ]
};

function compactText(value, maximumLength = 4_000) {
    const text = String(value ?? "").replace(/\u0000/g, "").trim();
    return text.length <= maximumLength
        ? text
        : `${text.slice(0, maximumLength - 1).trimEnd()}…`;
}

function cellText(cell) {
    if (cell?.value === null || cell?.value === undefined) return "";
    if (cell.value instanceof Date) return cell.value.toISOString();
    return compactText(cell.text || cell.value, 12_000);
}

function normalizedHeader(value) {
    return compactText(value, 200).toLowerCase().replace(/\s+/g, " ");
}

function headerIndex(headers, candidates) {
    return headers.findIndex(header => candidates.has(
        normalizedHeader(header)
    ));
}

function safeParticipantCode(value) {
    const code = compactText(value, 100).toUpperCase();
    return /^P\d+(?:-S\d+)?$/.test(code) ? code : null;
}

function columnName(index) {
    let value = index;
    let name = "";
    while (value > 0) {
        value -= 1;
        name = String.fromCharCode(65 + (value % 26)) + name;
        value = Math.floor(value / 26);
    }
    return name;
}

function sheetRows(worksheet) {
    const rows = [];
    let maximumColumn = 0;
    worksheet.eachRow({ includeEmpty: false }, row => {
        if (row.number > MAX_WORKBOOK_ROWS_PER_SHEET) {
            throw new Error(
                `Worksheet “${worksheet.name}” has more than ${MAX_WORKBOOK_ROWS_PER_SHEET.toLocaleString()} rows.`
            );
        }
        const values = [];
        row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
            if (columnNumber > MAX_WORKBOOK_COLUMNS) {
                throw new Error(
                    `Worksheet “${worksheet.name}” has more than ${MAX_WORKBOOK_COLUMNS} columns.`
                );
            }
            values[columnNumber - 1] = cellText(cell);
            if (values[columnNumber - 1]) {
                maximumColumn = Math.max(maximumColumn, columnNumber);
            }
        });
        if (values.some(Boolean)) {
            rows.push({
                rowNumber: row.number,
                hidden: row.hidden === true,
                values
            });
        }
    });
    rows.forEach(row => {
        row.values = row.values.slice(0, maximumColumn);
    });
    return { rows, maximumColumn };
}

function headerRowFor(rows) {
    return rows.slice(0, 10).find(row =>
        headerIndex(row.values, PARTICIPANT_HEADERS) >= 0
    ) || rows[0] || null;
}

function uniqueHeaders(values) {
    const counts = new Map();
    return values.map((value, index) => {
        const base = compactText(value, 200) || `Column ${columnName(index + 1)}`;
        const count = (counts.get(base) || 0) + 1;
        counts.set(base, count);
        return count === 1 ? base : `${base} (${count})`;
    });
}

function caseIndexForSheet(sheet, index) {
    const headerRow = headerRowFor(sheet.rows);
    if (!headerRow) return;
    const headers = uniqueHeaders(headerRow.values);
    const participantColumn = headerIndex(headers, PARTICIPANT_HEADERS);
    const sessionColumn = headerIndex(headers, SESSION_HEADERS);
    if (participantColumn < 0) return;

    sheet.rows.filter(row => row.rowNumber > headerRow.rowNumber)
        .forEach(row => {
            const participantCode = safeParticipantCode(
                row.values[participantColumn]
            );
            if (!participantCode) return;
            const rowValues = Object.fromEntries(headers.map((header, offset) => [
                header,
                compactText(row.values[offset], 4_000)
            ]).filter(([, value]) => value !== ""));
            const records = index[participantCode] || [];
            records.push({
                sheetName: sheet.name,
                rowNumber: row.rowNumber,
                rowHidden: row.hidden,
                session: sessionColumn >= 0
                    ? compactText(row.values[sessionColumn], 100)
                    : "",
                values: rowValues
            });
            index[participantCode] = records;
        });
}

export async function parseAutomaticReviewWorkbook(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error("Choose an Excel workbook to upload.");
    }
    if (buffer.length > MAX_AUTOMATIC_REVIEW_WORKBOOK_BYTES) {
        throw new Error("The workbook must be smaller than 3 MB.");
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    if (!workbook.worksheets.length) {
        throw new Error("The workbook does not contain any worksheets.");
    }
    if (workbook.worksheets.length > MAX_WORKBOOK_SHEETS) {
        throw new Error(
            `The workbook must contain ${MAX_WORKBOOK_SHEETS} or fewer worksheets.`
        );
    }

    const sheets = workbook.worksheets.map(worksheet => {
        const { rows, maximumColumn } = sheetRows(worksheet);
        const headerRow = headerRowFor(rows);
        const hiddenColumns = Array.from(
            { length: maximumColumn },
            (_, index) => index + 1
        ).filter(index => worksheet.getColumn(index).hidden === true);
        return {
            name: compactText(worksheet.name, 200),
            state: worksheet.state || "visible",
            headerRowNumber: headerRow?.rowNumber || null,
            rowCount: rows.length,
            columnCount: maximumColumn,
            hiddenColumns: hiddenColumns.map(index => ({
                index,
                column: columnName(index),
                header: compactText(headerRow?.values[index - 1], 200)
            })),
            hiddenRowCount: rows.filter(row => row.hidden).length,
            rows
        };
    });
    const caseIndex = {};
    sheets.forEach(sheet => caseIndexForSheet(sheet, caseIndex));
    if (!Object.keys(caseIndex).length) {
        throw new Error(
            "The workbook needs a participant or case-number column such as P# or Participant code."
        );
    }
    const snapshot = {
        version: AUTOMATIC_REVIEW_WORKBOOK_VERSION,
        worksheets: sheets
    };
    if (JSON.stringify(snapshot).length > MAX_WORKBOOK_TEXT_CHARACTERS) {
        throw new Error(
            "The workbook contains too much text for an online review layer."
        );
    }

    return {
        version: AUTOMATIC_REVIEW_WORKBOOK_VERSION,
        sheetManifest: sheets.map(sheet => ({
            name: sheet.name,
            state: sheet.state,
            headerRowNumber: sheet.headerRowNumber,
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
            hiddenColumns: sheet.hiddenColumns,
            hiddenRowCount: sheet.hiddenRowCount
        })),
        caseIndex,
        workbookSnapshot: snapshot
    };
}

export function normalizeAutomaticReviewSelection(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
        .slice(0, MAX_AUTOMATIC_REVIEW_SELECTIONS * 2)
        .map(source => {
            const kind = ["case", "theme", "code"].includes(source?.kind)
                ? source.kind
                : null;
            const sessionId = compactText(source?.sessionId, 160);
            const caseNumber = compactText(source?.caseNumber, 100);
            const participantCode = safeParticipantCode(
                source?.participantCode
            );
            const position = compactText(source?.position, 20).toUpperCase();
            const recordId = compactText(source?.recordId, 160);
            if (!kind || !sessionId || !caseNumber || !participantCode) {
                return null;
            }
            if (kind !== "case" && !/^[TC]\d+$/.test(position)) {
                return null;
            }
            const key = `${sessionId}:${kind}:${position || "case"}`;
            if (seen.has(key)) return null;
            seen.add(key);
            return {
                kind,
                sessionId,
                caseNumber,
                participantCode,
                position: kind === "case" ? "CASE" : position,
                recordId: recordId || null,
                label: compactText(source?.label, 240)
            };
        })
        .filter(Boolean)
        .slice(0, MAX_AUTOMATIC_REVIEW_SELECTIONS);
}

export function automaticReviewThreadTitle(selection) {
    const first = selection[0];
    if (!first) return "Workbook review discussion";
    const focus = first.position === "CASE"
        ? first.caseNumber
        : `${first.caseNumber} ${first.position}`;
    return compactText(
        `${focus}${first.label ? ` · ${first.label}` : ""}`,
        180
    );
}

function workbookRowsForSelection(workbookImport, selection) {
    if (!workbookImport?.case_index) return [];
    const codes = new Set(selection.map(source => source.participantCode));
    return [...codes].flatMap(code =>
        (workbookImport.case_index[code] || []).map(row => ({
            participantCode: code,
            ...row
        }))
    ).slice(0, 80);
}

function compactConversation(messages) {
    return (messages || []).slice(-12).map(message => ({
        role: message.role === "assistant" ? "assistant" : "researcher",
        content: compactText(message.content, 5_000)
    })).filter(message => message.content);
}

function parsedStructuredResponse(response) {
    const text = response?.output_text
        || response?.output?.flatMap(item => item?.content || [])
            .find(item => typeof item?.text === "string")?.text;
    if (!text) throw new Error("AI second-layer analysis was empty.");
    try {
        return JSON.parse(text);
    } catch {
        throw new Error("AI second-layer analysis was not valid structured output.");
    }
}

export async function discussAutomaticCaseAnalysisReview(
    openaiClient,
    {
        selection,
        selectedCases,
        comparableThemeIndex,
        workbookImport,
        conversation
    },
    { model = QUALITATIVE_ANALYSIS_MODEL } = {}
) {
    const workbookRows = workbookRowsForSelection(
        workbookImport,
        selection
    );
    const response = await openaiClient.responses.create({
        model,
        store: false,
        text: {
            format: {
                type: "json_schema",
                name: "automatic_case_analysis_review_discussion",
                strict: true,
                schema: reviewDiscussionSchema
            }
        },
        input: [
            {
                role: "system",
                content: "You are the AI analytical collaborator inside a qualitative research dashboard. The researcher is conducting a second-layer review of already completed individual case reports. Discuss only the supplied source analyses, codes, keyword evidence, transcripts, participant/case identifiers, and uploaded researcher workbook rows. Original automatic case reports are immutable source records. Any grouping or re-abstraction is a new researcher-review layer and must preserve the source case number plus its local Tn or Cn position. T1 is local to each case and is not a global theme identity. A T1 mention count is within-case evidence support, not cross-case prevalence. Low frequency is a review flag, not proof of an error. When comparing cases, name the exact case number and Tn/Cn position. Distinguish four possible assessments: confirmed rare, regroup, reabstract, and check transcript. Do not invent cases, positions, evidence, frequencies, quotations, or workbook decisions. Treat workbook rows as researcher-authored decisions, not transcript evidence. If evidence is insufficient, say so plainly."
            },
            {
                role: "user",
                content: [
                    "Current selected dashboard sources (JSON):",
                    JSON.stringify(selection),
                    "Authoritative selected case reports and transcript evidence (JSON):",
                    JSON.stringify(selectedCases),
                    "Compact index of comparable participant-specific themes (JSON):",
                    JSON.stringify(comparableThemeIndex),
                    "Latest uploaded researcher workbook metadata and rows for the selected participants (JSON):",
                    JSON.stringify({
                        id: workbookImport?.id || null,
                        sourceFilename: workbookImport?.source_filename || null,
                        importedAt: workbookImport?.imported_at || null,
                        sheetManifest: workbookImport?.sheet_manifest || [],
                        selectedParticipantRows: workbookRows
                    }),
                    "Persistent researcher-AI discussion so far (JSON):",
                    JSON.stringify(compactConversation(conversation))
                ].join("\n")
            }
        ]
    });
    const value = parsedStructuredResponse(response);
    const knownSources = new Map(comparableThemeIndex.map(source => [
        `${source.caseNumber}:${source.position}`,
        source
    ]));
    const sourceAssessments = (Array.isArray(value?.source_assessments)
        ? value.source_assessments
        : []).filter(assessment => knownSources.has(
        `${assessment?.source_case_number}:${String(assessment?.source_position || "").toUpperCase()}`
    )).map(assessment => ({
        caseNumber: assessment.source_case_number,
        position: String(assessment.source_position).toUpperCase(),
        decision: assessment.decision,
        explanation: compactText(assessment.explanation, 1_500)
    }));
    const proposedGroupings = (Array.isArray(value?.proposed_groupings)
        ? value.proposed_groupings
        : []).filter(grouping => knownSources.has(
        `${grouping?.source_case_number}:${String(grouping?.source_position || "").toUpperCase()}`
    )).map(grouping => ({
        caseNumber: grouping.source_case_number,
        position: String(grouping.source_position).toUpperCase(),
        sourceLabel: compactText(grouping.source_label, 240),
        proposedGroup: compactText(grouping.proposed_group, 240),
        rationale: compactText(grouping.rationale, 1_500)
    }));
    const reply = compactText(value?.reply, 12_000);
    if (!reply) throw new Error("AI second-layer analysis was empty.");

    return {
        reply,
        sourceAssessments,
        proposedGroupings,
        uncertainty: compactText(value?.uncertainty, 2_000),
        model
    };
}

export function workbookSelectionRows(workbookImport, selection) {
    return workbookRowsForSelection(workbookImport, selection);
}
