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
                    ? "Human review required"
                    : "Waiting";
        button.disabled = !caseRecord.hasReport;
        button.addEventListener("click", () => openCaseReport(caseRecord));
        return button;
    }

    function reviewSource(caseRecord, kind = "case", record = null) {
        const isTheme = kind === "theme";
        const isCode = kind === "code";
        const number = isTheme
            ? record?.theme_number
            : isCode
                ? record?.code_number
                : null;
        return {
            kind,
            sessionId: caseRecord.transcriptIdentity?.sessionId,
            caseNumber: caseRecord.caseNumber,
            participantCode: participantCode(caseRecord),
            position: number ? `${isTheme ? "T" : "C"}${number}` : "CASE",
            recordId: record?.id || null,
            label: isTheme
                ? record?.theme_label
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
        const orderedCases = casesForCaseAndKeywordForm();
        const maximumKeywords = Math.max(
            0,
            ...orderedCases.map(caseRecord =>
                caseRecord.keywordFrequency?.length || 0
            )
        );
        const { scroll, table } = createTable([
            ...COMPACT_IDENTIFIER_HEADERS,
            "Link to transcript",
            "Case report",
            "Archive",
            "AI discussion",
            "Language",
            ...FORM_ONE_DEMOGRAPHIC_COLUMNS.map(([, label]) => label),
            ...Array.from(
                { length: maximumKeywords },
                (_, index) => ({
                    label: `K${index + 1} · mention level`,
                    className: index === 0
                        ? "analysisKeywordColumn analysisPrimaryKeywordColumn"
                        : "analysisKeywordColumn"
                })
            )
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
            for (let index = 0; index < maximumKeywords; index += 1) {
                const keyword = caseRecord.keywordFrequency?.[index];
                const cell = createCell(
                    row,
                    keyword
                        ? `${keyword.count} mention${
                            keyword.count === 1 ? "" : "s"
                        } each · ${keyword.text}`
                        : "—",
                    index === 0
                        ? "analysisKeywordColumn analysisPrimaryKeywordColumn"
                        : "analysisKeywordColumn"
                );
                if (keyword) {
                    const sourceMessageIds = [...new Set(
                        (keyword.items || []).flatMap(item =>
                            item.sourceMessageIds || []
                        )
                    )];
                    cell.title = [
                        `${keyword.count} validated occurrence${
                            keyword.count === 1 ? "" : "s"
                        } for each tied keyword.`,
                        keyword.originalText
                            ? `Original evidence: ${keyword.originalText}`
                            : "",
                        sourceMessageIds.length
                            ? `Source message ID${sourceMessageIds.length === 1 ? "" : "s"}: ${
                                sourceMessageIds.join(", ")
                            }`
                            : ""
                    ].filter(Boolean).join("\n");
                } else {
                    cell.className = "analysisEmptyCell";
                }
            }
            body.appendChild(row);
        });

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

        casesForCaseAndKeywordForm().forEach(caseRecord => {
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
            ...COMPACT_IDENTIFIER_HEADERS,
            ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)
        ]);
        const body = document.createElement("tbody");

        completed.forEach(caseRecord => {
            const row = document.createElement("tr");
            createIdentifierCells(row, caseRecord);
            const byNumber = (caseRecord[recordsKey] || []).reduce(
                (groups, record) => {
                    const values = groups.get(record[numberKey]) || [];
                    values.push(record);
                    groups.set(record[numberKey], values);
                    return groups;
                },
                new Map()
            );

            for (let number = 1; number <= maximum; number += 1) {
                const records = byNumber.get(number) || [];
                const cell = document.createElement("td");

                if (records.length) {
                    records.forEach(record => {
                        const line = document.createElement("div");
                        const button = document.createElement("button");
                        button.type = "button";
                        button.className = "worksheetExpressionButton";
                        button.textContent = record[labelKey];
                        button.title = `${record.rationale}\n\nClick to add this participant-local ${prefix}${number} source to the second-layer AI discussion.`;
                        button.addEventListener("click", () =>
                            sendSourceToReview(
                                caseRecord,
                                kind === "themes" ? "theme" : "code",
                                record
                            )
                        );
                        line.appendChild(button);
                        cell.appendChild(line);
                    });
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
                (_, index) => `C${index + 1}`
            ),
            ...Array.from(
                { length: maximumThemes },
                (_, index) => `T${index + 1}`
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
        document.getElementById("automaticAnalysisIncompleteCount").textContent =
            counts.incomplete || 0;

        if (activeView === "archive") {
            renderArchive();
        } else if (activeView === "incomplete") {
            renderIncomplete();
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
                ? `Form 1: ${completedCases.length} available case reports are shown first in permanent participant-code order, matching Forms 2 and 3. ${casesWithMarkedKeywords} reports currently have validated keyword evidence, grouped into equal mention-count levels with deterministic alphabetical ordering inside each tie. Use Archive on a completed row to remove it from active analysis; it can later be restored from the Archive tab. Transcripts awaiting their first report remain available below them in the same stable order.`
                : activeView === "codes"
                    ? "Form 2: each case starts at C1. Total validated mentions are the sole grading criterion; equal-mention codes share one rank cell and are ordered alphabetically inside that tied group. Distinct keyword counts remain reference metadata only."
                    : activeView === "themes"
                        ? "Form 3: each case starts at T1. Total validated mentions are the sole grading criterion; equal-mention themes share one rank cell and are ordered alphabetically inside that tied group. Supporting-code and distinct-keyword counts remain reference metadata only."
                        : activeView === "incomplete"
                            ? "Form 4 · Needs attention: unfinished interviews are separate from Forms 1–3. Each row preserves its transcript and separated demographic fields, summarizes only the material actually recorded, and states how incomplete the interview is. No themes, codes, or keywords are assigned before formal completion."
                            : "Archived cases are excluded from every active analysis form and from future automatic reanalysis. Each archived row preserves its transcript, report, language, demographic columns, mention-ranked C1–Cn code groups, mention-ranked T1–Tn theme groups, and archive history.";
        window.dispatchEvent(new CustomEvent("automatic-analysis-review-ready"));
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
                    (_, index) => `C${index + 1}`
                ),
                ...Array.from(
                    { length: maximumThemes },
                    (_, index) => `T${index + 1}`
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
            ], ...casesForCaseAndKeywordForm().map(item => [
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
            const orderedCases = casesForCaseAndKeywordForm();
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
        } else {
            const recordsKey = activeView;
            const isCodes = activeView === "codes";
            const prefix = isCodes ? "C" : "T";
            const numberKey = isCodes ? "code_number" : "theme_number";
            const labelKey = isCodes ? "code_label" : "theme_label";
            const maximum = Math.max(0, ...completed.map(item =>
                Math.max(0, ...(item[recordsKey] || []).map(record => record[numberKey]))
            ));
            rows = [["P#", "S#", ...Array.from({ length: maximum }, (_, index) => `${prefix}${index + 1}`)],
                ...completed.map(item => {
                    const records = (item[recordsKey] || []).reduce(
                        (groups, record) => {
                            const values = groups.get(record[numberKey]) || [];
                            values.push(record[labelKey]);
                            groups.set(record[numberKey], values);
                            return groups;
                        },
                        new Map()
                    );
                    return [participantCode(item), sessionNumber(item), ...Array.from(
                        { length: maximum },
                        (_, index) => (records.get(index + 1) || []).join(" | ")
                    )];
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
                    : `${cases.filter(item => item.hasReport).length} active case reports are available. Retryable cases may pause briefly; later completed cases continue while exhausted failures remain marked for human review.`
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
