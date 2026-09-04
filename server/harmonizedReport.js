import ExcelJS from "exceljs";
import { allRows } from "./supabaseBatching.js";

export const HARMONIZED_SHEET_NAMES = Object.freeze([
    "1 Participant Information",
    "2 Meaning Units",
    "3 Harmonized Codes",
    "4 Harmonized Categories",
    "5 Harmonized Themes"
]);

const LAYERS = Object.freeze({
    "2a": {
        arrayField: "harmonized_codes",
        idField: "id",
        textField: "label",
        sourceField: "source_codes",
        prefix: "HCO",
        sourceLabel: "preliminary CO"
    },
    "2b": {
        arrayField: "harmonized_categories",
        idField: "id",
        textField: "label",
        sourceField: "source_categories",
        prefix: "HCA",
        sourceLabel: "preliminary CA"
    },
    "2c": {
        arrayField: "harmonized_themes",
        idField: "id",
        textField: "statement",
        sourceField: "source_themes",
        prefix: "HTH",
        sourceLabel: "preliminary TH"
    }
});

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
    return String(left.participantCode || left.caseNumber).localeCompare(
        String(right.participantCode || right.caseNumber),
        undefined,
        { numeric: true }
    ) || Number(left.sessionSequence || 0) - Number(right.sessionSequence || 0)
      || String(left.caseNumber).localeCompare(String(right.caseNumber), undefined, {
          numeric: true
      });
}

function displayValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return value;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (text.length > 32_767) {
        throw new Error(
            "A Harmonized Report value exceeds Excel's cell limit. The stored model response remains unchanged."
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

function completedRunForLayer(runs, analysisLayer) {
    const matching = runs
        .filter(run => run.analysis_layer === analysisLayer)
        .sort((left, right) => Number(right.attempt_number) - Number(left.attempt_number));
    const run = matching[0];
    if (!run) {
        throw Object.assign(new Error(
            `The cohort has no Stage ${analysisLayer.toUpperCase()} result.`
        ), { status: 409 });
    }
    if (run.status !== "completed") {
        throw Object.assign(new Error(
            `The latest Stage ${analysisLayer.toUpperCase()} attempt is ${run.status}; its exact record remains available, but the Harmonized Report is not yet constructible from all three latest attempts.`
        ), { status: 409 });
    }
    return run;
}

function presentationForRun(presentations, run) {
    const presentation = presentations.find(item => item.run_id === run.id);
    if (!presentation?.presentation_json) {
        throw Object.assign(new Error(
            `Stage ${run.analysis_layer.toUpperCase()} completed, but its exact output is not available as structured data. Inspect the immutable provider response directly.`
        ), { status: 409 });
    }
    return presentation.presentation_json;
}

function projectLayer(items, lineageRows, contract, caseIds) {
    const lineage = new Map(lineageRows.map(row => [row.source_ref, row.case_id]));
    const caseItems = new Map([...caseIds].map(caseId => [caseId, []]));
    const vocabulary = [];
    let totalSourceMentions = 0;
    let unmatchedSourceMentions = 0;

    (items || []).forEach((item, position) => {
        const sourceRefs = Array.isArray(item?.[contract.sourceField])
            ? item[contract.sourceField] : [];
        const mentionsByCase = new Map();
        sourceRefs.forEach(sourceRef => {
            totalSourceMentions += 1;
            const caseId = lineage.get(sourceRef);
            if (!caseId || !caseItems.has(caseId)) {
                unmatchedSourceMentions += 1;
                return;
            }
            mentionsByCase.set(caseId, (mentionsByCase.get(caseId) || 0) + 1);
        });
        const projected = {
            id: displayValue(item?.[contract.idField]),
            text: displayValue(item?.[contract.textField]),
            position: position + 1,
            sourceMentions: sourceRefs.length,
            caseMentions: mentionsByCase.size
        };
        vocabulary.push(projected);
        mentionsByCase.forEach((sourceMentions, caseId) => {
            caseItems.get(caseId).push({
                id: projected.id,
                text: projected.text,
                position: projected.position,
                sourceMentions
            });
        });
    });

    return {
        ...contract,
        vocabulary,
        caseItems,
        totalSourceMentions,
        unmatchedSourceMentions
    };
}

export function assembleHarmonizedReport({
    cohort,
    project,
    runs,
    presentations,
    cases,
    meaningUnits,
    lineages
}) {
    const orderedCases = [...cases].sort(naturalCaseOrder);
    const caseIds = new Set(orderedCases.map(item => item.caseId));
    const layers = {};
    for (const analysisLayer of Object.keys(LAYERS)) {
        const run = runs[analysisLayer];
        const presentation = presentations[analysisLayer];
        const contract = LAYERS[analysisLayer];
        layers[analysisLayer] = projectLayer(
            presentation?.[contract.arrayField],
            lineages[analysisLayer] || [],
            contract,
            caseIds
        );
        layers[analysisLayer].run = run;
    }
    return {
        cohort,
        project,
        runs,
        cases: orderedCases,
        meaningUnits,
        layers,
        newAiApiCallCount: 0
    };
}

async function rowsForValues(supabase, table, columns, field, values, message) {
    const unique = [...new Set(values.filter(Boolean))];
    const rows = [];
    for (let index = 0; index < unique.length; index += 100) {
        const selected = unique.slice(index, index + 100);
        rows.push(...await allRows(
            () => supabase.from(table).select(columns).in(field, selected),
            message
        ));
    }
    return rows;
}

function presentationMeaningUnits(presentation) {
    return (presentation?.meaning_units || []).map((item, index) => ({
        position: index + 1,
        englishText: (item?.sources || [])
            .map(source => source?.english_text)
            .filter(value => typeof value === "string" && value.trim())
            .join("\n")
    })).filter(item => item.englishText);
}

export function extractCompleteJsonArray(source, key) {
    if (typeof source !== "string" || !source || typeof key !== "string" || !key) {
        return null;
    }
    const keyPosition = source.indexOf(`"${key}"`);
    if (keyPosition < 0) return null;
    const arrayPosition = source.indexOf("[", keyPosition + key.length + 2);
    if (arrayPosition < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = arrayPosition; index < source.length; index += 1) {
        const character = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === "\"") inString = false;
        } else if (character === "\"") inString = true;
        else if (character === "[") depth += 1;
        else if (character === "]") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const result = JSON.parse(source.slice(arrayPosition, index + 1));
                    return Array.isArray(result) ? result : null;
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function preservedResponseMeaningUnits(rawModelOutputText) {
    const units = extractCompleteJsonArray(rawModelOutputText, "meaning_units") || [];
    return units.map((item, index) => ({
        position: Number(
            item?.meaning_unit_number ?? item?.unit_number ?? index + 1
        ),
        englishText: item?.exact_source_text
            ?? item?.english_text
            ?? item?.text
            ?? ""
    })).filter(item => typeof item.englishText === "string"
        && item.englishText.trim());
}

async function loadCaseDisplay(supabase, cohortCases) {
    const caseIds = cohortCases.map(item => item.id);
    const pilotAssumptions = await rowsForValues(
        supabase,
        "pilot_stage1_assumptions_v2",
        "case_id, source_materialization_run_id, source_job_id",
        "case_id",
        caseIds,
        "The pilot Stage 1 lineage could not be loaded."
    );
    const pilotByCase = new Map(pilotAssumptions.map(item => [item.case_id, item]));
    const materializationIds = pilotAssumptions.map(item =>
        item.source_materialization_run_id);
    const [pilotForms, pilotMeaningUnits, sessions, attempts] = await Promise.all([
        rowsForValues(
            supabase,
            "stage1_preliminary_case_forms",
            "materialization_run_id, source_job_id, participant_code, case_number, session_sequence, language, demographics",
            "materialization_run_id",
            materializationIds,
            "The frozen participant information could not be loaded."
        ),
        rowsForValues(
            supabase,
            "stage1_preliminary_meaning_units",
            "materialization_run_id, source_job_id, position, english_text",
            "materialization_run_id",
            materializationIds,
            "The frozen Meaning Units could not be loaded."
        ),
        rowsForValues(
            supabase,
            "analysis_case_sessions_v2",
            "case_id, session_id, session_order",
            "case_id",
            caseIds,
            "The case session lineage could not be loaded."
        ),
        rowsForValues(
            supabase,
            "stage1_attempts_v2",
            "id, case_id, attempt_number, status, raw_model_output_text",
            "case_id",
            caseIds,
            "The Stage 1 attempt lineage could not be loaded."
        )
    ]);
    const pilotFormByKey = new Map(pilotForms.map(item => [
        `${item.materialization_run_id}:${item.source_job_id}`, item
    ]));
    const pilotMusByKey = new Map();
    pilotMeaningUnits.forEach(item => {
        const key = `${item.materialization_run_id}:${item.source_job_id}`;
        const values = pilotMusByKey.get(key) || [];
        values.push({
            position: Number(item.position),
            englishText: item.english_text
        });
        pilotMusByKey.set(key, values);
    });
    pilotMusByKey.forEach(values => values.sort((left, right) =>
        left.position - right.position));

    const latestCompletedAttemptByCase = new Map();
    attempts.filter(item => item.status === "completed").forEach(item => {
        const current = latestCompletedAttemptByCase.get(item.case_id);
        if (!current || Number(item.attempt_number) > Number(current.attempt_number)) {
            latestCompletedAttemptByCase.set(item.case_id, item);
        }
    });
    const presentations = await rowsForValues(
        supabase,
        "stage1_presentations_v2",
        "attempt_id, presentation_json",
        "attempt_id",
        [...latestCompletedAttemptByCase.values()].map(item => item.id),
        "The Stage 1 presentation lineage could not be loaded."
    );
    const presentationByAttempt = new Map(presentations.map(item =>
        [item.attempt_id, item.presentation_json]));
    const sessionsByCase = new Map();
    sessions.forEach(item => {
        const values = sessionsByCase.get(item.case_id) || [];
        values.push(item);
        sessionsByCase.set(item.case_id, values);
    });
    const sessionRows = await rowsForValues(
        supabase,
        "interview_sessions",
        "session_id, language",
        "session_id",
        sessions.map(item => item.session_id),
        "The interview-language lineage could not be loaded."
    );
    const sessionById = new Map(sessionRows.map(item => [item.session_id, item]));
    const descriptors = await rowsForValues(
        supabase,
        "participant_descriptors",
        "session_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors",
        "session_id",
        sessions.map(item => item.session_id),
        "The participant descriptors could not be loaded."
    );
    const descriptorBySession = new Map(descriptors.map(item =>
        [item.session_id, item]));

    const meaningUnits = [];
    const cases = cohortCases.map(analysisCase => {
        const pilot = pilotByCase.get(analysisCase.id);
        const pilotKey = pilot
            ? `${pilot.source_materialization_run_id}:${pilot.source_job_id}` : null;
        const pilotForm = pilotKey ? pilotFormByKey.get(pilotKey) : null;
        const orderedSessions = (sessionsByCase.get(analysisCase.id) || [])
            .sort((left, right) => Number(left.session_order) - Number(right.session_order));
        const firstSession = orderedSessions[0] || null;
        const descriptor = descriptorBySession.get(firstSession?.session_id) || {};
        const { session_id: ignoredSessionId, ...demographics } = descriptor;
        const attempt = latestCompletedAttemptByCase.get(analysisCase.id);
        const pilotUnits = pilotKey ? pilotMusByKey.get(pilotKey) || [] : [];
        const preservedUnits = preservedResponseMeaningUnits(
            attempt?.raw_model_output_text
        );
        const units = pilotUnits.length
            ? pilotUnits
            : preservedUnits.length
                ? preservedUnits
                : presentationMeaningUnits(presentationByAttempt.get(attempt?.id));
        units.forEach(unit => meaningUnits.push({
            caseId: analysisCase.id,
            position: unit.position,
            englishText: unit.englishText
        }));
        return {
            caseId: analysisCase.id,
            caseNumber: pilotForm?.case_number || analysisCase.case_number,
            participantCode: pilotForm?.participant_code || analysisCase.case_number,
            sessionSequence: pilotForm?.session_sequence || firstSession?.session_order || 1,
            language: pilotForm?.language
                || sessionById.get(firstSession?.session_id)?.language || "",
            demographics: pilotForm?.demographics || demographics
        };
    });
    return { cases, meaningUnits };
}

export async function loadHarmonizedReport(supabase, cohortIdValue) {
    const cohortId = requireUuid(cohortIdValue, "Choose a valid cohort.");
    const cohort = requireData(
        await supabase.from("analysis_cohorts_v2")
            .select("id, project_id, name, status, created_at, closed_at")
            .eq("id", cohortId)
            .maybeSingle(),
        "The cohort could not be loaded."
    );
    if (!cohort) {
        throw Object.assign(new Error("The cohort does not exist."), { status: 404 });
    }
    const [project, runRows, memberships] = await Promise.all([
        requireData(
            await supabase.from("research_projects")
                .select("id, project_code, project_name, research_topic")
                .eq("id", cohort.project_id)
                .single(),
            "The Harmonized Report project could not be loaded."
        ),
        allRows(
            () => supabase.from("stage2_runs_v2")
                .select("id, cohort_id, analysis_layer, attempt_number, status, provider, model, reasoning_effort, provider_response_id, terminal_at")
                .eq("cohort_id", cohortId)
                .order("analysis_layer")
                .order("attempt_number", { ascending: false }),
            "The Stage 2 run lineage could not be loaded."
        ),
        allRows(
            () => supabase.from("analysis_cohort_cases_v2")
                .select("case_id")
                .eq("cohort_id", cohortId),
            "The frozen cohort membership could not be loaded."
        )
    ]);
    const runs = Object.fromEntries(Object.keys(LAYERS).map(layer => [
        layer, completedRunForLayer(runRows, layer)
    ]));
    const runIds = Object.values(runs).map(run => run.id);
    const presentationRows = await rowsForValues(
        supabase,
        "stage2_presentations_v2",
        "run_id, presentation_json, materialization_error",
        "run_id",
        runIds,
        "The exact Stage 2 presentations could not be loaded."
    );
    const presentations = Object.fromEntries(Object.keys(LAYERS).map(layer => [
        layer, presentationForRun(presentationRows, runs[layer])
    ]));
    const memberIds = new Set(memberships.map(item => item.case_id));
    const projectCases = await allRows(
        () => supabase.from("analysis_cases_v2")
            .select("id, participant_id, case_number")
            .eq("project_id", cohort.project_id)
            .order("case_number"),
        "The cohort cases could not be loaded."
    );
    const cohortCases = projectCases.filter(item => memberIds.has(item.id));
    const [codeLineage, itemLineage, display] = await Promise.all([
        allRows(
            () => supabase.from("stage2_source_code_lineage_v2")
                .select("run_id, source_ref, case_id, local_code_id")
                .eq("run_id", runs["2a"].id)
                .order("source_ref"),
            "The private HCO case lineage could not be loaded."
        ),
        allRows(
            () => supabase.from("stage2_source_item_lineage_v2")
                .select("run_id, source_ref, case_id, local_source_id")
                .in("run_id", [runs["2b"].id, runs["2c"].id])
                .order("source_ref"),
            "The private HCA and HTH case lineage could not be loaded."
        ),
        loadCaseDisplay(supabase, cohortCases)
    ]);
    return assembleHarmonizedReport({
        cohort,
        project,
        runs,
        presentations,
        cases: display.cases,
        meaningUnits: display.meaningUnits,
        lineages: {
            "2a": codeLineage,
            "2b": itemLineage.filter(item => item.run_id === runs["2b"].id),
            "2c": itemLineage.filter(item => item.run_id === runs["2c"].id)
        }
    });
}

function addParticipantSheet(workbook, data) {
    const fields = dynamicDemographicFields(data.cases);
    const sheet = workbook.addWorksheet(HARMONIZED_SHEET_NAMES[0], {
        views: [{ state: "frozen", xSplit: 3, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", "S#", "Language", ...fields.map(titleForDemographicField)
    ], 3);
    data.cases.forEach(item => appendRow(sheet, [
        item.participantCode,
        item.sessionSequence,
        item.language,
        ...fields.map(field => item.demographics?.[field])
    ]));
    sheet.commit();
}

function addMeaningUnitSheet(workbook, data) {
    const grouped = new Map();
    data.meaningUnits.forEach(unit => {
        const values = grouped.get(unit.caseId) || [];
        values.push(unit);
        grouped.set(unit.caseId, values);
    });
    grouped.forEach(values => values.sort((left, right) =>
        Number(left.position) - Number(right.position)));
    const maximum = data.cases.reduce((result, item) => Math.max(
        result,
        grouped.get(item.caseId)?.length || 0
    ), 0);
    const sheet = workbook.addWorksheet(HARMONIZED_SHEET_NAMES[1], {
        views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
    });
    configureSheet(sheet, [
        "P#", ...Array.from({ length: maximum }, (_, index) => `MU${index + 1}`)
    ]);
    data.cases.forEach(item => {
        const values = grouped.get(item.caseId) || [];
        appendRow(sheet, [
            item.participantCode,
            ...Array.from({ length: maximum }, (_, index) =>
                values[index]?.englishText)
        ]);
    });
    sheet.commit();
}

function addHarmonizedLayerSheet(workbook, data, analysisLayer, sheetName) {
    const layer = data.layers[analysisLayer];
    const maximum = data.cases.reduce((result, item) => Math.max(
        result,
        layer.caseItems.get(item.caseId)?.length || 0
    ), 0);
    const headers = ["P#"];
    for (let index = 0; index < maximum; index += 1) {
        headers.push(
            `${layer.prefix}${index + 1} ID`,
            `${layer.prefix}${index + 1}`,
            `${layer.prefix}${index + 1} ${layer.sourceLabel} mentions`
        );
    }
    headers.push(
        `Distinct ${layer.prefix}s in case`,
        `Total ${layer.sourceLabel} mentions`
    );
    const sheet = workbook.addWorksheet(sheetName, {
        views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
    });
    configureSheet(sheet, headers);
    data.cases.forEach(item => {
        const values = layer.caseItems.get(item.caseId) || [];
        const cells = [];
        values.forEach(value => cells.push(
            value.id,
            value.text,
            value.sourceMentions
        ));
        while (cells.length < maximum * 3) cells.push("");
        appendRow(sheet, [
            item.participantCode,
            ...cells,
            values.length,
            values.reduce((sum, value) => sum + value.sourceMentions, 0)
        ]);
    });
    sheet.commit();
}

export async function writeHarmonizedReportWorkbook(
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
    workbook.title = "PLI Harmonized Report";
    workbook.subject = "Deterministic case projection of exact Stage 2A, 2B, and 2C provider outputs";
    workbook.description = [
        `Stage 2A run ${data.runs["2a"].id}`,
        `Stage 2B run ${data.runs["2b"].id}`,
        `Stage 2C run ${data.runs["2c"].id}`,
        "No AI call, analytical validator, reviewer, repairer, or quality gate was used to construct this workbook."
    ].join("; ");
    workbook.created = createdAt;
    workbook.modified = createdAt;
    addParticipantSheet(workbook, data);
    addMeaningUnitSheet(workbook, data);
    addHarmonizedLayerSheet(workbook, data, "2a", HARMONIZED_SHEET_NAMES[2]);
    addHarmonizedLayerSheet(workbook, data, "2b", HARMONIZED_SHEET_NAMES[3]);
    addHarmonizedLayerSheet(workbook, data, "2c", HARMONIZED_SHEET_NAMES[4]);
    await workbook.commit();
}

export function harmonizedReportFilename(data) {
    const name = data.project?.project_code || data.project?.project_name || "project";
    const slug = String(name).toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "project";
    return `${slug}-harmonized-report.xlsx`;
}
