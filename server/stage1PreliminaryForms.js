import ExcelJS from "exceljs";
import { allRows } from "./supabaseBatching.js";

const SHEET_NAMES = Object.freeze([
    "1 Participant Information",
    "2 Preliminary MUs",
    "3 Preliminary Codes",
    "4 Preliminary Categories",
    "5 Preliminary Themes"
]);

function requireUuid(value, message) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
        throw Object.assign(new Error(message), { status: 400 });
    }
    return id;
}

function requireData(result, message) {
    if (result.error) throw new Error(message, { cause: result.error });
    return result.data;
}

function naturalCaseOrder(left, right) {
    return String(left.participant_code || left.case_number).localeCompare(
        String(right.participant_code || right.case_number),
        undefined,
        { numeric: true }
    ) || Number(left.session_sequence || 0) - Number(right.session_sequence || 0)
      || String(left.case_number).localeCompare(String(right.case_number), undefined, {
          numeric: true
      });
}

function displayValue(value) {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (text.length > 32_767) {
        throw new Error(
            "A Stage 1 form value exceeds Excel's cell limit; the export stopped without changing the stored analysis."
        );
    }
    return text;
}

function titleForDemographicField(field) {
    return String(field)
        .replaceAll("_", " ")
        .replace(/\b\w/gu, letter => letter.toUpperCase());
}

function dynamicDemographicFields(cases) {
    const fields = new Set();
    cases.forEach(item => {
        Object.keys(item.demographics || {}).forEach(field => fields.add(field));
    });
    return [...fields].sort((left, right) => left.localeCompare(right));
}

function configureSheet(sheet, headers, frozenColumns = 1) {
    sheet.columns = headers.map((header, index) => ({
        header,
        key: `column_${index + 1}`,
        width: index < frozenColumns ? 14 : 30
    }));
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length }
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

function appendRow(sheet, values) {
    const row = sheet.addRow(values.map(displayValue));
    row.alignment = { vertical: "top", wrapText: true };
    row.commit();
}

function recordsByJob(records) {
    const grouped = new Map();
    (records || []).forEach(record => {
        const values = grouped.get(record.source_job_id) || [];
        values.push(record);
        grouped.set(record.source_job_id, values);
    });
    grouped.forEach(values => values.sort((left, right) =>
        Number(left.position) - Number(right.position)));
    return grouped;
}

function addParticipantSheet(workbook, data) {
    const fields = dynamicDemographicFields(data.cases);
    const sheet = workbook.addWorksheet(SHEET_NAMES[0], {
        views: [{ state: "frozen", xSplit: 3, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", "S#", "Language",
        ...fields.map(titleForDemographicField)
    ], 3);
    data.cases.forEach(item => appendRow(sheet, [
        item.participant_code,
        item.session_sequence,
        item.language,
        ...fields.map(field => item.demographics?.[field])
    ]));
    sheet.commit();
}

function addPositionalSheet(workbook, name, prefix, data, records, field) {
    const grouped = recordsByJob(records);
    const maximum = data.cases.reduce((result, item) => Math.max(
        result,
        grouped.get(item.source_job_id)?.length || 0
    ), 0);
    const sheet = workbook.addWorksheet(name, {
        views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#",
        ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)
    ]);
    data.cases.forEach(item => {
        const values = grouped.get(item.source_job_id) || [];
        appendRow(sheet, [
            item.participant_code,
            ...Array.from({ length: maximum }, (_, index) => values[index]?.[field])
        ]);
    });
    sheet.commit();
}

async function requiredProject(supabase, projectId) {
    const result = await supabase
        .from("research_projects")
        .select("id, project_code, project_name, research_topic")
        .eq("id", projectId)
        .single();
    return requireData(result, "The Stage 1 forms project could not be loaded.");
}

function materializedRows(supabase, table, columns, materializationId, message) {
    return allRows(
        () => supabase.from(table)
            .select(columns)
            .eq("materialization_run_id", materializationId)
            .order("case_number", { ascending: true })
            .order("position", { ascending: true }),
        message
    );
}

export async function loadStage1PreliminaryForms(supabase, sourceRunIdValue) {
    const sourceRunId = requireUuid(
        sourceRunIdValue,
        "Choose a valid completed Stage 1 run."
    );
    const materialization = requireData(
        await supabase.rpc("materialize_stage1_preliminary_forms", {
            p_source_run_id: sourceRunId
        }),
        "The Stage 1 forms could not be materialized."
    );
    if (!materialization?.materialization_run_id || !materialization?.project_id) {
        throw new Error("The Stage 1 forms materialization returned no project lineage.");
    }
    const materializationId = materialization.materialization_run_id;
    const [project, cases, meaningUnits, codes, categories, themes, exceptions] =
        await Promise.all([
            requiredProject(supabase, materialization.project_id),
            allRows(
                () => supabase.from("stage1_preliminary_case_forms")
                    .select("source_job_id, source_report_id, session_id, participant_id, participant_code, case_number, session_sequence, language, demographics")
                    .eq("materialization_run_id", materializationId)
                    .order("case_number", { ascending: true }),
                "The participant and demographic form could not be loaded."
            ),
            materializedRows(
                supabase,
                "stage1_preliminary_meaning_units",
                "source_job_id, case_number, position, english_text, english_text_source",
                materializationId,
                "The preliminary Meaning Unit form could not be loaded."
            ),
            materializedRows(
                supabase,
                "stage1_preliminary_codes",
                "source_job_id, case_number, position, code_label",
                materializationId,
                "The preliminary Code form could not be loaded."
            ),
            materializedRows(
                supabase,
                "stage1_preliminary_categories",
                "source_job_id, case_number, position, category_label",
                materializationId,
                "The preliminary Category form could not be loaded."
            ),
            materializedRows(
                supabase,
                "stage1_preliminary_implied_themes",
                "source_job_id, case_number, position, theme_label",
                materializationId,
                "The preliminary implied-theme form could not be loaded."
            ),
            allRows(
                () => supabase.from("stage1_preliminary_materialization_exceptions")
                    .select("source_job_id, participant_code, case_number, raw_format, reason, materialized_components, raw_response_preserved_in")
                    .eq("materialization_run_id", materializationId)
                    .order("case_number", { ascending: true }),
                "The Stage 1 materialization exceptions could not be loaded."
            )
        ]);
    cases.sort(naturalCaseOrder);
    const uniqueJobs = new Set(cases.map(item => item.source_job_id));
    if (cases.length !== materialization.source_case_count
        || uniqueJobs.size !== materialization.source_case_count) {
        throw new Error(
            `Stage 1 forms stopped: expected ${materialization.source_case_count} cases but loaded ${uniqueJobs.size}.`
        );
    }
    if (meaningUnits.some(unit => !String(unit.english_text || "").trim()
        || unit.english_text_source === "stage1_text_without_separate_translation")) {
        throw new Error(
            "Stage 1 forms stopped because at least one Meaning Unit has no deterministic English display value."
        );
    }
    return {
        materialization,
        project,
        cases,
        meaningUnits,
        codes,
        categories,
        themes,
        exceptions,
        demographicFields: dynamicDemographicFields(cases)
    };
}

export async function writeStage1PreliminaryFormsWorkbook(
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
    addParticipantSheet(workbook, data);
    addPositionalSheet(
        workbook, SHEET_NAMES[1], "MU", data, data.meaningUnits, "english_text"
    );
    addPositionalSheet(
        workbook, SHEET_NAMES[2], "CO", data, data.codes, "code_label"
    );
    addPositionalSheet(
        workbook, SHEET_NAMES[3], "CA", data, data.categories, "category_label"
    );
    addPositionalSheet(
        workbook, SHEET_NAMES[4], "TH", data, data.themes, "theme_label"
    );
    await workbook.commit();
}

export function stage1PreliminaryFormsFilename(data) {
    const name = data.project?.project_code || data.project?.project_name || "project";
    const slug = String(name).toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "project";
    return `${slug}-stage1-preliminary-analysis-forms.xlsx`;
}

export { SHEET_NAMES };
