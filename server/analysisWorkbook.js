import ExcelJS from "exceljs";

export const ANALYSIS_WORKBOOK_VERSION = "pli-analysis-roundtrip-v1";
export const ANALYSIS_WORKBOOK_STAGES = new Set([
    "themes",
    "codes",
    "keywords"
]);

const STAGE_LABELS = Object.freeze({
    themes: "Worksheet 1 - Participants & Themes",
    codes: "Worksheet 2 - Codes & Themes",
    keywords: "Worksheet 3 - Keywords & Codes"
});

const DETAIL_SHEETS = Object.freeze({
    themes: "Theme grouping",
    codes: "Code grouping",
    keywords: "Keyword grouping"
});

const REQUIRED_DETAIL_HEADERS = Object.freeze({
    themes: [
        "Stable theme ID",
        "Participant code",
        "Theme position",
        "Theme content",
        "Researcher group",
        "Group order",
        "Item order",
        "Researcher note"
    ],
    codes: [
        "Stable code ID",
        "Participant code",
        "Theme position",
        "Theme content",
        "Code position",
        "Code content",
        "Researcher theme group",
        "Theme group order",
        "Researcher code group",
        "Code group order",
        "Item order",
        "Researcher note"
    ],
    keywords: [
        "Stable keyword ID",
        "Participant code",
        "Theme position",
        "Code position",
        "Code content",
        "Keyword position",
        "Keyword content",
        "Researcher code group",
        "Code group order",
        "Researcher keyword group",
        "Keyword group order",
        "Item order",
        "Researcher note"
    ]
});

function cleanText(value, maximumLength = 4000) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim().slice(0, maximumLength);
}

function cleanCell(value) {
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return cleanText(value);
}

function cleanMatrix(rows, columnCount, maximumRows = 25000) {
    if (!Array.isArray(rows)) {
        return [];
    }
    return rows.slice(0, maximumRows).map(row =>
        Array.from({ length: columnCount }, (_, index) =>
            cleanCell(Array.isArray(row) ? row[index] : "")
        )
    );
}

function uniqueSheetName(value, fallback) {
    const cleaned = cleanText(value || fallback, 31)
        .replace(/[\\/*?:[\]]/g, "-");
    return cleaned || fallback;
}

function styleWorksheet(worksheet, headers, editableHeaders = []) {
    worksheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
    worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, worksheet.rowCount), column: headers.length }
    };
    worksheet.properties.defaultRowHeight = 18;
    worksheet.getRow(1).height = 34;
    worksheet.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF173968" }
        };
        cell.alignment = { vertical: "middle", wrapText: true };
    });
    worksheet.columns.forEach((column, index) => {
        const header = headers[index] || "";
        const isContent = /content|note|^T\d|C\d|K\d/i.test(header);
        column.width = isContent ? 34 : Math.min(24, Math.max(14, header.length + 3));
        column.alignment = { vertical: "top", wrapText: isContent };
        if (editableHeaders.includes(header)) {
            column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                if (rowNumber > 1) {
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFFFF4D6" }
                    };
                }
            });
        }
    });
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            row.alignment = { vertical: "top", wrapText: false };
        }
    });
}

function addInstructionSheet(workbook, stage, detailSheetName) {
    const sheet = workbook.addWorksheet("Read me", {
        views: [{ state: "frozen", ySplit: 1 }]
    });
    const nextStage = stage === "themes"
        ? "Worksheet 2 - Codes & Themes"
        : stage === "codes"
            ? "Worksheet 3 - Keywords & Codes"
            : "the next researcher review";
    const rows = [
        ["PLI researcher Excel round-trip"],
        ["Stage", STAGE_LABELS[stage]],
        ["What to edit", `Use the yellow columns in '${detailSheetName}' to add group names, group order, item order, and notes.`],
        ["Stable IDs", "Do not change stable IDs or participant codes. They reconnect your decisions to the correct participant-specific theme, code, or keyword."],
        ["Rearranging", "You may sort or move rows. Physical row order is also recorded when the workbook is uploaded."],
        ["Upload result", `Uploading this workbook creates a new researcher decision layer used in ${nextStage}. It does not overwrite the original AI analysis.`],
        ["Main form", "The first worksheet matches the dashboard form. The grouping worksheet is a long-form editing view designed for Excel filtering, counting, sorting, and grouping."],
        ["Theme wording", "A theme must be the broadest one- or two-word concept, preferably one word, such as 'Work'. Put differences such as 'Overtime', 'Long hours', or 'Weekend work' under concise codes and the full interpretation in the rationale or case report."],
        ["Privacy", "Only participant codes are exported. Source participant IDs and transcript text are not included."]
    ];
    sheet.addRows(rows);
    sheet.getColumn(1).width = 24;
    sheet.getColumn(2).width = 92;
    sheet.getRow(1).height = 30;
    sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF173968" }
    };
    sheet.mergeCells("A1:B1");
    sheet.eachRow(row => {
        row.alignment = { vertical: "top", wrapText: true };
    });
}

function addMetadataSheet(workbook, metadata) {
    const sheet = workbook.addWorksheet("PLI Metadata");
    Object.entries(metadata).forEach(([key, value]) => {
        sheet.addRow([
            key,
            typeof value === "object" ? JSON.stringify(value) : String(value ?? "")
        ]);
    });
    sheet.state = "veryHidden";
}

export async function createAnalysisWorkbook(snapshot, exportedAt = new Date()) {
    const stage = cleanText(snapshot?.stage);
    if (!ANALYSIS_WORKBOOK_STAGES.has(stage)) {
        throw new Error("A valid workbook stage is required.");
    }
    const runId = cleanText(snapshot?.runId);
    if (!runId) {
        throw new Error("An analysis run is required before downloading a workbook.");
    }
    const mainHeaders = (Array.isArray(snapshot?.mainHeaders)
        ? snapshot.mainHeaders
        : []).map(value => cleanText(value, 120)).slice(0, 40);
    const detailHeaders = REQUIRED_DETAIL_HEADERS[stage];
    const submittedDetailHeaders = (Array.isArray(snapshot?.detailHeaders)
        ? snapshot.detailHeaders
        : []).map(value => cleanText(value, 120));
    if (!mainHeaders.length || detailHeaders.some((header, index) =>
        submittedDetailHeaders[index] !== header
    )) {
        throw new Error("The workbook columns do not match this analysis stage.");
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PLI Researcher Dashboard";
    workbook.created = exportedAt;
    workbook.modified = exportedAt;
    workbook.calcProperties.fullCalcOnLoad = true;

    const mainSheetName = uniqueSheetName(STAGE_LABELS[stage], "Analysis");
    const main = workbook.addWorksheet(mainSheetName);
    main.addRow(mainHeaders);
    main.addRows(cleanMatrix(snapshot.mainRows, mainHeaders.length));
    styleWorksheet(main, mainHeaders);

    const detailSheetName = DETAIL_SHEETS[stage];
    const detail = workbook.addWorksheet(detailSheetName);
    detail.addRow(detailHeaders);
    detail.addRows(cleanMatrix(snapshot.detailRows, detailHeaders.length));
    styleWorksheet(
        detail,
        detailHeaders,
        detailHeaders.filter(header =>
            header.startsWith("Researcher")
            || header === "Group order"
            || header === "Item order"
            || header.endsWith("group order")
        )
    );

    addInstructionSheet(workbook, stage, detailSheetName);
    addMetadataSheet(workbook, {
        workbook_format_version: ANALYSIS_WORKBOOK_VERSION,
        analysis_run_id: runId,
        stage,
        detail_sheet: detailSheetName,
        exported_at: exportedAt.toISOString(),
        source_selection: snapshot.selection || {}
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(cell) {
    if (cell?.value === null || cell?.value === undefined) {
        return "";
    }
    if (cell.value instanceof Date) {
        return cell.value.toISOString();
    }
    if (typeof cell.value === "object") {
        if (typeof cell.value.text === "string") {
            return cleanText(cell.value.text);
        }
        if (Array.isArray(cell.value.richText)) {
            return cleanText(cell.value.richText.map(part => part.text).join(""));
        }
        if (cell.value.result !== undefined) {
            return cleanText(cell.value.result);
        }
    }
    return cleanText(cell.value);
}

function positiveOrder(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function metadataValues(workbook) {
    const sheet = workbook.getWorksheet("PLI Metadata");
    if (!sheet) {
        throw new Error("This is not a PLI analysis workbook: metadata is missing.");
    }
    const values = {};
    sheet.eachRow(row => {
        const key = cellText(row.getCell(1));
        if (key) {
            values[key] = cellText(row.getCell(2));
        }
    });
    return values;
}

function groupingItem(stage, record, physicalOrder) {
    const shared = {
        stableId: record[stage === "themes"
            ? "Stable theme ID"
            : stage === "codes"
                ? "Stable code ID"
                : "Stable keyword ID"],
        participantCode: record["Participant code"],
        themePosition: record["Theme position"] || null,
        codePosition: record["Code position"] || null,
        keywordPosition: record["Keyword position"] || null,
        itemOrder: positiveOrder(record["Item order"], physicalOrder),
        note: record["Researcher note"] || null
    };
    if (stage === "themes") {
        return {
            ...shared,
            content: record["Theme content"],
            group: record["Researcher group"] || null,
            groupOrder: positiveOrder(record["Group order"], null)
        };
    }
    if (stage === "codes") {
        return {
            ...shared,
            themeContent: record["Theme content"],
            content: record["Code content"],
            previousGroup: record["Researcher theme group"] || null,
            previousGroupOrder: positiveOrder(record["Theme group order"], null),
            group: record["Researcher code group"] || null,
            groupOrder: positiveOrder(record["Code group order"], null)
        };
    }
    return {
        ...shared,
        codeContent: record["Code content"],
        content: record["Keyword content"],
        previousGroup: record["Researcher code group"] || null,
        previousGroupOrder: positiveOrder(record["Code group order"], null),
        group: record["Researcher keyword group"] || null,
        groupOrder: positiveOrder(record["Keyword group order"], null)
    };
}

export async function parseAnalysisWorkbook(buffer, expectedStage = null) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const metadata = metadataValues(workbook);
    const stage = metadata.stage;
    if (metadata.workbook_format_version !== ANALYSIS_WORKBOOK_VERSION) {
        throw new Error("This workbook version is not supported.");
    }
    if (!ANALYSIS_WORKBOOK_STAGES.has(stage) || (
        expectedStage && stage !== expectedStage
    )) {
        throw new Error("The workbook was uploaded to the wrong analysis stage.");
    }
    const detailSheetName = DETAIL_SHEETS[stage];
    const sheet = workbook.getWorksheet(detailSheetName);
    if (!sheet) {
        throw new Error(`The required '${detailSheetName}' sheet is missing.`);
    }
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, cell => {
        headers.push(cellText(cell));
    });
    const expectedHeaders = REQUIRED_DETAIL_HEADERS[stage];
    if (expectedHeaders.some((header, index) => headers[index] !== header)) {
        throw new Error("The grouping worksheet headers were changed. Restore the original headers and upload again.");
    }
    const items = [];
    const snapshotRows = [];
    const participantOrder = [];
    const seenParticipants = new Set();
    const seenStableIds = new Set();
    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const values = expectedHeaders.map((_, index) =>
            cellText(row.getCell(index + 1))
        );
        if (!values[0]) {
            continue;
        }
        const record = Object.fromEntries(expectedHeaders.map((header, index) => [
            header,
            values[index]
        ]));
        if (!/^P\d{4,}$/.test(record["Participant code"])) {
            throw new Error(`Row ${rowNumber} has an invalid participant code.`);
        }
        const item = groupingItem(stage, record, items.length + 1);
        if (!item.stableId || !item.content) {
            throw new Error(`Row ${rowNumber} is missing its stable ID or analytical content.`);
        }
        const expectedStableId = stage === "themes"
            ? `${item.participantCode}-${item.themePosition}`
            : stage === "codes"
                ? `${item.participantCode}-${item.codePosition}`
                : `${item.participantCode}-${item.keywordPosition}`;
        if (item.stableId !== expectedStableId) {
            throw new Error(
                `Row ${rowNumber} has a stable ID that does not match its participant and position.`
            );
        }
        if (seenStableIds.has(item.stableId)) {
            throw new Error(`Row ${rowNumber} repeats stable ID ${item.stableId}.`);
        }
        seenStableIds.add(item.stableId);
        items.push(item);
        snapshotRows.push(values);
        if (!seenParticipants.has(item.participantCode)) {
            seenParticipants.add(item.participantCode);
            participantOrder.push(item.participantCode);
        }
    }
    if (!items.length) {
        throw new Error("The grouping worksheet does not contain any analytical rows.");
    }
    let sourceSelection = {};
    try {
        sourceSelection = JSON.parse(metadata.source_selection || "{}");
    } catch {
        sourceSelection = {};
    }
    return {
        runId: metadata.analysis_run_id,
        stage,
        version: metadata.workbook_format_version,
        exportedAt: metadata.exported_at || null,
        sourceSelection,
        rowOrder: participantOrder,
        groupingData: { stage, items },
        workbookSnapshot: {
            detailSheet: detailSheetName,
            headers: expectedHeaders,
            rows: snapshotRows
        }
    };
}

export function workbookFilename(stage, exportedAt = new Date()) {
    const date = exportedAt.toISOString().slice(0, 10);
    return `PLI-${stage}-${date}.xlsx`;
}
