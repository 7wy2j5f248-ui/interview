(function initializeAutomaticCaseAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const DASHBOARD_PAGE_CONCURRENCY = 4;
    const DASHBOARD_REQUEST_TIMEOUT_MS = 20000;
    const COMPACT_IDENTIFIER_HEADERS = Object.freeze([
        { label: "P#", className: "analysisIdentifierColumn" },
        { label: "S#", className: "analysisIdentifierColumn" }
    ]);
    const FORM_ONE_DEMOGRAPHIC_COLUMNS = Object.freeze([
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
    let payload = { counts: {}, cases: [] };
    let activeView = "cases";
    let loadedScope = "active";
    let refreshTimer = null;
    let loadPromise = null;
    let requestedTranscriptOpened = false;
    let activeCaseRecord = null;
    let transcriptReturnContext = null;

    const ANALYSIS_VIEW_LABELS = Object.freeze({
        cases: "Form 1 · Cases",
        keywords: "Form 2 · Keywords",
        codes: "Form 3 · Codes",
        themes: "Form 4 · Themes",
        incomplete: "Needs attention",
        archive: "Archive"
    });

    const gate = document.getElementById("automaticAnalysisTokenGate");
    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const status = document.getElementById("automaticAnalysisStatus");
    const tableHost = document.getElementById("automaticAnalysisTable");
    const dialog = document.getElementById("automaticTranscriptDialog");
    const reportDialog = document.getElementById("automaticCaseReportDialog");
    const archiveButton = document.getElementById("automaticCaseArchiveButton");
    const unlockButton = document.getElementById("automaticAnalysisUnlockButton");
    const gateStatus = document.getElementById("automaticAnalysisGateStatus");

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function setStatus(text, isError = false) {
        status.textContent = text;
        status.className = isError ? "errorMessage" : "muted";
    }

    function setGateStatus(text, isError = false) {
        gateStatus.textContent = text;
        gateStatus.className = isError ? "errorMessage" : "muted";
    }

    function displayValue(value) {
        if (value === null || value === undefined || value === "") {
            return "—";
        }

        if (typeof value === "object") {
            return Object.entries(value)
                .filter(([, nested]) => nested !== null && nested !== "")
                .map(([key, nested]) => `${key.replaceAll("_", " ")}: ${nested}`)
                .join("; ") || "—";
        }

        return String(value).replaceAll("_", " ");
    }

    function demographicsText(demographics) {
        return Object.entries(demographics || {})
            .filter(([, value]) => value !== null && value !== ""
                && !(typeof value === "object" && !Object.keys(value).length))
            .map(([key, value]) => `${key.replaceAll("_", " ")}: ${displayValue(value)}`)
            .join("; ") || "Not recorded";
    }

    function demographicValue(caseRecord, key) {
        const value = caseRecord.demographics?.[key]
            ?? caseRecord.demographics?.additional_descriptors?.[key];
        return displayValue(value);
    }

    function participantCode(caseRecord) {
        return caseRecord.transcriptIdentity?.participantCode
            || String(caseRecord.caseNumber || "").split("-S")[0]
            || "—";
    }

    function sessionNumber(caseRecord) {
        if (Number.isInteger(caseRecord.sessionNumber)
            && caseRecord.sessionNumber > 0) {
            return caseRecord.sessionNumber;
        }

        const match = String(caseRecord.caseNumber || "").match(/-S(\d+)$/i);
        return match ? Number.parseInt(match[1], 10) : "—";
    }

    function transcriptUrl(caseRecord) {
        const url = new URL(window.location.href);
        url.search = "";
        url.hash = "";
        url.searchParams.set("case", caseRecord.caseNumber);
        return url.href;
    }

    function openRequestedTranscript() {
        if (requestedTranscriptOpened) return;
        const requestedCase = new URLSearchParams(window.location.search).get("case");
        if (!requestedCase) return;
        const caseRecord = payload.cases.find(item =>
            item.caseNumber === requestedCase
            && item.transcriptIdentity?.sessionId
        );
        if (!caseRecord) return;
        requestedTranscriptOpened = true;
        openTranscript(caseRecord);
    }

    function createCell(row, value, className = "") {
        const cell = document.createElement("td");
        cell.textContent = value;
        cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function createIdentifierCells(row, caseRecord) {
        createCell(
            row,
            participantCode(caseRecord),
            "analysisIdentifierCell analysisIdentifierColumn"
        );
        createCell(
            row,
            sessionNumber(caseRecord),
            "analysisIdentifierCell analysisIdentifierColumn"
        );
    }

    function createTable(headers) {
        const scroll = document.createElement("div");
        scroll.className = "tableScroll";
        const table = document.createElement("table");
        table.className = "analysisTable automaticAnalysisTable";
        const head = document.createElement("thead");
        const row = document.createElement("tr");

        headers.forEach(header => {
            const definition = typeof header === "string"
                ? { label: header }
                : header;
            const cell = document.createElement("th");
            cell.scope = "col";
            cell.textContent = definition.label;
            cell.className = definition.className || "";
            row.appendChild(cell);
        });

        head.appendChild(row);
        table.appendChild(head);
        scroll.appendChild(table);
        return { scroll, table };
    }

    function transcriptOriginKey(caseRecord, kind, identity = "case") {
        return `${caseRecord.caseNumber}:${kind}:${identity}`;
    }

    function transcriptButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = caseRecord.transcriptIdentity?.sessionId
            ? "Open transcript"
            : "Transcript unavailable";
        button.disabled = !caseRecord.transcriptIdentity?.sessionId;
        button.dataset.transcriptOrigin = transcriptOriginKey(
            caseRecord,
            "case"
        );
        button.addEventListener("click", event => openTranscript(
            caseRecord,
            null,
            {
                trigger: event.currentTarget,
                label: `${ANALYSIS_VIEW_LABELS[activeView]} · ${caseRecord.caseNumber}`
            }
        ));
        return button;
    }

    function caseReportButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = caseRecord.hasReport
            ? "Open case report"
            : caseRecord.status === "processing"
                ? "Analysing"
                : caseRecord.status === "failed"
                    ? "Review historical failure"
                    : "Waiting";
        button.disabled = !caseRecord.hasReport
            && caseRecord.status !== "failed";
        button.addEventListener("click", () => {
            if (caseRecord.hasReport) {
                openCaseReport(caseRecord);
                return;
            }
            if (caseRecord.status === "failed") {
                openLegacyFailureReview(caseRecord);
            }
        });
        return button;
    }

    function analysisStatusText(caseRecord) {
        return caseRecord.status === "failed" && !caseRecord.hasReport
            ? "Historical preliminary-analysis attempt failed — current staged analysis unaffected"
            : caseRecord.status || "—";
    }

    function reviewSource(caseRecord, kind = "case", record = null) {
        const isTheme = kind === "theme";
        const isCode = kind === "code";
        const isCategory = kind === "category";
        const number = isTheme
            ? record?.theme_number
            : isCategory
                ? record?.category_number
            : isCode
                ? record?.code_number
                : null;
        return {
            kind,
            sessionId: caseRecord.transcriptIdentity?.sessionId,
            caseNumber: caseRecord.caseNumber,
            participantCode: participantCode(caseRecord),
            position: number
                ? `${isTheme ? "TH" : isCategory ? "CA" : "CO"}${number}`
                : "CASE",
            recordId: record?.id || null,
            label: isTheme
                ? record?.theme_label
                : isCategory
                    ? record?.category_label
                : isCode
                    ? record?.code_label
                    : "Individual case report"
        };
    }

    function sendSourceToReview(caseRecord, kind = "case", record = null) {
        window.dispatchEvent(new CustomEvent(
            "automatic-analysis-review-source",
            { detail: reviewSource(caseRecord, kind, record) }
        ));
    }

    function reviewSelectButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton automaticReviewSelectButton";
        button.textContent = "Discuss";
        button.title = `Add ${caseRecord.caseNumber} to the second-layer AI discussion`;
        button.addEventListener("click", () => sendSourceToReview(caseRecord));
        return button;
    }

    function archiveCaseButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = caseRecord.hasReport
            ? "Archive"
            : "Available after completion";
        button.disabled = !caseRecord.hasReport
            || caseRecord.status !== "completed";
        button.addEventListener("click", () =>
            setArchiveState(caseRecord, true)
        );
        return button;
    }

    function casesForAnalysisForms() {
        return [...payload.cases].sort((left, right) => {
            const leftCompleted = left.hasReport;
            const rightCompleted = right.hasReport;

            if (leftCompleted !== rightCompleted) {
                return leftCompleted ? -1 : 1;
            }

            const participantOrder = participantCode(left).localeCompare(
                participantCode(right),
                undefined,
                { numeric: true }
            );
            const leftSession = Number(sessionNumber(left));
            const rightSession = Number(sessionNumber(right));
            return participantOrder
                || (Number.isFinite(leftSession) ? leftSession : 0)
                - (Number.isFinite(rightSession) ? rightSession : 0);
        });
    }

    function renderCases() {
        const orderedCases = casesForAnalysisForms();
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "Link to transcript",
            "Case report",
            "Analysis status",
            "Archive",
            "AI discussion",
            "Language",
            ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label)
        ]);
        const body = document.createElement("tbody");

        orderedCases.forEach(caseRecord => {
            const row = document.createElement("tr");
            createIdentifierCells(row, caseRecord);
            const transcriptCell = document.createElement("td");
            transcriptCell.appendChild(transcriptButton(caseRecord));
            row.appendChild(transcriptCell);
            const reportCell = document.createElement("td");
            reportCell.appendChild(caseReportButton(caseRecord));
            row.appendChild(reportCell);
            createCell(row, analysisStatusText(caseRecord));
            const archiveCell = document.createElement("td");
            archiveCell.appendChild(archiveCaseButton(caseRecord));
            row.appendChild(archiveCell);
            const reviewCell = document.createElement("td");
            reviewCell.appendChild(reviewSelectButton(caseRecord));
            row.appendChild(reviewCell);
            createCell(row, caseRecord.language || "—");
            FORM_ONE_DEMOGRAPHIC_COLUMNS.forEach(([key]) => createCell(
                row,
                demographicValue(caseRecord, key)
            ));
            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function recordLabel(record, kind) {
        if (kind === "code") {
            return record?.original_code_label || record?.code_label || "—";
        }
        if (kind === "category") {
            return record?.category_label || "—";
        }
        return record?.original_theme_label || record?.theme_label || "—";
    }

    function keywordEvidenceButton(
        caseRecord,
        highlight,
        buttonText = "Open exact evidence"
    ) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = buttonText;
        button.title = highlight.message_id
            ? `Open source message ${highlight.message_id} in the preserved transcript`
            : "Open the preserved transcript";
        const evidencePosition = Number.isFinite(Number(
            highlight.unit_number ?? highlight.keyword_number
        ))
            ? `MU${highlight.unit_number ?? highlight.keyword_number}`
            : "meaning unit";
        button.dataset.transcriptOrigin = transcriptOriginKey(
            caseRecord,
            "meaning-unit",
            highlight.id || evidencePosition
        );
        button.addEventListener("click", event => openTranscript(
            caseRecord,
            highlight.message_id,
            {
                trigger: event.currentTarget,
                label: `Form 2 · Keywords · ${caseRecord.caseNumber} · ${evidencePosition}`
            }
        ));
        return button;
    }

    function firstEvidenceMessageId(caseRecord, kind, record) {
        if (kind === "code") {
            const unitIds = new Set((caseRecord.codeMeaningUnits || [])
                .filter(mapping => mapping.code_id === record.id)
                .map(mapping => mapping.meaning_unit_id));
            return (caseRecord.meaningUnits || []).find(unit =>
                unitIds.has(unit.id)
            )?.message_id || (caseRecord.highlights || []).find(
                highlight => highlight.code_id === record.id
            )?.message_id || null;
        }
        const categoryIds = kind === "theme"
            ? new Set((caseRecord.themeCategories || [])
                .filter(mapping => mapping.theme_id === record.id)
                .map(mapping => mapping.category_id))
            : new Set([record.id]);
        const codeIds = new Set((caseRecord.categoryCodes || [])
            .filter(mapping => categoryIds.has(mapping.category_id))
            .map(mapping => mapping.code_id));
        const unitIds = new Set((caseRecord.codeMeaningUnits || [])
            .filter(mapping => codeIds.has(mapping.code_id))
            .map(mapping => mapping.meaning_unit_id));
        return (caseRecord.meaningUnits || []).find(unit =>
            unitIds.has(unit.id)
        )?.message_id || (caseRecord.highlights || []).find(
            highlight => codeIds.has(highlight.code_id)
        )?.message_id || null;
    }

    function linkedRecordButton(caseRecord, kind, record) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetExpressionButton";
        const prefix = kind === "code" ? "CO" : kind === "category" ? "CA" : "TH";
        const number = kind === "code" ? record.code_number
            : kind === "category" ? record.category_number
                : record.theme_number;
        button.textContent = recordLabel(record, kind);
        button.title = `Open the annotated transcript evidence for this ${kind}`;
        button.dataset.transcriptOrigin = transcriptOriginKey(
            caseRecord,
            kind,
            record.id || number
        );
        button.addEventListener("click", event => openTranscript(
            caseRecord,
            firstEvidenceMessageId(caseRecord, kind, record),
            {
                trigger: event.currentTarget,
                label: `${ANALYSIS_VIEW_LABELS[activeView]} · ${caseRecord.caseNumber} · ${prefix}${number}`
            }
        ));
        return button;
    }

    function discussionSelectButton(caseRecord, kind, record) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton analysisDiscussionSelectButton";
        button.textContent = "Select for AI discussion";
        button.addEventListener("click", () =>
            sendSourceToReview(caseRecord, kind, record)
        );
        return button;
    }

    function analysisUnits(caseRecord) {
        return (caseRecord.meaningUnits || []).length
            ? caseRecord.meaningUnits
            : (caseRecord.highlights || []).map(highlight => ({
                ...highlight,
                unit_number: highlight.keyword_number,
                anchor_expressions: [highlight.exact_text],
                legacy_code_id: highlight.code_id
            }));
    }

    function keywordExpressions(unit) {
        const anchors = (unit.anchor_expressions || [])
            .map(value => String(value || "").trim())
            .filter(Boolean);
        return [...new Set(anchors.length ? anchors : [unit.exact_text].filter(Boolean))];
    }

    function analysisRelations(caseRecord) {
        const groupMappings = (mappings, sourceKey, targetKey) => mappings.reduce(
            (groups, mapping) => {
                const values = groups.get(mapping[sourceKey]) || [];
                values.push(mapping[targetKey]);
                groups.set(mapping[sourceKey], values);
                return groups;
            },
            new Map()
        );
        return {
            codeById: new Map((caseRecord.codes || []).map(record => [record.id, record])),
            categoryById: new Map((caseRecord.categories || []).map(record => [record.id, record])),
            themeById: new Map((caseRecord.themes || []).map(record => [record.id, record])),
            unitById: new Map(analysisUnits(caseRecord).map(record => [record.id, record])),
            codeIdsByUnit: groupMappings(
                caseRecord.codeMeaningUnits || [],
                "meaning_unit_id",
                "code_id"
            ),
            unitIdsByCode: groupMappings(
                caseRecord.codeMeaningUnits || [],
                "code_id",
                "meaning_unit_id"
            ),
            categoryIdsByCode: groupMappings(
                caseRecord.categoryCodes || [],
                "code_id",
                "category_id"
            ),
            codeIdsByCategory: groupMappings(
                caseRecord.categoryCodes || [],
                "category_id",
                "code_id"
            ),
            themeIdsByCategory: groupMappings(
                caseRecord.themeCategories || [],
                "category_id",
                "theme_id"
            ),
            categoryIdsByTheme: groupMappings(
                caseRecord.themeCategories || [],
                "theme_id",
                "category_id"
            )
        };
    }

    function uniqueRecords(ids, recordsById) {
        return [...new Set(ids || [])].map(id => recordsById.get(id)).filter(Boolean);
    }

    function appendRecordLinks(cell, caseRecord, kind, records, emptyText) {
        if (!records.length) {
            cell.textContent = emptyText;
            cell.classList.add("analysisEmptyCell");
            return;
        }
        records.forEach(record => {
            const line = document.createElement("div");
            line.appendChild(linkedRecordButton(caseRecord, kind, record));
            cell.appendChild(line);
        });
    }

    function projectTopicText(caseRecord) {
        const project = caseRecord.researchProject;
        return project
            ? `${project.project_name} · ${project.research_topic}`
            : "Legacy project/topic not recorded";
    }

    function reportProvenanceText(caseRecord) {
        const framework = caseRecord.analysisFramework;
        const globalRules = caseRecord.globalAnalysisRules;
        return `${globalRules ? `Global rules v${globalRules.version_number}` : "Legacy global rules"} · ${framework ? `Project rules v${framework.version_number}` : "Legacy project rules"} · Report ${caseRecord.reportLineage?.reportId || "—"}`;
    }

    function evidenceCell(caseRecord, unit, buttonText = "Open exact evidence") {
        const cell = document.createElement("td");
        cell.appendChild(keywordEvidenceButton(caseRecord, unit, buttonText));
        if (unit?.message_id) {
            const reference = document.createElement("small");
            reference.className = "analysisLinkedContext";
            reference.textContent = `Message ${unit.message_id}`;
            cell.appendChild(reference);
        }
        return cell;
    }

    function renderKeywords() {
        const completed = casesForAnalysisForms().filter(item => item.hasReport);
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "K#",
            "Exact keyword",
            "Evidence unit",
            "Exact transcript evidence",
            "Linked code(s)",
            "Linked category path",
            "Linked theme(s)",
            "Open evidence",
            "Case report",
            "Analysis status",
            "Project / topic",
            "Framework / report provenance"
        ]);
        scroll.classList.add("keywordRecordsScroll");
        const body = document.createElement("tbody");
        let keywordCount = 0;

        completed.forEach(caseRecord => {
            const relations = analysisRelations(caseRecord);
            let caseKeywordNumber = 0;
            analysisUnits(caseRecord).forEach((unit, unitIndex) => {
                keywordExpressions(unit).forEach(keyword => {
                    keywordCount += 1;
                    caseKeywordNumber += 1;
                    const row = document.createElement("tr");
                    createIdentifierCells(row, caseRecord);
                    createCell(row, `K${caseKeywordNumber}`, "analysisIdentifierCell");
                    const keywordCell = document.createElement("td");
                    keywordCell.className = "analysisExactKeywordCell";
                    keywordCell.appendChild(keywordEvidenceButton(caseRecord, unit, keyword));
                    row.appendChild(keywordCell);
                    createCell(
                        row,
                        Number.isFinite(Number(unit.unit_number))
                            ? `MU${unit.unit_number}`
                            : `MU${unitIndex + 1}`,
                        "analysisIdentifierCell"
                    );
                    createCell(
                        row,
                        unit.exact_text || unit.english_translation || "—",
                        "analysisEvidenceTextCell"
                    );

                    const codeIds = unit.legacy_code_id
                        ? [unit.legacy_code_id]
                        : relations.codeIdsByUnit.get(unit.id) || [];
                    const codes = uniqueRecords(codeIds, relations.codeById);
                    const categoryIds = [...new Set(codeIds.flatMap(
                        codeId => relations.categoryIdsByCode.get(codeId) || []
                    ))];
                    const categories = uniqueRecords(categoryIds, relations.categoryById);
                    const themeIds = [...new Set(categoryIds.flatMap(
                        categoryId => relations.themeIdsByCategory.get(categoryId) || []
                    ))];
                    const themes = uniqueRecords(themeIds, relations.themeById);

                    const codeCell = document.createElement("td");
                    appendRecordLinks(codeCell, caseRecord, "code", codes, "Unlinked");
                    row.appendChild(codeCell);
                    const categoryCell = document.createElement("td");
                    appendRecordLinks(
                        categoryCell,
                        caseRecord,
                        "category",
                        categories,
                        "No category"
                    );
                    row.appendChild(categoryCell);
                    const themeCell = document.createElement("td");
                    appendRecordLinks(
                        themeCell,
                        caseRecord,
                        "theme",
                        themes,
                        "No higher-level theme"
                    );
                    row.appendChild(themeCell);
                    row.appendChild(evidenceCell(caseRecord, unit));
                    const caseCell = document.createElement("td");
                    caseCell.appendChild(caseReportButton(caseRecord));
                    row.appendChild(caseCell);
                    createCell(row, caseRecord.status || "—");
                    createCell(row, projectTopicText(caseRecord), "analysisProvenanceCell");
                    createCell(row, reportProvenanceText(caseRecord), "analysisProvenanceCell");
                    body.appendChild(row);
                });
            });
        });

        if (!keywordCount) {
            const row = document.createElement("tr");
            const cell = createCell(
                row,
                "No exact keywords are available in the active completed reports.",
                "analysisEmptyRow"
            );
            cell.colSpan = 13;
            body.appendChild(row);
        }

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function renderIncomplete() {
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "Link to transcript",
            "Why it needs attention",
            "Brief partial-case summary",
            "Last activity",
            "Language",
            ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label)
        ]);
        const body = document.createElement("tbody");

        casesForAnalysisForms().forEach(caseRecord => {
            const row = document.createElement("tr");
            createIdentifierCells(row, caseRecord);
            const transcriptCell = document.createElement("td");
            transcriptCell.appendChild(transcriptButton(caseRecord));
            row.appendChild(transcriptCell);
            createCell(row, caseRecord.completionRemark || "Incomplete");
            createCell(row, caseRecord.briefSummary || "No recorded material");
            createCell(row, formatTimestamp(caseRecord.lastActivityAt));
            createCell(row, caseRecord.language || "—");
            FORM_ONE_DEMOGRAPHIC_COLUMNS.forEach(([key]) => createCell(
                row,
                demographicValue(caseRecord, key)
            ));
            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function compactKeywords(units) {
        return [...new Set(units.flatMap(keywordExpressions))].join("; ") || "—";
    }

    function renderCodes() {
        const completed = casesForAnalysisForms().filter(item => item.hasReport);
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "CO#",
            "Code",
            "Linked keyword(s)",
            "Linked category path",
            "Linked theme(s)",
            "Exact transcript evidence",
            "Rationale",
            "AI discussion",
            "Analysis status",
            "Project / topic",
            "Framework / report provenance"
        ]);
        const body = document.createElement("tbody");
        let codeCount = 0;

        completed.forEach(caseRecord => {
            const relations = analysisRelations(caseRecord);
            (caseRecord.codes || []).forEach(code => {
                codeCount += 1;
                const row = document.createElement("tr");
                createIdentifierCells(row, caseRecord);
                createCell(row, `CO${code.code_number}`, "analysisIdentifierCell");
                const codeCell = document.createElement("td");
                codeCell.appendChild(linkedRecordButton(caseRecord, "code", code));
                row.appendChild(codeCell);

                const units = uniqueRecords(
                    relations.unitIdsByCode.get(code.id) || [],
                    relations.unitById
                );
                const legacyUnits = units.length ? units : analysisUnits(caseRecord).filter(
                    unit => unit.legacy_code_id === code.id
                );
                createCell(
                    row,
                    compactKeywords(legacyUnits),
                    "analysisCompactList"
                );
                const categories = uniqueRecords(
                    relations.categoryIdsByCode.get(code.id) || [],
                    relations.categoryById
                );
                const categoryCell = document.createElement("td");
                appendRecordLinks(
                    categoryCell,
                    caseRecord,
                    "category",
                    categories,
                    "No category"
                );
                row.appendChild(categoryCell);
                const themeIds = categories.flatMap(category =>
                    relations.themeIdsByCategory.get(category.id) || []
                );
                const themes = uniqueRecords(themeIds, relations.themeById);
                const themeCell = document.createElement("td");
                appendRecordLinks(
                    themeCell,
                    caseRecord,
                    "theme",
                    themes,
                    "No higher-level theme"
                );
                row.appendChild(themeCell);
                row.appendChild(legacyUnits.length
                    ? evidenceCell(caseRecord, legacyUnits[0])
                    : evidenceCell(caseRecord, {
                        message_id: firstEvidenceMessageId(caseRecord, "code", code)
                    }));
                createCell(row, code.rationale || "—", "analysisCompactList");
                const discussionCell = document.createElement("td");
                discussionCell.appendChild(discussionSelectButton(
                    caseRecord,
                    "code",
                    code
                ));
                row.appendChild(discussionCell);
                createCell(row, caseRecord.status || "—");
                createCell(row, projectTopicText(caseRecord), "analysisProvenanceCell");
                createCell(row, reportProvenanceText(caseRecord), "analysisProvenanceCell");
                body.appendChild(row);
            });
        });

        if (!codeCount) {
            const row = document.createElement("tr");
            const cell = createCell(row, "No codes are available.", "analysisEmptyRow");
            cell.colSpan = 12;
            body.appendChild(row);
        }
        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function renderThemes() {
        const completed = casesForAnalysisForms().filter(item => item.hasReport);
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "TH#",
            "Theme",
            "Linked category path",
            "Linked codes",
            "Linked keyword(s)",
            "Exact transcript evidence",
            "Rationale",
            "AI discussion",
            "Analysis status",
            "Project / topic",
            "Framework / report provenance"
        ]);
        const body = document.createElement("tbody");
        let themeCount = 0;

        completed.forEach(caseRecord => {
            const relations = analysisRelations(caseRecord);
            (caseRecord.themes || []).forEach(theme => {
                themeCount += 1;
                const row = document.createElement("tr");
                createIdentifierCells(row, caseRecord);
                createCell(row, `TH${theme.theme_number}`, "analysisIdentifierCell");
                const themeCell = document.createElement("td");
                themeCell.appendChild(linkedRecordButton(caseRecord, "theme", theme));
                row.appendChild(themeCell);

                const categories = uniqueRecords(
                    relations.categoryIdsByTheme.get(theme.id) || [],
                    relations.categoryById
                );
                const categoryCell = document.createElement("td");
                appendRecordLinks(
                    categoryCell,
                    caseRecord,
                    "category",
                    categories,
                    "No category"
                );
                row.appendChild(categoryCell);
                const codes = uniqueRecords(
                    categories.flatMap(category =>
                        relations.codeIdsByCategory.get(category.id) || []
                    ),
                    relations.codeById
                );
                const codeCell = document.createElement("td");
                appendRecordLinks(codeCell, caseRecord, "code", codes, "No linked codes");
                row.appendChild(codeCell);
                const units = uniqueRecords(
                    codes.flatMap(code => relations.unitIdsByCode.get(code.id) || []),
                    relations.unitById
                );
                createCell(row, compactKeywords(units), "analysisCompactList");
                row.appendChild(units.length
                    ? evidenceCell(caseRecord, units[0])
                    : evidenceCell(caseRecord, {
                        message_id: firstEvidenceMessageId(caseRecord, "theme", theme)
                    }));
                createCell(row, theme.rationale || "—", "analysisCompactList");
                const discussionCell = document.createElement("td");
                discussionCell.appendChild(discussionSelectButton(
                    caseRecord,
                    "theme",
                    theme
                ));
                row.appendChild(discussionCell);
                createCell(row, caseRecord.status || "—");
                createCell(row, projectTopicText(caseRecord), "analysisProvenanceCell");
                createCell(row, reportProvenanceText(caseRecord), "analysisProvenanceCell");
                body.appendChild(row);
            });
        });

        if (!themeCount) {
            const row = document.createElement("tr");
            const cell = createCell(row, "No themes are available.", "analysisEmptyRow");
            cell.colSpan = 12;
            body.appendChild(row);
        }
        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function formatTimestamp(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? displayValue(value)
            : date.toLocaleString();
    }

    function renderArchive() {
        const maximumCodes = Math.max(0, ...payload.cases.map(item =>
            Math.max(0, ...(item.codes || []).map(code => code.code_number))
        ));
        const maximumThemes = Math.max(0, ...payload.cases.map(item =>
            Math.max(0, ...(item.themes || []).map(theme => theme.theme_number))
        ));
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "Archived",
            "Archive note",
            "Link to transcript",
            "Case report",
            "Action",
            "Language",
            ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label),
            ...Array.from(
                { length: maximumCodes },
                (_, index) => `CO${index + 1}`
            ),
            ...Array.from(
                { length: maximumThemes },
                (_, index) => `TH${index + 1}`
            )
        ]);
        const body = document.createElement("tbody");

        payload.cases.forEach(caseRecord => {
            const row = document.createElement("tr");
            createIdentifierCells(row, caseRecord);
            createCell(row, formatTimestamp(caseRecord.archivedAt));
            createCell(row, caseRecord.archiveNote || "—");
            const transcriptCell = document.createElement("td");
            transcriptCell.appendChild(transcriptButton(caseRecord));
            row.appendChild(transcriptCell);
            const reportCell = document.createElement("td");
            reportCell.appendChild(caseReportButton(caseRecord));
            row.appendChild(reportCell);
            const restoreCell = document.createElement("td");
            const restoreButton = document.createElement("button");
            restoreButton.type = "button";
            restoreButton.className = "worksheetTranscriptButton";
            restoreButton.textContent = "Restore to active analysis";
            restoreButton.addEventListener("click", () =>
                setArchiveState(caseRecord, false)
            );
            restoreCell.appendChild(restoreButton);
            row.appendChild(restoreCell);
            createCell(row, caseRecord.language || "—");
            FORM_ONE_DEMOGRAPHIC_COLUMNS.forEach(([key]) => createCell(
                row,
                demographicValue(caseRecord, key)
            ));

            const codeByNumber = (caseRecord.codes || []).reduce((groups, code) => {
                const values = groups.get(code.code_number) || [];
                values.push(code);
                groups.set(code.code_number, values);
                return groups;
            }, new Map());
            for (let number = 1; number <= maximumCodes; number += 1) {
                const codes = codeByNumber.get(number) || [];
                const cell = createCell(
                    row,
                    codes.map(code => code.code_label).join(" | ") || "—"
                );
                cell.title = codes.map(code => code.rationale).join("\n");
                if (!codes.length) cell.className = "analysisEmptyCell";
            }

            const themeByNumber = (caseRecord.themes || []).reduce(
                (groups, theme) => {
                    const values = groups.get(theme.theme_number) || [];
                    values.push(theme);
                    groups.set(theme.theme_number, values);
                    return groups;
                },
                new Map()
            );
            for (let number = 1; number <= maximumThemes; number += 1) {
                const themes = themeByNumber.get(number) || [];
                const cell = createCell(
                    row,
                    themes.map(theme => theme.theme_label).join(" | ") || "—"
                );
                cell.title = themes.map(theme => theme.rationale).join("\n");
                if (!themes.length) cell.className = "analysisEmptyCell";
            }

            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function render() {
        const counts = payload.counts || {};
        const completedCases = casesForAnalysisForms().filter(
            caseRecord => caseRecord.hasReport
        );
        const casesWithKeywords = completedCases.filter(
            caseRecord => (caseRecord.meaningUnits || []).length > 0
                || (caseRecord.highlights || []).length > 0
        ).length;
        ["pending", "processing", "failed"].forEach(key => {
            document.getElementById(
                `automaticAnalysis${key[0].toUpperCase()}${key.slice(1)}Count`
            ).textContent = counts[key] || 0;
        });
        document.getElementById("automaticAnalysisCompletedCount").textContent =
            completedCases.length;
        document.getElementById("automaticAnalysisIncompleteCount").textContent =
            counts.incomplete || 0;

        if (activeView === "archive") {
            renderArchive();
        } else if (activeView === "incomplete") {
            renderIncomplete();
        } else if (activeView === "cases") {
            renderCases();
        } else if (activeView === "keywords") {
            renderKeywords();
        } else if (activeView === "codes") {
            renderCodes();
        } else if (activeView === "themes") {
            renderThemes();
        }

        document.querySelectorAll("[data-automatic-analysis-view]")
            .forEach(button => {
                button.setAttribute(
                    "aria-pressed",
                    String(button.dataset.automaticAnalysisView === activeView)
                );
            });
        document.getElementById("automaticAnalysisDescription").textContent =
            activeView === "cases"
                ? `Form 1 · Cases: ${completedCases.length} completed case reports are shown in participant-code order. PLI finishes the analysis without waiting for researcher approval; feedback starts a new version afterward.`
                : activeView === "keywords"
                    ? `Form 2 · Keywords: ${casesWithKeywords} cases contain exact keyword expressions. Every keyword remains linked to its full transcript evidence, code, category path, theme, framework, and report provenance.`
                    : activeView === "codes"
                        ? "Form 3 · Codes: one row per case-specific code, with its linked keywords, category path, themes, exact evidence, rationale, status, and provenance."
                        : activeView === "themes"
                            ? "Form 4 · Themes: one row per case-specific theme, with its linked categories, codes, keywords, exact evidence, rationale, status, and provenance."
                        : activeView === "incomplete"
                            ? "Needs attention: unfinished interviews are separate from Forms 1–4. No keywords, codes, categories, or themes are assigned before formal completion."
                            : "Archived cases are excluded from every active analysis form and from future automatic reanalysis. Each archived row preserves its transcript, report, language, demographic columns, and its MU/CO/CA/TH hierarchy.";
        window.dispatchEvent(new CustomEvent("automatic-analysis-review-ready"));
    }

    function highlightedText(message, caseRecord) {
        const text = message.Message || "";
        const codeById = new Map((caseRecord.codes || []).map(code => [code.id, code]));
        const codeIdsByUnit = (caseRecord.codeMeaningUnits || []).reduce(
            (groups, mapping) => {
                const values = groups.get(mapping.meaning_unit_id) || [];
                values.push(mapping.code_id);
                groups.set(mapping.meaning_unit_id, values);
                return groups;
            },
            new Map()
        );
        const meaningUnits = (caseRecord.meaningUnits || []).length
            ? (caseRecord.meaningUnits || []).map(unit => ({
                ...unit,
                codes: [...new Set(codeIdsByUnit.get(unit.id) || [])]
                    .map(codeId => codeById.get(codeId)).filter(Boolean)
            }))
            : (caseRecord.highlights || []).map(highlight => ({
                ...highlight,
                codes: [codeById.get(highlight.code_id)].filter(Boolean)
            }));
        const highlights = meaningUnits
            .filter(item => item.message_id === message.id)
            .sort((left, right) => left.start_offset - right.start_offset);
        const fragment = document.createDocumentFragment();
        let cursor = 0;

        highlights.forEach(item => {
            if (item.start_offset < cursor || item.end_offset > text.length) {
                return;
            }

            fragment.append(document.createTextNode(text.slice(cursor, item.start_offset)));
            const annotation = document.createElement("span");
            annotation.className = "meaningUnitAnnotation";
            const label = document.createElement("span");
            label.className = "meaningUnitCodeLabel";
            label.textContent = item.codes.length
                ? item.codes.map(code => `CO${code.code_number}: ${code.code_label}`).join(" · ")
                : "Meaning unit";
            const mark = document.createElement("mark");
            const code = item.codes[0];
            mark.className = `keywordColor${code?.color_slot || 1}`;
            mark.textContent = text.slice(item.start_offset, item.end_offset);
            mark.title = code ? `CO${code.code_number}: ${code.code_label}` : "Meaning unit";
            annotation.append(label, mark);
            fragment.append(annotation);
            cursor = item.end_offset;
        });

        fragment.append(document.createTextNode(text.slice(cursor)));
        return fragment;
    }

    function rememberTranscriptOrigin(caseRecord, origin = {}) {
        const tableScroll = tableHost.querySelector(".tableScroll");
        const trigger = origin.trigger || null;
        transcriptReturnContext = {
            view: activeView,
            caseNumber: caseRecord.caseNumber,
            label: origin.label
                || `${ANALYSIS_VIEW_LABELS[activeView]} · ${caseRecord.caseNumber}`,
            trigger,
            triggerKey: trigger?.dataset?.transcriptOrigin || null,
            windowX: window.scrollX,
            windowY: window.scrollY,
            tableScrollLeft: tableScroll?.scrollLeft || 0,
            tableScrollTop: tableScroll?.scrollTop || 0
        };
        document.getElementById("automaticTranscriptCloseButton").textContent =
            `Return to ${transcriptReturnContext.label}`;
    }

    function returnFromTranscript() {
        const origin = transcriptReturnContext;
        dialog.close();
        transcriptReturnContext = null;
        if (!origin) return;
        window.requestAnimationFrame(() => {
            const tableScroll = tableHost.querySelector(".tableScroll");
            if (tableScroll) {
                tableScroll.scrollLeft = origin.tableScrollLeft;
                tableScroll.scrollTop = origin.tableScrollTop;
            }
            window.scrollTo(origin.windowX, origin.windowY);
            let trigger = origin.trigger?.isConnected ? origin.trigger : null;
            if (!trigger && origin.triggerKey) {
                trigger = [...document.querySelectorAll(
                    "[data-transcript-origin]"
                )].find(candidate =>
                    candidate.dataset.transcriptOrigin === origin.triggerKey
                ) || null;
            }
            trigger?.focus({ preventScroll: true });
        });
    }

    async function openTranscript(
        caseRecord,
        requestedMessageId = null,
        origin = {}
    ) {
        rememberTranscriptOrigin(caseRecord, origin);
        document.getElementById("automaticTranscriptHeading").textContent =
            `${caseRecord.caseNumber} · annotated transcript`;
        const expectedIdentity = caseRecord.transcriptIdentity;
        document.getElementById("automaticTranscriptIdentity").textContent =
            "Verifying participant identity…";
        document.getElementById("automaticTranscriptDemographics").textContent =
            demographicsText(caseRecord.demographics);
        const legend = document.getElementById("automaticTranscriptLegend");
        legend.replaceChildren();
        (caseRecord.codes || []).forEach(code => {
            const item = document.createElement("span");
            item.className = `keywordLegend keywordColor${code.color_slot}`;
            item.textContent = `CO${code.code_number}: ${code.code_label}`;
            item.title = code.rationale;
            legend.appendChild(item);
        });
        const messages = document.getElementById("automaticTranscriptMessages");
        messages.textContent =
            "Loading the full transcript and completing any missing English translations…";
        dialog.showModal();

        try {
            const response = await fetch(
                `/api/messages?session=${encodeURIComponent(expectedIdentity.sessionId)}`,
                {
                    headers: {
                        Authorization: `Bearer ${token()}`
                    }
                }
            );
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || "Transcript could not be loaded.");
            }

            const identity = data.identity || {};
            const identityMatches = (
                identity.sessionId === expectedIdentity.sessionId
                && identity.participantId === expectedIdentity.participantId
                && identity.participantCode === expectedIdentity.participantCode
            );

            if (!identityMatches) {
                throw new Error(
                    "Transcript hidden because its participant identity does not match this case."
                );
            }

            document.getElementById("automaticTranscriptIdentity").textContent =
                `Participant code: ${identity.participantCode} · Participant ID: ${identity.participantId} · Session ID: ${identity.sessionId} · Verified match`;
            messages.replaceChildren();
            let requestedMessage = null;
            (data.messages || []).forEach(message => {
                const article = document.createElement("article");
                article.className = "message";
                if (requestedMessageId !== null
                    && String(message.id) === String(requestedMessageId)) {
                    article.classList.add("targetTranscriptMessage");
                    article.tabIndex = -1;
                    requestedMessage = article;
                }
                const paragraph = document.createElement("p");
                const speaker = document.createElement("strong");
                const messageLanguage = String(message.Language || "").toLowerCase();
                speaker.textContent = messageLanguage === "en"
                    ? `${message.Speaker} · English original: `
                    : `${message.Speaker} · Original (${messageLanguage || "language not recorded"}): `;
                paragraph.appendChild(speaker);
                paragraph.appendChild(highlightedText(message, caseRecord));
                article.appendChild(paragraph);

                if (message.EnglishTranslation) {
                    const translation = document.createElement("p");
                    translation.className = "englishTranslation";
                    translation.textContent = `English translation: ${message.EnglishTranslation}`;
                    article.appendChild(translation);
                } else if (message.TranslationState === "translation_unavailable") {
                    const unavailable = document.createElement("p");
                    unavailable.className = "errorMessage";
                    unavailable.textContent = "English translation unavailable.";
                    article.appendChild(unavailable);
                }

                messages.appendChild(article);
            });
            if (requestedMessage) {
                requestedMessage.focus({ preventScroll: true });
                requestedMessage.scrollIntoView({
                    behavior: "smooth",
                    block: "center"
                });
            }
        } catch (error) {
            document.getElementById("automaticTranscriptIdentity").textContent =
                "Transcript identity could not be verified.";
            messages.textContent = error.message;
        }
    }

    function openLegacyFailureReview(caseRecord) {
        activeCaseRecord = null;
        document.getElementById("automaticCaseReportHeading").textContent =
            `${caseRecord.caseNumber} · historical analysis failure`;
        const identity = caseRecord.transcriptIdentity || {};
        document.getElementById("automaticCaseReportIdentity").textContent =
            `Participant code: ${identity.participantCode || "—"} · Session ID: ${identity.sessionId || "—"}`;
        const content = document.getElementById("automaticCaseReportContent");
        content.replaceChildren();

        const notice = document.createElement("p");
        notice.className = "automaticReanalysisWarning";
        notice.textContent =
            "This is a preserved failure from the historical all-in-one preliminary-analysis workflow. No case report from this attempt was accepted or made current. It does not block or determine the new staged Meaning Unit analysis.";

        const detailsHeading = document.createElement("h3");
        detailsHeading.textContent = "Recorded failure details";
        const details = document.createElement("dl");
        const detailRows = [
            ["Historical status", caseRecord.status || "failed"],
            ["Attempts recorded", caseRecord.attemptCount ?? "—"],
            ["Transcript completed", formatTimestamp(caseRecord.sourceCompletedAt)],
            ["Accepted report", "No — the rejected draft was not promoted or saved as a report"]
        ];
        detailRows.forEach(([labelText, value]) => {
            const term = document.createElement("dt");
            term.textContent = labelText;
            const description = document.createElement("dd");
            description.textContent = String(value);
            details.append(term, description);
        });

        const errorHeading = document.createElement("h3");
        errorHeading.textContent = "Original technical failure message";
        const error = document.createElement("p");
        error.className = "automaticReanalysisWarning";
        error.textContent = caseRecord.lastError
            || "No detailed failure message was retained for this historical attempt.";

        const explanation = document.createElement("p");
        explanation.textContent =
            "Labels such as CA1 or CA4 in an old failure message refer to positions in a rejected temporary draft. They are not accepted categories and therefore do not appear in a saved report. The preserved transcript remains the source for the current Stage 1 workflow.";

        const actions = document.createElement("div");
        actions.className = "actionRow";
        if (identity.sessionId) {
            const openTranscriptButton = document.createElement("button");
            openTranscriptButton.type = "button";
            openTranscriptButton.textContent = "Open preserved transcript";
            openTranscriptButton.addEventListener("click", () => {
                reportDialog.close();
                openTranscript(caseRecord, null, {
                    trigger: null,
                    label: `Historical failure · ${caseRecord.caseNumber}`
                });
            });
            actions.appendChild(openTranscriptButton);
        }

        content.append(
            notice,
            detailsHeading,
            details,
            errorHeading,
            error,
            explanation,
            actions
        );
        archiveButton.hidden = true;
        archiveButton.disabled = true;
        reportDialog.showModal();
    }

    function openCaseReport(caseRecord) {
        activeCaseRecord = caseRecord;
        document.getElementById("automaticCaseReportHeading").textContent =
            `${caseRecord.caseNumber} · individual case report`;
        const identity = caseRecord.transcriptIdentity;
        document.getElementById("automaticCaseReportIdentity").textContent =
            `Participant code: ${identity.participantCode} · Session ID: ${identity.sessionId}`;
        const content = document.getElementById("automaticCaseReportContent");
        content.replaceChildren();
        const lineageHeading = document.createElement("h3");
        lineageHeading.textContent = "Project and analysis lineage";
        const lineage = document.createElement("p");
        const project = caseRecord.researchProject;
        const framework = caseRecord.analysisFramework;
        const globalRules = caseRecord.globalAnalysisRules;
        lineage.textContent = project
            ? `Global analysis rules: ${globalRules ? `v${globalRules.version_number}` : "legacy version not recorded"} · Project: ${project.project_name} · Topic: ${project.research_topic} · Project analysis rules: ${framework ? `v${framework.version_number}` : "legacy version not recorded"} · Report: ${caseRecord.reportLineage?.reportId || "—"}${caseRecord.reportLineage?.sourceReportId ? ` · Source report: ${caseRecord.reportLineage.sourceReportId}` : ""}`
            : `Project/topic lineage unavailable · Analysis version: ${caseRecord.analysisVersion || "—"}`;
        const interpretationHeading = document.createElement("h3");
        interpretationHeading.textContent = "Case interpretation";
        const interpretation = document.createElement("p");
        interpretation.textContent = caseRecord.caseInterpretation;
        content.append(
            lineageHeading,
            lineage,
            interpretationHeading,
            interpretation
        );

        const themeHeading = document.createElement("h3");
        themeHeading.textContent = "Themes, categories, codes, and meaning units";
        content.appendChild(themeHeading);
        const codeById = new Map((caseRecord.codes || []).map(code => [
            code.id,
            code
        ]));
        const categoryById = new Map((caseRecord.categories || []).map(
            category => [category.id, category]
        ));
        const categoriesByTheme = (caseRecord.themeCategories || []).reduce(
            (groups, mapping) => {
                const values = groups.get(mapping.theme_id) || [];
                values.push(mapping.category_id);
                groups.set(mapping.theme_id, values);
                return groups;
            },
            new Map()
        );
        const codesByCategory = (caseRecord.categoryCodes || []).reduce(
            (groups, mapping) => {
                const values = groups.get(mapping.category_id) || [];
                values.push(mapping.code_id);
                groups.set(mapping.category_id, values);
                return groups;
            },
            new Map()
        );
        (caseRecord.themes || []).forEach(theme => {
            const section = document.createElement("section");
            const heading = document.createElement("h4");
            heading.textContent = `TH${theme.theme_number}: ${theme.theme_label}`;
            const rationale = document.createElement("p");
            rationale.textContent = theme.rationale;
            const list = document.createElement("ul");
            (categoriesByTheme.get(theme.id) || []).forEach(categoryId => {
                const category = categoryById.get(categoryId);
                if (!category) return;
                const item = document.createElement("li");
                const categoryLabel = document.createElement("strong");
                categoryLabel.textContent = `CA${category.category_number}: ${category.category_label}`;
                const codeList = document.createElement("ul");
                (codesByCategory.get(category.id) || []).forEach(codeId => {
                    const code = codeById.get(codeId);
                    if (!code) return;
                    const codeItem = document.createElement("li");
                    codeItem.textContent = `CO${code.code_number}: ${code.code_label} — ${code.rationale}`;
                    codeList.appendChild(codeItem);
                });
                item.append(categoryLabel, codeList);
                list.appendChild(item);
            });
            section.append(heading, rationale, list);
            content.appendChild(section);
        });
        const assignedCodeIds = new Set((caseRecord.categoryCodes || []).map(
            mapping => mapping.code_id
        ));
        const ungroupedCodes = (caseRecord.codes || []).filter(
            code => !assignedCodeIds.has(code.id)
        );
        if (ungroupedCodes.length) {
            const heading = document.createElement("h3");
            heading.textContent =
                "Firm codes retained without a category";
            const explanation = document.createElement("p");
            explanation.className = "automaticReanalysisWarning";
            explanation.textContent =
                "These evidence-supported codes are part of the completed result. PLI did not force an unsupported category.";
            const list = document.createElement("ul");
            ungroupedCodes.forEach(code => {
                const item = document.createElement("li");
                item.textContent = `CO${code.code_number}: ${code.code_label} — ${code.rationale}`;
                list.appendChild(item);
            });
            content.append(heading, explanation, list);
        }
        const themedCategoryIds = new Set((caseRecord.themeCategories || []).map(
            mapping => mapping.category_id
        ));
        const unthemedCategories = (caseRecord.categories || []).filter(
            category => !themedCategoryIds.has(category.id)
        );
        if (unthemedCategories.length) {
            const heading = document.createElement("h3");
            heading.textContent = "Firm categories retained without a theme";
            const list = document.createElement("ul");
            unthemedCategories.forEach(category => {
                const item = document.createElement("li");
                item.textContent = `CA${category.category_number}: ${category.category_label} — ${category.rationale}`;
                list.appendChild(item);
            });
            content.append(heading, list);
        }
        const hierarchyAudit = caseRecord.analysisHierarchyAudit;
        if (hierarchyAudit) {
            const heading = document.createElement("h3");
            heading.textContent = "Completed analytical hierarchy audit";
            const summary = document.createElement("p");
            summary.className = hierarchyAudit.complete
                ? "automaticReanalysisAudit"
                : "automaticReanalysisWarning";
            summary.textContent = `${(hierarchyAudit.checks || []).filter(
                check => check.accepted
            ).length}/${(hierarchyAudit.checks || []).length} themes passed patterned-meaning and category-support checks. ${(hierarchyAudit.unsynthesized || []).length} firm lower-level findings were retained without forced synthesis.`;
            content.append(heading, summary);
        }
        archiveButton.textContent = caseRecord.archivedAt
            ? "Restore to active analysis"
            : "Archive completed case";
        archiveButton.hidden = false;
        archiveButton.disabled = caseRecord.status !== "completed";
        reportDialog.showModal();
    }

    async function setArchiveState(caseRecord, shouldArchive) {
        let note = "";

        if (shouldArchive) {
            const entered = window.prompt(
                `Archive ${caseRecord.caseNumber}? It will disappear from active analysis. Add an optional note, or leave this blank.`
            );

            if (entered === null) return;
            note = entered.trim();
        } else if (!window.confirm(
            `Restore ${caseRecord.caseNumber} to active analysis?`
        )) {
            return;
        }

        setStatus(shouldArchive ? "Archiving case…" : "Restoring case…");
        const response = await fetch("/api/automatic-analysis", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: shouldArchive ? "archive" : "restore",
                sessionId: caseRecord.transcriptIdentity.sessionId,
                note
            })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            setStatus(data.error || "The archive could not be updated.", true);
            return;
        }

        if (reportDialog.open) reportDialog.close();
        activeCaseRecord = null;
        await load();
    }

    function csvValue(value) {
        return `"${String(value ?? "").replaceAll('"', '""')}"`;
    }

    function downloadCurrentForm() {
        const completed = casesForAnalysisForms().filter(
            item => item.hasReport
        );
        let rows;

        if (activeView === "archive") {
            const maximumCodes = Math.max(0, ...payload.cases.map(item =>
                Math.max(0, ...(item.codes || []).map(code => code.code_number))
            ));
            const maximumThemes = Math.max(0, ...payload.cases.map(item =>
                Math.max(0, ...(item.themes || []).map(theme => theme.theme_number))
            ));
            rows = [[
                "P#",
                "S#",
                "Archived",
                "Archive note",
                "Link to transcript",
                "Language",
                ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label),
                ...Array.from(
                    { length: maximumCodes },
                    (_, index) => `CO${index + 1}`
                ),
                ...Array.from(
                    { length: maximumThemes },
                    (_, index) => `TH${index + 1}`
                )
            ], ...payload.cases.map(item => [
                participantCode(item),
                sessionNumber(item),
                item.archivedAt || "",
                item.archiveNote || "",
                transcriptUrl(item),
                item.language || "—",
                ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([key]) =>
                    demographicValue(item, key)
                ),
                ...Array.from(
                    { length: maximumCodes },
                    (_, index) => (item.codes || []).find(
                        code => code.code_number === index + 1
                    )?.code_label || ""
                ),
                ...Array.from(
                    { length: maximumThemes },
                    (_, index) => (item.themes || []).find(
                        theme => theme.theme_number === index + 1
                    )?.theme_label || ""
                )
            ])];
        } else if (activeView === "incomplete") {
            rows = [[
                "P#",
                "S#",
                "Link to transcript",
                "Why it needs attention",
                "Brief partial-case summary",
                "Last activity",
                "Language",
                ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label)
            ], ...casesForAnalysisForms().map(item => [
                participantCode(item),
                sessionNumber(item),
                transcriptUrl(item),
                item.completionRemark || "Incomplete",
                item.briefSummary || "No recorded material",
                item.lastActivityAt || "",
                item.language || "—",
                ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([key]) =>
                    demographicValue(item, key)
                )
            ])];
        } else if (activeView === "cases") {
            const orderedCases = casesForAnalysisForms();
            rows = [[
                "P#",
                "S#",
                "Link to transcript",
                "Language",
                ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label),
                "Case report"
            ],
                ...orderedCases.map(item => [
                    participantCode(item),
                    sessionNumber(item),
                    transcriptUrl(item),
                    item.language || "—",
                    ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([key]) =>
                        demographicValue(item, key)
                    ),
                    item.hasReport ? "Available" : item.status
                ])];
        } else if (activeView === "keywords") {
            rows = [[
                "P#",
                "S#",
                "K#",
                "Exact keyword",
                "Evidence unit",
                "Exact transcript evidence",
                "CO",
                "CA",
                "TH",
                "Source message ID",
                "Transcript link",
                "Analysis status",
                "Project",
                "Topic",
                "Framework version",
                "Report ID"
            ]];
            completed.forEach(item => {
                const relations = analysisRelations(item);
                let keywordNumber = 0;
                analysisUnits(item).forEach((unit, unitIndex) => {
                    const codeIds = unit.legacy_code_id
                        ? [unit.legacy_code_id]
                        : relations.codeIdsByUnit.get(unit.id) || [];
                    const codes = uniqueRecords(codeIds, relations.codeById);
                    const categoryIds = [...new Set(codeIds.flatMap(
                        codeId => relations.categoryIdsByCode.get(codeId) || []
                    ))];
                    const categories = uniqueRecords(categoryIds, relations.categoryById);
                    const themes = uniqueRecords(categoryIds.flatMap(
                        categoryId => relations.themeIdsByCategory.get(categoryId) || []
                    ), relations.themeById);
                    keywordExpressions(unit).forEach(keyword => {
                        keywordNumber += 1;
                        rows.push([
                            participantCode(item),
                            sessionNumber(item),
                            `K${keywordNumber}`,
                            keyword,
                            unit.unit_number ? `MU${unit.unit_number}` : `MU${unitIndex + 1}`,
                            unit.exact_text || unit.english_translation || "",
                            codes.map(code => recordLabel(code, "code")).join(" | "),
                            categories.map(category => recordLabel(category, "category")).join(" | "),
                            themes.map(theme => recordLabel(theme, "theme")).join(" | "),
                            unit.message_id || "",
                            transcriptUrl(item),
                            item.status || "",
                            item.researchProject?.project_name || "",
                            item.researchProject?.research_topic || "",
                            item.analysisFramework?.version_number || "",
                            item.reportLineage?.reportId || ""
                        ]);
                    });
                });
            });
        } else if (activeView === "codes") {
            rows = [["P#", "S#", "CO#", "Code", "Keywords", "Categories", "Themes", "Rationale", "Transcript link", "Analysis status", "Project", "Topic", "Framework version", "Report ID"]];
            completed.forEach(item => {
                const relations = analysisRelations(item);
                (item.codes || []).forEach(code => {
                    const units = uniqueRecords(
                        relations.unitIdsByCode.get(code.id) || [],
                        relations.unitById
                    );
                    const categories = uniqueRecords(
                        relations.categoryIdsByCode.get(code.id) || [],
                        relations.categoryById
                    );
                    const themes = uniqueRecords(categories.flatMap(category =>
                        relations.themeIdsByCategory.get(category.id) || []
                    ), relations.themeById);
                    rows.push([
                        participantCode(item), sessionNumber(item), `CO${code.code_number}`,
                        recordLabel(code, "code"), compactKeywords(units),
                        categories.map(category => recordLabel(category, "category")).join(" | "),
                        themes.map(theme => recordLabel(theme, "theme")).join(" | "),
                        code.rationale || "", transcriptUrl(item), item.status || "",
                        item.researchProject?.project_name || "",
                        item.researchProject?.research_topic || "",
                        item.analysisFramework?.version_number || "",
                        item.reportLineage?.reportId || ""
                    ]);
                });
            });
        } else if (activeView === "themes") {
            rows = [["P#", "S#", "TH#", "Theme", "Categories", "Codes", "Keywords", "Rationale", "Transcript link", "Analysis status", "Project", "Topic", "Framework version", "Report ID"]];
            completed.forEach(item => {
                const relations = analysisRelations(item);
                (item.themes || []).forEach(theme => {
                    const categories = uniqueRecords(
                        relations.categoryIdsByTheme.get(theme.id) || [],
                        relations.categoryById
                    );
                    const codes = uniqueRecords(categories.flatMap(category =>
                        relations.codeIdsByCategory.get(category.id) || []
                    ), relations.codeById);
                    const units = uniqueRecords(codes.flatMap(code =>
                        relations.unitIdsByCode.get(code.id) || []
                    ), relations.unitById);
                    rows.push([
                        participantCode(item), sessionNumber(item), `TH${theme.theme_number}`,
                        recordLabel(theme, "theme"),
                        categories.map(category => recordLabel(category, "category")).join(" | "),
                        codes.map(code => recordLabel(code, "code")).join(" | "),
                        compactKeywords(units), theme.rationale || "", transcriptUrl(item),
                        item.status || "", item.researchProject?.project_name || "",
                        item.researchProject?.research_topic || "",
                        item.analysisFramework?.version_number || "",
                        item.reportLineage?.reportId || ""
                    ]);
                });
            });
        }

        const csv = rows.map(row => row.map(csvValue).join(",")).join("\r\n");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
        link.download = `PLI-${activeView}-form.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    async function fetchDashboardPage(requestedScope, page) {
        const requestUrl = new URL("/api/automatic-analysis", window.location.origin);
        requestUrl.searchParams.set("scope", requestedScope);
        requestUrl.searchParams.set("page", String(page));
        requestUrl.searchParams.set("fresh", `${Date.now()}-${page}`);
        const controller = new AbortController();
        const timeout = window.setTimeout(
            () => controller.abort(),
            DASHBOARD_REQUEST_TIMEOUT_MS
        );
        let response;

        try {
            response = await fetch(
                requestUrl,
                {
                    cache: "no-store",
                    headers: { Authorization: `Bearer ${token()}` },
                    signal: controller.signal
                }
            );
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(
                    "The dashboard request timed out. Please try unlocking again."
                );
            }
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Automatic case reports could not be loaded.");
        }

        return data;
    }

    async function fetchRemainingDashboardPages(requestedScope, pageCount) {
        const pages = Array.from(
            { length: Math.max(0, pageCount - 1) },
            (_, index) => index + 2
        );
        const results = new Array(pages.length);
        let nextIndex = 0;

        async function worker() {
            while (nextIndex < pages.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await fetchDashboardPage(
                    requestedScope,
                    pages[index]
                );
            }
        }

        await Promise.all(Array.from(
            {
                length: Math.min(
                    DASHBOARD_PAGE_CONCURRENCY,
                    pages.length
                )
            },
            () => worker()
        ));
        return results;
    }

    async function performLoad() {
        setStatus("Loading automatic case reports…");
        const requestedScope = activeView === "archive"
            ? "archived"
            : activeView === "incomplete"
                ? "incomplete"
                : "active";
        const firstPage = await fetchDashboardPage(requestedScope, 1);
        const totalCases = Object.values(firstPage.counts || {}).reduce(
            (total, value) => total + Number(value || 0),
            0
        );
        const pageSize = Math.max(1, Number(firstPage.pageSize) || 100);
        const pageCount = Math.ceil(totalCases / pageSize);
        const cases = [...(firstPage.cases || [])];

        payload = { ...firstPage, cases };
        loadedScope = requestedScope;
        gate.hidden = true;
        workspace.hidden = false;
        render();

        if (pageCount > 1) {
            setStatus(
                `Loaded ${cases.length} cases. Loading the remaining cases…`
            );
            const remainingPages = await fetchRemainingDashboardPages(
                requestedScope,
                pageCount
            );
            remainingPages.forEach(nextPage => {
                cases.push(...(nextPage.cases || []));
            });
        }

        payload = { ...firstPage, cases };
        render();
        openRequestedTranscript();
        setStatus(
            requestedScope === "archived"
                ? `${cases.length} archived cases.`
                : requestedScope === "incomplete"
                    ? `${cases.length} incomplete transcripts need attention. They remain separate from completed-transcript analysis.`
                : `${cases.filter(item => item.hasReport).length} active case reports are available. Historical all-in-one failures remain inspectable audit records and do not block the separate staged workflow.`
        );
    }

    function load() {
        if (loadPromise) return loadPromise;
        loadPromise = performLoad().finally(() => {
            loadPromise = null;
        });
        return loadPromise;
    }

    unlockButton.addEventListener("click", async () => {
            const entered = document.getElementById("automaticAnalysisToken").value;
            if (!entered.trim()) {
                setGateStatus("Enter the researcher dashboard token.", true);
                return;
            }
            sessionStorage.setItem(TOKEN_STORAGE_KEY, entered);
            unlockButton.disabled = true;
            unlockButton.textContent = "Unlocking…";
            setGateStatus("Checking the token and loading the newest reports…");
            try {
                await load();
                setGateStatus("");
                clearInterval(refreshTimer);
                refreshTimer = setInterval(() => load().catch(() => {}), 30000);
            } catch (error) {
                setGateStatus(error.message, true);
            } finally {
                unlockButton.disabled = false;
                unlockButton.textContent = "Unlock case analysis";
            }
        });
    document.getElementById("automaticAnalysisRefreshButton")
        .addEventListener("click", () => load().catch(error => setStatus(error.message, true)));
    document.getElementById("automaticAnalysisLockButton")
        .addEventListener("click", () => {
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            clearInterval(refreshTimer);
            gate.hidden = false;
            workspace.hidden = true;
        });
    document.getElementById("automaticAnalysisDownloadButton")
        .addEventListener("click", downloadCurrentForm);
    document.querySelectorAll("[data-automatic-analysis-view]")
        .forEach(button => button.addEventListener("click", async () => {
            activeView = button.dataset.automaticAnalysisView;
            const requestedScope = activeView === "archive"
                ? "archived"
                : activeView === "incomplete"
                    ? "incomplete"
                    : "active";
            if (requestedScope !== loadedScope) {
                await load().catch(error => setStatus(error.message, true));
            } else {
                render();
            }
        }));
    document.getElementById("automaticTranscriptCloseButton")
        .addEventListener("click", returnFromTranscript);
    dialog.addEventListener("cancel", event => {
        event.preventDefault();
        returnFromTranscript();
    });
    document.getElementById("automaticCaseReportCloseButton")
        .addEventListener("click", () => {
            activeCaseRecord = null;
            reportDialog.close();
        });
    archiveButton.addEventListener("click", () => {
        if (!activeCaseRecord) return;
        setArchiveState(activeCaseRecord, !activeCaseRecord.archivedAt)
            .catch(error => setStatus(error.message, true));
    });

    window.automaticAnalysisReviewBridge = Object.freeze({
        cases: () => payload.cases,
        openTranscriptForSession(sessionId) {
            const caseRecord = payload.cases.find(item =>
                item.transcriptIdentity?.sessionId === sessionId
            );
            if (caseRecord) openTranscript(caseRecord);
        },
        openReportForSession(sessionId) {
            const caseRecord = payload.cases.find(item =>
                item.transcriptIdentity?.sessionId === sessionId
            );
            if (caseRecord?.hasReport) openCaseReport(caseRecord);
        },
        refresh() {
            return load();
        },
        setStatus
    });

    if (token()) {
        document.getElementById("automaticAnalysisToken").value = token();
        load().then(() => {
            refreshTimer = setInterval(() => load().catch(() => {}), 30000);
        }).catch(() => {
            gate.hidden = false;
            workspace.hidden = true;
        });
    }
}());
