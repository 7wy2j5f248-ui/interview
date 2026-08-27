(function initializeAutomaticCaseAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
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
        button.textContent = caseRecord.transcriptIdentity?.sessionId
            ? "Open transcript"
            : "Transcript unavailable";
        button.disabled = !caseRecord.transcriptIdentity?.sessionId;
        button.addEventListener("click", () => openTranscript(caseRecord));
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
                    ? "Needs attention"
                    : "Waiting";
        button.disabled = !caseRecord.hasReport;
        button.addEventListener("click", () => openCaseReport(caseRecord));
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

    function casesForCaseAndKeywordForm() {
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
        const { scroll, table } = createTable([
            "Participant code",
            "Session number",
            "Link to transcript",
            "Case report",
            "Archive",
            "Language",
            ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label)
        ]);
        const body = document.createElement("tbody");

        casesForCaseAndKeywordForm().forEach(caseRecord => {
            const row = document.createElement("tr");
            createCell(row, participantCode(caseRecord), "analysisIdentifierCell");
            createCell(row, sessionNumber(caseRecord), "analysisIdentifierCell");
            const transcriptCell = document.createElement("td");
            transcriptCell.appendChild(transcriptButton(caseRecord));
            row.appendChild(transcriptCell);
            const reportCell = document.createElement("td");
            reportCell.appendChild(caseReportButton(caseRecord));
            row.appendChild(reportCell);
            const archiveCell = document.createElement("td");
            archiveCell.appendChild(archiveCaseButton(caseRecord));
            row.appendChild(archiveCell);
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

    function renderMatrix(kind) {
        const completed = casesForCaseAndKeywordForm().filter(
            item => item.hasReport
        );
        const recordsKey = kind === "codes" ? "codes" : "themes";
        const prefix = kind === "codes" ? "C" : "T";
        const numberKey = kind === "codes" ? "code_number" : "theme_number";
        const labelKey = kind === "codes" ? "code_label" : "theme_label";
        const maximum = Math.max(0, ...completed.map(item =>
            Math.max(0, ...(item[recordsKey] || []).map(record => record[numberKey]))
        ));
        const { scroll, table } = createTable([
            "Participant code",
            "Session number",
            ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)
        ]);
        const body = document.createElement("tbody");

        completed.forEach(caseRecord => {
            const row = document.createElement("tr");
            createCell(row, participantCode(caseRecord), "analysisIdentifierCell");
            createCell(row, sessionNumber(caseRecord), "analysisIdentifierCell");
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

    function formatTimestamp(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? displayValue(value)
            : date.toLocaleString();
    }

    function renderArchive() {
        const { scroll, table } = createTable([
            "Participant code",
            "Session number",
            "Archived",
            "Archive note",
            "Link to transcript",
            "Case report",
            "Action"
        ]);
        const body = document.createElement("tbody");

        payload.cases.forEach(caseRecord => {
            const row = document.createElement("tr");
            createCell(row, participantCode(caseRecord), "analysisIdentifierCell");
            createCell(row, sessionNumber(caseRecord), "analysisIdentifierCell");
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
            body.appendChild(row);
        });

        table.appendChild(body);
        tableHost.replaceChildren(scroll);
    }

    function render() {
        const counts = payload.counts || {};
        const completedCases = casesForCaseAndKeywordForm().filter(
            caseRecord => caseRecord.hasReport
        );
        const casesWithMarkedKeywords = completedCases.filter(
            caseRecord => (caseRecord.highlights || []).length > 0
        ).length;
        ["pending", "processing", "failed"].forEach(key => {
            document.getElementById(
                `automaticAnalysis${key[0].toUpperCase()}${key.slice(1)}Count`
            ).textContent = counts[key] || 0;
        });
        document.getElementById("automaticAnalysisCompletedCount").textContent =
            completedCases.length;

        if (activeView === "archive") {
            renderArchive();
        } else if (activeView === "cases") {
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
                ? `Form 1: ${completedCases.length} available case reports are shown first in permanent participant-code order, matching Forms 2 and 3. ${casesWithMarkedKeywords} reports currently have marked keywords. Use Archive on a completed row to remove it from active analysis; it can later be restored from the Archive tab. Transcripts awaiting their first report remain available below them in the same stable order.`
                : activeView === "codes"
                    ? "Form 2: each case starts at C1. Headers are positional only; participant-specific code content stays inside cells."
                    : activeView === "themes"
                        ? "Form 3: each case starts at T1. Headers are positional only; participant-specific theme content stays inside cells."
                        : "Archived cases are excluded from every active analysis form and from future automatic reanalysis. Their transcripts, reports, and archive history remain available here.";
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

    async function openTranscript(caseRecord) {
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
            item.textContent = `C${code.code_number}: ${code.code_label}`;
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
            (data.messages || []).forEach(message => {
                const article = document.createElement("article");
                article.className = "message";
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
        } catch (error) {
            document.getElementById("automaticTranscriptIdentity").textContent =
                "Transcript identity could not be verified.";
            messages.textContent = error.message;
        }
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
        archiveButton.textContent = caseRecord.archivedAt
            ? "Restore to active analysis"
            : "Archive completed case";
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
        const completed = casesForCaseAndKeywordForm().filter(
            item => item.hasReport
        );
        let rows;

        if (activeView === "archive") {
            rows = [[
                "Participant code",
                "Session number",
                "Archived",
                "Archive note",
                "Link to transcript"
            ], ...payload.cases.map(item => [
                participantCode(item),
                sessionNumber(item),
                item.archivedAt || "",
                item.archiveNote || "",
                transcriptUrl(item)
            ])];
        } else if (activeView === "cases") {
            const orderedCases = casesForCaseAndKeywordForm();
            rows = [[
                "Participant code",
                "Session number",
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
        } else {
            const recordsKey = activeView;
            const isCodes = activeView === "codes";
            const prefix = isCodes ? "C" : "T";
            const numberKey = isCodes ? "code_number" : "theme_number";
            const labelKey = isCodes ? "code_label" : "theme_label";
            const maximum = Math.max(0, ...completed.map(item =>
                Math.max(0, ...(item[recordsKey] || []).map(record => record[numberKey]))
            ));
            rows = [["Participant code", "Session number", ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)],
                ...completed.map(item => {
                    const records = new Map((item[recordsKey] || []).map(record => [record[numberKey], record[labelKey]]));
                    return [participantCode(item), sessionNumber(item), ...Array.from({ length: maximum }, (_, index) => records.get(index + 1) || "")];
                })];
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
        const response = await fetch(
            requestUrl,
            {
                cache: "no-store",
                headers: { Authorization: `Bearer ${token()}` }
            }
        );
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Automatic case reports could not be loaded.");
        }

        return data;
    }

    async function performLoad() {
        setStatus("Loading automatic case reports…");
        const requestedScope = activeView === "archive"
            ? "archived"
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
            const remainingPages = await Promise.all(
                Array.from(
                    { length: pageCount - 1 },
                    (_, index) => fetchDashboardPage(requestedScope, index + 2)
                )
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
                : `${cases.filter(item => item.hasReport).length} active case reports are available. The queue always processes the earliest completed transcript first.`
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
                : "active";
            if (requestedScope !== loadedScope) {
                await load().catch(error => setStatus(error.message, true));
            } else {
                render();
            }
        }));
    document.getElementById("automaticTranscriptCloseButton")
        .addEventListener("click", () => dialog.close());
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
