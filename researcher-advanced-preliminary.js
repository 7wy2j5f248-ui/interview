(function initializeAdvancedPreliminaryAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const API_PATH = "/api/automatic-analysis?view=advanced-preliminary";
    const section = document.getElementById("advancedPreliminaryAnalysis");
    if (!section) return;

    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const status = document.getElementById("advancedPreliminaryStatus");
    const provenance = document.getElementById("advancedPreliminaryProvenance");
    const tableHost = document.getElementById("advancedPreliminaryTable");
    const startButton = document.getElementById("advancedPreliminaryStartButton");
    const refreshButton = document.getElementById("advancedPreliminaryRefreshButton");
    const previousButton = document.getElementById("advancedPreliminaryPreviousPage");
    const nextButton = document.getElementById("advancedPreliminaryNextPage");
    const pageLabel = document.getElementById("advancedPreliminaryPageLabel");
    const dialog = document.getElementById("advancedPreliminaryDialog");
    const dialogHeading = document.getElementById("advancedPreliminaryDialogHeading");
    const dialogProvenance = document.getElementById("advancedPreliminaryDialogProvenance");
    const dialogContent = document.getElementById("advancedPreliminaryDialogContent");
    let payload = { run: null, cases: [], page: 1, pageSize: 50 };
    let page = 1;
    let loading = false;
    let refreshTimer = null;

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function setStatus(message, isError = false) {
        status.textContent = message;
        status.className = isError
            ? "errorMessage"
            : "automaticReviewScopeSummary";
    }

    async function request(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                Authorization: `Bearer ${token()}`,
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(options.headers || {})
            },
            cache: "no-store"
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(body.error || `Request failed with ${response.status}.`);
        }
        return body;
    }

    function cell(row, value) {
        const element = document.createElement("td");
        element.textContent = value === null || value === undefined || value === ""
            ? "—" : String(value);
        row.appendChild(element);
        return element;
    }

    function table(headers) {
        const scroll = document.createElement("div");
        scroll.className = "tableScroll";
        const element = document.createElement("table");
        element.className = "analysisTable automaticAnalysisTable";
        const head = document.createElement("thead");
        const row = document.createElement("tr");
        headers.forEach(label => {
            const header = document.createElement("th");
            header.scope = "col";
            header.textContent = label;
            row.appendChild(header);
        });
        head.appendChild(row);
        element.appendChild(head);
        scroll.appendChild(element);
        return { scroll, element };
    }

    function render() {
        tableHost.replaceChildren();
        const run = payload.run;
        [
            ["advancedPreliminaryPending", run?.pending_count || 0],
            ["advancedPreliminaryProcessing", run?.processing_count || 0],
            ["advancedPreliminaryCompleted", run?.completed_count || 0],
            ["advancedPreliminaryFailed", run?.failed_count || 0]
        ].forEach(([id, value]) => {
            document.getElementById(id).textContent = value;
        });

        if (!run) {
            provenance.textContent = "No advanced preliminary analysis run has been created yet.";
            startButton.disabled = false;
            previousButton.disabled = true;
            nextButton.disabled = true;
            return;
        }

        provenance.textContent = [
            `Run ${run.run_number}`,
            `${run.provider} / requested ${run.model}`,
            `resolved ${run.resolved_model || "not recorded"}`,
            `reasoning ${run.reasoning_effort}`,
            `analysis ${run.analysis_version}`,
            `prompt ${run.prompt_version}`,
            `stop layer ${run.stop_layer}`,
            `model verified ${run.model_verified_at || "not verified"}`
        ].join(" · ");
        startButton.disabled = ["queued", "processing"].includes(run.status);
        setStatus(
            `Advanced run ${run.run_number}: ${run.status.replaceAll("_", " ")}. `
            + `${run.completed_count} of ${run.source_case_count} cases completed. `
            + "Previous reports remain preserved and current."
        );

        const built = table([
            "Case ID", "Project lineage", "Status", "Meaning Units",
            "Preliminary Codes", "Preliminary Categories", "Inspect"
        ]);
        const body = document.createElement("tbody");
        payload.cases.forEach(item => {
            const row = document.createElement("tr");
            cell(row, item.case_number);
            cell(row, item.project_binding_status === "project_bound"
                ? "Project-bound" : "Historical unbound");
            cell(row, item.status === "failed"
                ? `Needs attention${item.last_error ? `: ${item.last_error}` : ""}`
                : item.status.replaceAll("_", " "));
            cell(row, item.report?.meaningUnitCount ?? "—");
            cell(row, item.report?.codeCount ?? "—");
            cell(row, item.report?.categoryCount ?? "—");
            const action = document.createElement("td");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = item.report
                ? "Inspect MU → Code → Category"
                : item.status === "processing" ? "Processing" : "Not ready";
            button.disabled = !item.report;
            button.addEventListener("click", () => openCase(item.case_number));
            action.appendChild(button);
            row.appendChild(action);
            body.appendChild(row);
        });
        built.element.appendChild(body);
        tableHost.appendChild(built.scroll);
        pageLabel.textContent = `Page ${payload.page}`;
        previousButton.disabled = payload.page <= 1;
        nextButton.disabled = payload.page * payload.pageSize
            >= run.source_case_count;
    }

    async function load({ quiet = false } = {}) {
        if (loading || !token() || workspace?.hidden) return;
        loading = true;
        if (!quiet) setStatus("Loading the advanced preliminary run…");
        try {
            payload = await request(`${API_PATH}&page=${page}&_=${Date.now()}`);
            render();
            clearTimeout(refreshTimer);
            if (["queued", "processing"].includes(payload.run?.status)) {
                refreshTimer = setTimeout(() => load({ quiet: true }), 30000);
            }
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            loading = false;
        }
    }

    function heading(text) {
        const element = document.createElement("h3");
        element.textContent = text;
        return element;
    }

    function paragraph(text, className = "") {
        const element = document.createElement("p");
        element.textContent = text;
        element.className = className;
        return element;
    }

    function listLabels(records, numberKey, labelKey, prefix) {
        if (!records?.length) return "None recorded";
        return records.map(record =>
            `${prefix}${record[numberKey]} ${record[labelKey]}`
        ).join("; ");
    }

    function meaningUnitBlock(unit, transcriptById) {
        const container = document.createElement("blockquote");
        const source = transcriptById.get(unit.message_id);
        container.appendChild(paragraph(
            `MU${unit.unit_number} · stable ID ${unit.id} · message ${unit.message_id}`,
            "muted"
        ));
        container.appendChild(paragraph(`Original: ${unit.exact_source_text}`));
        if (source?.EnglishTranslation
            && source.EnglishTranslation !== source.Message) {
            container.appendChild(paragraph(
                `English message translation: ${source.EnglishTranslation}`,
                "muted"
            ));
        }
        container.appendChild(paragraph(
            `Transcript offsets ${unit.start_offset}–${unit.end_offset}; occurrence ${unit.occurrence_index}.`,
            "muted"
        ));
        return container;
    }

    function codeColorSlot(codeNumber) {
        const numeric = Number.parseInt(codeNumber, 10);
        return Number.isFinite(numeric) && numeric > 0
            ? ((numeric - 1) % 12) + 1
            : 1;
    }

    function displayValue(value) {
        if (value === null || value === undefined || value === "") return "—";
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

    function advancedHighlightedText(message, report, codeById, codeIdsByUnit) {
        const text = message.Message || "";
        const highlights = report.meaningUnits
            .filter(unit => unit.message_id === message.id)
            .map(unit => ({
                ...unit,
                codes: [...new Set(codeIdsByUnit.get(unit.id) || [])]
                    .map(codeId => codeById.get(codeId))
                    .filter(Boolean)
            }))
            .sort((left, right) => left.start_offset - right.start_offset
                || right.end_offset - left.end_offset);
        const fragment = document.createDocumentFragment();
        let cursor = 0;

        highlights.forEach(unit => {
            if (unit.start_offset < cursor || unit.end_offset > text.length) return;
            fragment.append(document.createTextNode(text.slice(cursor, unit.start_offset)));
            const annotation = document.createElement("span");
            annotation.className = "meaningUnitAnnotation";
            const label = document.createElement("span");
            label.className = "meaningUnitCodeLabel";
            const codeLabels = unit.codes.map(code =>
                `CO${code.code_number}: ${code.code_label}`
            );
            label.textContent = `MU${unit.unit_number}`
                + (codeLabels.length ? ` · ${codeLabels.join(" · ")}` : "");
            const mark = document.createElement("mark");
            const firstCode = unit.codes[0];
            mark.className = `keywordColor${codeColorSlot(firstCode?.code_number)}`;
            mark.textContent = text.slice(unit.start_offset, unit.end_offset);
            mark.title = codeLabels.join(" · ") || `MU${unit.unit_number}`;
            annotation.append(label, mark);
            fragment.append(annotation);
            cursor = unit.end_offset;
        });

        fragment.append(document.createTextNode(text.slice(cursor)));
        return fragment;
    }

    function advancedAnnotatedTranscript(detail, report, codeById, codeIdsByUnit) {
        const section = document.createElement("section");
        section.className = "automaticReanalysisPanel";
        section.appendChild(heading("Advanced annotated transcript (review format)"));
        section.appendChild(paragraph(
            `Participant code: ${report.participant_code || "—"} · `
            + `Participant ID: ${report.participant_id || "—"} · `
            + `Session ID: ${report.session_id || detail.job.session_id || "—"} · linked match`,
            "transcriptIdentity"
        ));
        section.appendChild(paragraph(
            `Demographic data: ${demographicsText(detail.previous?.demographics)}`
        ));
        section.appendChild(paragraph(
            "Demographics are shown from the preserved prior report for review only; they were not used as analytical input for this new transcript-only run.",
            "muted"
        ));

        const legend = document.createElement("div");
        legend.setAttribute("aria-label", "Advanced code colour legend");
        report.codes.forEach(code => {
            const item = document.createElement("span");
            item.className = `keywordLegend keywordColor${codeColorSlot(code.code_number)}`;
            item.textContent = `CO${code.code_number}: ${code.code_label}`;
            item.title = code.rationale;
            legend.appendChild(item);
        });
        section.appendChild(legend);

        detail.transcript.forEach(message => {
            const article = document.createElement("article");
            article.className = "message";
            const source = document.createElement("p");
            const speaker = document.createElement("strong");
            const language = String(message.Language || "").toLowerCase();
            speaker.textContent = language === "en"
                ? `${message.Speaker || "Speaker"} · English original: `
                : `${message.Speaker || "Speaker"} · Original (${language || "language not recorded"}): `;
            source.appendChild(speaker);
            source.appendChild(advancedHighlightedText(
                message, report, codeById, codeIdsByUnit
            ));
            article.appendChild(source);
            if (message.EnglishTranslation
                && message.EnglishTranslation !== message.Message) {
                article.appendChild(paragraph(
                    `English translation: ${message.EnglishTranslation}`,
                    "englishTranslation"
                ));
            }
            section.appendChild(article);
        });
        return section;
    }

    async function openCase(caseNumber) {
        dialogHeading.textContent = `${caseNumber} · Advanced preliminary case report`;
        dialogProvenance.textContent = "Loading traceability…";
        dialogContent.replaceChildren();
        dialog.showModal();
        try {
            const detail = await request(
                `${API_PATH}&case=${encodeURIComponent(caseNumber)}&_=${Date.now()}`
            );
            const report = detail.report;
            if (!report) {
                dialogContent.appendChild(paragraph(
                    `This case is ${detail.job.status}; no advanced report is available yet.`
                ));
                return;
            }
            dialogProvenance.textContent = [
                `Run ${detail.run.run_number}`,
                `${report.provider} / ${report.resolved_model || report.model}`,
                `reasoning ${report.reasoning_effort}`,
                report.analysis_version,
                report.prompt_version,
                `report ${report.id}`,
                `preserved source report ${report.source_report_id || "historical transcript only"}`
            ].join(" · ");

            dialogContent.appendChild(heading("Previous preliminary analysis (preserved comparison)"));
            if (detail.previous) {
                dialogContent.appendChild(paragraph(
                    `${detail.previous.analysis_version} · ${detail.previous.model} · report ${detail.previous.id}`,
                    "muted"
                ));
                dialogContent.appendChild(paragraph(
                    `Previous codes: ${listLabels(detail.previous.codes, "code_number", "code_label", "CO")}`
                ));
                dialogContent.appendChild(paragraph(
                    `Previous categories: ${listLabels(detail.previous.categories, "category_number", "category_label", "CA")}`
                ));
                dialogContent.appendChild(paragraph(
                    `Previous tentative themes: ${listLabels(detail.previous.themes, "theme_number", "theme_label", "TH")}`
                ));
            } else {
                dialogContent.appendChild(paragraph(
                    "No previous report link is available for this historical case. The original transcript remains preserved."
                ));
            }

            dialogContent.appendChild(heading("New transcript-grounded transformation"));
            dialogContent.appendChild(paragraph(report.case_summary));
            const transcriptById = new Map(detail.transcript.map(message => [
                message.id,
                message
            ]));
            const muById = new Map(report.meaningUnits.map(unit => [unit.id, unit]));
            const codeById = new Map(report.codes.map(code => [code.id, code]));
            const muIdsByCode = report.codeMeaningUnits.reduce((map, link) => {
                const ids = map.get(link.code_id) || [];
                ids.push(link.meaning_unit_id);
                map.set(link.code_id, ids);
                return map;
            }, new Map());
            const codeIdsByCategory = report.categoryCodes.reduce((map, link) => {
                const ids = map.get(link.category_id) || [];
                ids.push(link.code_id);
                map.set(link.category_id, ids);
                return map;
            }, new Map());
            const assignedCodeIds = new Set(report.categoryCodes.map(link => link.code_id));

            dialogContent.appendChild(advancedAnnotatedTranscript(
                detail, report, codeById, muIdsByCode
            ));

            report.categories.forEach(category => {
                const categorySection = document.createElement("section");
                categorySection.className = "automaticReanalysisPanel";
                categorySection.appendChild(heading(
                    `CA${category.category_number} ${category.category_label}`
                ));
                categorySection.appendChild(paragraph(
                    `${category.definition} ${category.rationale}`
                ));
                categorySection.appendChild(paragraph(
                    `Stable category ID: ${category.id}`,
                    "muted"
                ));
                (codeIdsByCategory.get(category.id) || []).forEach(codeId => {
                    const code = codeById.get(codeId);
                    if (!code) return;
                    categorySection.appendChild(heading(
                        `CO${code.code_number} ${code.code_label}`
                    ));
                    categorySection.appendChild(paragraph(
                        `${code.definition} ${code.rationale}`
                    ));
                    categorySection.appendChild(paragraph(
                        `Stable code ID: ${code.id} · ${code.meaning_unit_count} linked Meaning Unit(s)`,
                        "muted"
                    ));
                    (muIdsByCode.get(code.id) || []).forEach(muId => {
                        const unit = muById.get(muId);
                        if (unit) categorySection.appendChild(
                            meaningUnitBlock(unit, transcriptById)
                        );
                    });
                });
                dialogContent.appendChild(categorySection);
            });

            const unassignedCodes = report.codes.filter(code =>
                !assignedCodeIds.has(code.id)
            );
            if (unassignedCodes.length) {
                dialogContent.appendChild(heading("Firm preliminary codes not forced into a category"));
                unassignedCodes.forEach(code => {
                    dialogContent.appendChild(heading(
                        `CO${code.code_number} ${code.code_label}`
                    ));
                    dialogContent.appendChild(paragraph(
                        `${code.definition} ${code.rationale}`
                    ));
                    (muIdsByCode.get(code.id) || []).forEach(muId => {
                        const unit = muById.get(muId);
                        if (unit) dialogContent.appendChild(
                            meaningUnitBlock(unit, transcriptById)
                        );
                    });
                });
            }

            dialogContent.appendChild(heading("Independent analytical audit"));
            dialogContent.appendChild(paragraph(
                report.analytical_audit?.overallSummary
                    || "No audit summary was recorded."
            ));
            dialogContent.appendChild(paragraph(
                `Accepted codes: ${(report.analytical_audit?.codeChecks || []).filter(check => check.accepted).length}/${report.codes.length}; `
                + `accepted categories: ${(report.analytical_audit?.categoryChecks || []).filter(check => check.accepted).length}/${report.categories.length}.`,
                "muted"
            ));

        } catch (error) {
            dialogContent.appendChild(paragraph(error.message, "errorMessage"));
        }
    }

    startButton.addEventListener("click", async () => {
        const confirmed = window.confirm(
            "Start a new advanced-model preliminary analysis for all 275 completed transcripts? "
            + "This creates a separate version and preserves every existing report. The run stops at categories."
        );
        if (!confirmed) return;
        startButton.disabled = true;
        setStatus("Verifying the stronger model against the production API…");
        try {
            const result = await request(API_PATH, {
                method: "POST",
                body: JSON.stringify({ action: "start" })
            });
            setStatus(
                `Model verified: ${result.provider} ${result.resolvedModel}, reasoning ${result.reasoningEffort}. `
                + "The 275-case run is queued in source-completion order."
            );
            page = 1;
            await load({ quiet: true });
        } catch (error) {
            setStatus(error.message, true);
            startButton.disabled = false;
        }
    });
    refreshButton.addEventListener("click", () => load());
    previousButton.addEventListener("click", () => {
        if (page <= 1) return;
        page -= 1;
        load();
    });
    nextButton.addEventListener("click", () => {
        page += 1;
        load();
    });
    document.getElementById("advancedPreliminaryDialogClose")
        .addEventListener("click", () => dialog.close());

    const observer = new MutationObserver(() => {
        if (!workspace.hidden && token()) load({ quiet: true });
    });
    observer.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
    if (!workspace.hidden && token()) load({ quiet: true });
}());
