(function initializeAutomaticCaseAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const STANDARD_DEMOGRAPHIC_COLUMNS = Object.freeze([
        ["current_country", "Current country"],
        ["current_region", "Current region"],
        ["country_of_origin", "Country of origin"],
        ["diaspora_status", "Diaspora status"],
        ["gender", "Gender"],
        ["age", "Age"],
        ["birth_year", "Birth year"],
        ["birth_cohort", "Birth cohort"],
        ["youth_status", "Youth status"],
        ["education_level", "Education"],
        ["social_identity", "Social identity"]
    ]);
    let payload = { counts: {}, cases: [] };
    let activeView = "cases";
    let refreshTimer = null;

    const gate = document.getElementById("automaticAnalysisTokenGate");
    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const status = document.getElementById("automaticAnalysisStatus");
    const tableHost = document.getElementById("automaticAnalysisTable");
    const dialog = document.getElementById("automaticTranscriptDialog");
    const reportDialog = document.getElementById("automaticCaseReportDialog");

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function setStatus(text, isError = false) {
        status.textContent = text;
        status.className = isError ? "errorMessage" : "muted";
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

    function titleFromKey(key) {
        return key.replaceAll("_", " ").replace(
            /^./,
            character => character.toUpperCase()
        );
    }

    function demographicColumns() {
        const additionalKeys = [...new Set(payload.cases.flatMap(item =>
            Object.keys(item.demographics?.additional_descriptors || {})
        ))].sort();

        return [
            ...STANDARD_DEMOGRAPHIC_COLUMNS.map(([key, label]) => ({
                key,
                label,
                additional: false
            })),
            ...additionalKeys.map(key => ({
                key,
                label: titleFromKey(key),
                additional: true
            }))
        ];
    }

    function demographicValue(caseRecord, column) {
        const value = column.additional
            ? caseRecord.demographics?.additional_descriptors?.[column.key]
            : caseRecord.demographics?.[column.key];
        return displayValue(value);
    }

    function createCell(row, value, className = "") {
        const cell = document.createElement("td");
        cell.textContent = value;
        cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function createTable(headers) {
        const scroll = document.createElement("div");
        scroll.className = "tableScroll";
        const table = document.createElement("table");
        table.className = "analysisTable automaticAnalysisTable";
        const head = document.createElement("thead");
        const row = document.createElement("tr");

        headers.forEach(header => {
            const cell = document.createElement("th");
            cell.scope = "col";
            cell.textContent = header;
            row.appendChild(cell);
        });

        head.appendChild(row);
        table.appendChild(head);
        scroll.appendChild(table);
        return { scroll, table };
    }

    function transcriptButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = "Open annotated transcript";
        button.disabled = caseRecord.status !== "completed";
        button.addEventListener("click", () => openTranscript(caseRecord));
        return button;
    }

    function caseReportButton(caseRecord) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "worksheetTranscriptButton";
        button.textContent = caseRecord.status === "completed"
            ? "Open case report"
            : caseRecord.status === "processing"
                ? "Analysing"
                : caseRecord.status === "failed"
                    ? "Needs attention"
                    : "Waiting";
        button.disabled = caseRecord.status !== "completed";
        button.addEventListener("click", () => openCaseReport(caseRecord));
        return button;
    }

    function renderCases() {
        const columns = demographicColumns();
        const { scroll, table } = createTable([
            "Case number",
            "Language",
            ...columns.map(column => column.label),
            "Case report",
            "Annotated transcript"
        ]);
        const body = document.createElement("tbody");

        payload.cases.forEach(caseRecord => {
            const row = document.createElement("tr");
            createCell(row, caseRecord.caseNumber, "analysisIdentifierCell");
            createCell(row, caseRecord.language || "—");
            columns.forEach(column => createCell(
                row,
                demographicValue(caseRecord, column)
            ));
            const reportCell = document.createElement("td");
            reportCell.appendChild(caseReportButton(caseRecord));
            row.appendChild(reportCell);
            const transcriptCell = document.createElement("td");
            transcriptCell.appendChild(transcriptButton(caseRecord));
            row.appendChild(transcriptCell);
            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function renderMatrix(kind) {
        const completed = payload.cases.filter(item => item.status === "completed");
        const recordsKey = kind === "codes" ? "codes" : "themes";
        const prefix = kind === "codes" ? "C" : "T";
        const numberKey = kind === "codes" ? "code_number" : "theme_number";
        const labelKey = kind === "codes" ? "code_label" : "theme_label";
        const maximum = Math.max(0, ...completed.map(item =>
            Math.max(0, ...(item[recordsKey] || []).map(record => record[numberKey]))
        ));
        const { scroll, table } = createTable([
            "Case number",
            ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)
        ]);
        const body = document.createElement("tbody");

        completed.forEach(caseRecord => {
            const row = document.createElement("tr");
            createCell(row, caseRecord.caseNumber, "analysisIdentifierCell");
            const byNumber = new Map((caseRecord[recordsKey] || []).map(record => [
                record[numberKey],
                record
            ]));

            for (let number = 1; number <= maximum; number += 1) {
                const record = byNumber.get(number);
                const cell = document.createElement("td");

                if (record) {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "worksheetExpressionButton";
                    button.textContent = record[labelKey];
                    button.title = record.rationale;
                    button.addEventListener("click", () => openTranscript(caseRecord));
                    cell.appendChild(button);
                } else {
                    cell.textContent = "—";
                    cell.className = "analysisEmptyCell";
                }

                row.appendChild(cell);
            }

            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function render() {
        const counts = payload.counts || {};
        ["pending", "processing", "completed", "failed"].forEach(key => {
            document.getElementById(
                `automaticAnalysis${key[0].toUpperCase()}${key.slice(1)}Count`
            ).textContent = counts[key] || 0;
        });

        if (activeView === "cases") {
            renderCases();
        } else {
            renderMatrix(activeView);
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
                ? "Form 1: demographic data and the transcript with exact keyword evidence highlighted by code colour."
                : activeView === "codes"
                    ? "Form 2: each case starts at C1. Headers are positional only; participant-specific code content stays inside cells."
                    : "Form 3: each case starts at T1. Headers are positional only; participant-specific theme content stays inside cells.";
    }

    function highlightedText(message, caseRecord) {
        const text = message.Message || "";
        const codeById = new Map((caseRecord.codes || []).map(code => [code.id, code]));
        const highlights = (caseRecord.highlights || [])
            .filter(item => item.message_id === message.id)
            .sort((left, right) => left.start_offset - right.start_offset);
        const fragment = document.createDocumentFragment();
        let cursor = 0;

        highlights.forEach(item => {
            if (item.start_offset < cursor || item.end_offset > text.length) {
                return;
            }

            fragment.append(document.createTextNode(text.slice(cursor, item.start_offset)));
            const mark = document.createElement("mark");
            const code = codeById.get(item.code_id);
            mark.className = `keywordColor${code?.color_slot || 1}`;
            mark.textContent = text.slice(item.start_offset, item.end_offset);
            mark.title = code ? `C${code.code_number}: ${code.code_label}` : "Keyword";
            fragment.append(mark);
            cursor = item.end_offset;
        });

        fragment.append(document.createTextNode(text.slice(cursor)));
        return fragment;
    }

    function openTranscript(caseRecord) {
        document.getElementById("automaticTranscriptHeading").textContent =
            `${caseRecord.caseNumber} · annotated transcript`;
        const identity = caseRecord.transcriptIdentity;
        document.getElementById("automaticTranscriptIdentity").textContent =
            `Participant code: ${identity.participantCode} · Participant ID: ${identity.participantId} · Session ID: ${identity.sessionId}`;
        document.getElementById("automaticTranscriptDemographics").textContent =
            demographicsText(caseRecord.demographics);
        const legend = document.getElementById("automaticTranscriptLegend");
        legend.replaceChildren();
        (caseRecord.codes || []).forEach(code => {
            const item = document.createElement("span");
            item.className = `keywordLegend keywordColor${code.color_slot}`;
            item.textContent = `C${code.code_number}: ${code.code_label}`;
            item.title = code.rationale;
            legend.appendChild(item);
        });
        const messages = document.getElementById("automaticTranscriptMessages");
        messages.replaceChildren();
        (caseRecord.transcript || []).forEach(message => {
            const article = document.createElement("article");
            article.className = "message";
            const paragraph = document.createElement("p");
            const speaker = document.createElement("strong");
            speaker.textContent = `${message.Speaker}: `;
            paragraph.appendChild(speaker);
            paragraph.appendChild(highlightedText(message, caseRecord));
            article.appendChild(paragraph);

            if (message.EnglishTranslation) {
                const translation = document.createElement("p");
                translation.className = "englishTranslation";
                translation.textContent = `English translation: ${message.EnglishTranslation}`;
                article.appendChild(translation);
            }

            messages.appendChild(article);
        });
        dialog.showModal();
    }

    function openCaseReport(caseRecord) {
        document.getElementById("automaticCaseReportHeading").textContent =
            `${caseRecord.caseNumber} · individual case report`;
        const identity = caseRecord.transcriptIdentity;
        document.getElementById("automaticCaseReportIdentity").textContent =
            `Participant code: ${identity.participantCode} · Session ID: ${identity.sessionId}`;
        const content = document.getElementById("automaticCaseReportContent");
        content.replaceChildren();
        const interpretationHeading = document.createElement("h3");
        interpretationHeading.textContent = "Case interpretation";
        const interpretation = document.createElement("p");
        interpretation.textContent = caseRecord.caseInterpretation;
        content.append(interpretationHeading, interpretation);

        const themeHeading = document.createElement("h3");
        themeHeading.textContent = "Themes and codes";
        content.appendChild(themeHeading);
        const codeById = new Map((caseRecord.codes || []).map(code => [
            code.id,
            code
        ]));
        const mappingsByTheme = (caseRecord.themeCodes || []).reduce(
            (groups, mapping) => {
                const values = groups.get(mapping.theme_id) || [];
                values.push(mapping.code_id);
                groups.set(mapping.theme_id, values);
                return groups;
            },
            new Map()
        );
        (caseRecord.themes || []).forEach(theme => {
            const section = document.createElement("section");
            const heading = document.createElement("h4");
            heading.textContent = `T${theme.theme_number}: ${theme.theme_label}`;
            const rationale = document.createElement("p");
            rationale.textContent = theme.rationale;
            const list = document.createElement("ul");
            (mappingsByTheme.get(theme.id) || []).forEach(codeId => {
                const code = codeById.get(codeId);
                if (!code) return;
                const item = document.createElement("li");
                item.textContent = `C${code.code_number}: ${code.code_label} — ${code.rationale}`;
                list.appendChild(item);
            });
            section.append(heading, rationale, list);
            content.appendChild(section);
        });
        reportDialog.showModal();
    }

    function csvValue(value) {
        return `"${String(value ?? "").replaceAll('"', '""')}"`;
    }

    function downloadCurrentForm() {
        const completed = payload.cases.filter(item => item.status === "completed");
        let rows;

        if (activeView === "cases") {
            const columns = demographicColumns();
            rows = [[
                "Case number",
                "Language",
                ...columns.map(column => column.label),
                "Case report"
            ],
                ...payload.cases.map(item => [
                    item.caseNumber,
                    item.language || "",
                    ...columns.map(column => demographicValue(item, column)),
                    item.status === "completed" ? "Available" : item.status
                ])];
        } else {
            const recordsKey = activeView;
            const isCodes = activeView === "codes";
            const prefix = isCodes ? "C" : "T";
            const numberKey = isCodes ? "code_number" : "theme_number";
            const labelKey = isCodes ? "code_label" : "theme_label";
            const maximum = Math.max(0, ...completed.map(item =>
                Math.max(0, ...(item[recordsKey] || []).map(record => record[numberKey]))
            ));
            rows = [["Case number", ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)],
                ...completed.map(item => {
                    const records = new Map((item[recordsKey] || []).map(record => [record[numberKey], record[labelKey]]));
                    return [item.caseNumber, ...Array.from({ length: maximum }, (_, index) => records.get(index + 1) || "")];
                })];
        }

        const csv = rows.map(row => row.map(csvValue).join(",")).join("\r\n");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
        link.download = `PLI-${activeView}-form.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    async function load() {
        setStatus("Loading automatic case reports…");
        const response = await fetch("/api/automatic-analysis", {
            headers: { Authorization: `Bearer ${token()}` }
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Automatic case reports could not be loaded.");
        }

        payload = data;
        gate.hidden = true;
        workspace.hidden = false;
        render();
        setStatus(
            `${data.counts.completed || 0} complete case reports. The queue always processes the earliest completed transcript first.`
        );
    }

    document.getElementById("automaticAnalysisUnlockButton")
        .addEventListener("click", async () => {
            const entered = document.getElementById("automaticAnalysisToken").value;
            sessionStorage.setItem(TOKEN_STORAGE_KEY, entered);
            try {
                await load();
                clearInterval(refreshTimer);
                refreshTimer = setInterval(() => load().catch(() => {}), 30000);
            } catch (error) {
                setStatus(error.message, true);
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
        .forEach(button => button.addEventListener("click", () => {
            activeView = button.dataset.automaticAnalysisView;
            render();
        }));
    document.getElementById("automaticTranscriptCloseButton")
        .addEventListener("click", () => dialog.close());
    document.getElementById("automaticCaseReportCloseButton")
        .addEventListener("click", () => reportDialog.close());

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
