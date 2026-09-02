(function initializeStagedQualitativeAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const API_PATH = "/api/automatic-analysis?view=advanced-preliminary";
    const section = document.getElementById("advancedPreliminaryAnalysis");
    if (!section) return;

    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const gate = document.getElementById("automaticAnalysisTokenGate");
    workspace?.prepend(section);
    section.classList.add("stagedAnalysisPrimary");
    const element = id => document.getElementById(id);
    const status = element("advancedPreliminaryStatus");
    const provenance = element("advancedPreliminaryProvenance");
    const tableHost = element("advancedPreliminaryTable");
    const attentionHost = element("advancedPreliminaryAttentionTable");
    const stage2Status = element("crossCaseCodeStatus");
    const stage2Provenance = element("crossCaseCodeProvenance");
    const stage2Host = element("crossCaseCodeTable");
    const providerSelect = element("advancedPreliminaryProvider");
    const modelSelect = element("advancedPreliminaryModel");
    const modelSuggestions = element("advancedPreliminaryModelSuggestions");
    const startButton = element("advancedPreliminaryStartButton");
    const executionPlanHost = element("advancedPreliminaryExecutionPlan");
    const executeButton = element("advancedPreliminaryExecuteButton");
    const cancelButton = element("advancedPreliminaryCancelButton");
    const refreshButton = element("advancedPreliminaryRefreshButton");
    const downloadButton = element("advancedPreliminaryDownloadButton");
    const lockButton = element("advancedPreliminaryLockButton");
    const previousButton = element("advancedPreliminaryPreviousPage");
    const nextButton = element("advancedPreliminaryNextPage");
    const pageLabel = element("advancedPreliminaryPageLabel");
    const dialog = element("advancedPreliminaryDialog");
    const dialogHeading = element("advancedPreliminaryDialogHeading");
    const dialogProvenance = element("advancedPreliminaryDialogProvenance");
    const dialogContent = element("advancedPreliminaryDialogContent");
    let payload = {
        run: null, cases: [], attentionCases: [], attentionCount: 0,
        stage2: { disabled: true }, page: 1, pageSize: 50
    };
    let page = 1;
    let loading = false;
    let refreshTimer = null;
    let preparedExecution = null;

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function setStatus(message, isError = false) {
        status.textContent = message;
        status.className = isError ? "errorMessage" : "automaticReviewScopeSummary";
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
        if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}.`);
        return body;
    }

    function paragraph(text, className = "") {
        const node = document.createElement("p");
        node.textContent = text;
        node.className = className;
        return node;
    }

    function heading(text) {
        const node = document.createElement("h3");
        node.textContent = text;
        return node;
    }

    function cell(row, value) {
        const node = document.createElement("td");
        node.textContent = value === null || value === undefined || value === ""
            ? "—" : String(value);
        row.appendChild(node);
    }

    function table(headers) {
        const scroll = document.createElement("div");
        scroll.className = "tableScroll";
        const node = document.createElement("table");
        node.className = "analysisTable automaticAnalysisTable";
        const head = document.createElement("thead");
        const row = document.createElement("tr");
        headers.forEach(label => {
            const header = document.createElement("th");
            header.scope = "col";
            header.textContent = label;
            row.appendChild(header);
        });
        head.appendChild(row);
        node.appendChild(head);
        scroll.appendChild(node);
        return { scroll, element: node };
    }

    function renderSelections() {
        const modelValue = modelSelect.value;
        modelSuggestions?.replaceChildren();
        (payload.availableModels || []).forEach(model => {
            const option = document.createElement("option");
            option.value = model;
            modelSuggestions?.appendChild(option);
        });
        if (modelValue) modelSelect.value = modelValue;

        const providerValue = providerSelect.value;
        providerSelect.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose a provider";
        providerSelect.appendChild(placeholder);
        (payload.availableProviders || []).forEach(provider => {
            const option = document.createElement("option");
            option.value = provider.id;
            option.textContent = `${provider.label}${provider.configured ? "" : " (not configured)"}`;
            option.disabled = !provider.configured;
            providerSelect.appendChild(option);
        });
        if (providerValue) providerSelect.value = providerValue;
    }

    function invalidateExecutionPlan() {
        preparedExecution = null;
        executionPlanHost.replaceChildren();
        executeButton.hidden = true;
        executeButton.disabled = true;
        startButton.disabled = !providerSelect.value || !modelSelect.value.trim();
    }

    function renderExecutionPlan(result) {
        const plan = result.plan;
        preparedExecution = {
            operation: plan.operation,
            provider: plan.provider,
            model: plan.model,
            executionPlanHash: result.executionPlanHash
        };
        const panel = document.createElement("section");
        panel.className = "automaticReanalysisPanel";
        panel.appendChild(heading("Exact execution plan — review before spending"));
        const list = document.createElement("dl");
        [
            ["Operation", plan.operation],
            ["Provider and exact model", `${plan.provider} / ${plan.model}`],
            ["Authoritative source", plan.authoritativeSource],
            ["Completed transcripts ready", plan.sourceCaseCount],
            ["Participant source messages", plan.participantMessageCount],
            ["Earlier analytical outputs used", plan.legacyAnalyticalOutputsUsed ? "yes" : "no"],
            ["Analytical gatekeepers", plan.analyticalGatekeepers],
            ["Model probe calls", plan.modelProbeCalls],
            ["Paid analysis calls per case", plan.analysisCallsPerCase],
            ["Maximum paid analysis calls", plan.maximumAnalysisCalls],
            ["Automatic cross-case analysis", plan.automaticCrossCaseAnalysis ? "yes" : "no"],
            ["Output contract", plan.stopLayer],
            ["Execution plan hash", result.executionPlanHash]
        ].forEach(([label, value]) => {
            const term = document.createElement("dt");
            term.textContent = label;
            const description = document.createElement("dd");
            description.textContent = String(value ?? "—");
            list.append(term, description);
        });
        panel.appendChild(list);
        executionPlanHost.replaceChildren(panel);
        executeButton.hidden = false;
        executeButton.disabled = false;
    }

    function renderCaseTable(items, host, mode = "active") {
        const built = table([
            "Case ID", "Project lineage", "Status", "Meaning Units", "Codes",
            "Categories", "Themes", "Exact first response", "Generation", "Inspect"
        ]);
        const body = document.createElement("tbody");
        items.forEach(item => {
            const row = document.createElement("tr");
            cell(row, item.case_number);
            cell(row, item.project_binding_status === "project_bound"
                ? "Sleeping habits" : "Historical project binding pending");
            cell(row, mode === "attention" || item.status === "failed"
                ? `System needs attention · participant remains included${item.last_error ? `: ${item.last_error}` : ""}`
                : item.status.replaceAll("_", " "));
            cell(row, item.report?.meaningUnitCount ?? "—");
            cell(row, item.report?.codeCount ?? "—");
            cell(row, item.report?.categoryCount ?? "—");
            cell(row, item.report?.themeCount ?? "—");
            cell(row, item.report?.exactOutputAvailable
                ? "available"
                : item.report
                ? "not preserved by earlier implementation"
                : item.status === "processing"
                ? "provider call still running"
                : "not yet available");
            cell(row, item.report
                ? item.report.analytical_audit?.aiAnalysisPassCount === 1
                    ? "One first response"
                    : "Historical output"
                : "—");
            const action = document.createElement("td");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = item.report
                ? "Inspect complete report"
                : item.status === "processing"
                ? "Inspect transcript and status" : "Inspect transcript";
            button.addEventListener("click", () => openCase(item.case_number));
            action.appendChild(button);
            row.appendChild(action);
            body.appendChild(row);
        });
        built.element.appendChild(body);
        host?.appendChild(built.scroll);
    }

    function renderStage2() {
        stage2Status.textContent = payload.stage2?.reason
            || "Stage 2 is unavailable until the researcher separately authorizes its source contract.";
        stage2Provenance.textContent =
            "No Stage 2 run is active. Exact Stage 1 outputs will not be parsed, normalized, projected, or reconstructed automatically.";
        stage2Host?.replaceChildren();
    }

    function render() {
        tableHost.replaceChildren();
        attentionHost?.replaceChildren();
        renderSelections();
        const run = payload.run;
        [
            ["advancedPreliminaryPending", run?.pending_count || 0],
            ["advancedPreliminaryProcessing", run?.processing_count || 0],
            ["advancedPreliminaryCompleted", run?.completed_count || 0],
            ["advancedPreliminaryFailed", payload.attentionCount || 0]
        ].forEach(([id, value]) => { element(id).textContent = value; });

        if (!run) {
            provenance.textContent = "No independent Stage 1 run has been created yet.";
            setStatus("Choose a provider and exact model ID, then preview the one-call-per-case plan. Preview makes no model call.");
            startButton.disabled = !providerSelect.value || !modelSelect.value.trim();
            providerSelect.disabled = false;
            modelSelect.disabled = false;
            cancelButton.hidden = true;
            downloadButton.disabled = true;
            previousButton.disabled = true;
            nextButton.disabled = true;
            renderStage2();
            return;
        }

        const active = ["queued", "processing"].includes(run.status);
        provenance.textContent = [
            `Run ${run.run_number}`,
            `project ${run.project_snapshot?.[0]?.project_name || "Sleeping habits"}`,
            `${run.provider} / requested ${run.model}`,
            `recorded model ${run.resolved_model || run.model}`,
            `reasoning ${run.reasoning_effort}`,
            `analysis ${run.analysis_version}`,
            `prompt ${run.prompt_version}`,
            `output contract ${run.stop_layer}`,
            `source ${run.authoritative_source || "original completed transcripts"}`,
            `plan ${run.execution_plan_hash || "historical plan"}`
        ].join(" · ");
        startButton.disabled = active || !providerSelect.value || !modelSelect.value.trim();
        providerSelect.disabled = active;
        modelSelect.disabled = active;
        cancelButton.hidden = !active;
        cancelButton.disabled = !active;
        downloadButton.disabled = run.completed_count < 1;
        setStatus(
            `Stage 1 run ${run.run_number}: ${run.status.replaceAll("_", " ")}. `
            + `${payload.exactOutputCount || 0} of ${run.source_case_count} exact first responses are stored; `
            + `${payload.historicalProjectionOnlyCount || 0} completed historical reports predate exact-response preservation; `
            + `${run.processing_count} existing provider calls are still being polled. `
            + "The platform does not validate, score, repair, retry, parse, normalize, project, or reconstruct them."
        );
        renderCaseTable(payload.cases, tableHost);
        renderCaseTable(payload.attentionCases || [], attentionHost, "attention");
        renderStage2();
        pageLabel.textContent = `Page ${payload.page}`;
        previousButton.disabled = payload.page <= 1;
        nextButton.disabled = payload.page * payload.pageSize >= run.source_case_count;
    }

    function sourceTranscript(detail) {
        const panel = document.createElement("section");
        panel.className = "automaticReanalysisPanel";
        panel.appendChild(heading("Original completed transcript"));
        panel.appendChild(paragraph(
            `Participant ID: ${detail.job.participant_id || "—"} · Session ID: ${detail.job.session_id || "—"}`,
            "transcriptIdentity"
        ));
        detail.transcript.forEach(message => {
            const article = document.createElement("article");
            article.className = "message";
            article.appendChild(paragraph(`${message.Speaker || "Speaker"}: ${message.Message || ""}`));
            if (message.EnglishTranslation && message.EnglishTranslation !== message.Message) {
                article.appendChild(paragraph(
                    `English translation: ${message.EnglishTranslation}`,
                    "englishTranslation"
                ));
            }
            panel.appendChild(article);
        });
        return panel;
    }

    function codeColor(codeNumber) {
        return `keywordColor${((Number(codeNumber) - 1) % 12) + 1}`;
    }

    function codesForUnit(report, meaningUnitId) {
        const codeIds = new Set((report.codeMeaningUnits || [])
            .filter(link => link.meaning_unit_id === meaningUnitId)
            .map(link => link.code_id));
        return (report.codes || []).filter(code => codeIds.has(code.id));
    }

    function highlightedMessage(message, report) {
        const text = message.Message || "";
        const highlights = (report.meaningUnits || [])
            .filter(unit => unit.message_id === message.id)
            .sort((left, right) => left.start_offset - right.start_offset);
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        highlights.forEach(unit => {
            if (unit.start_offset < cursor || unit.end_offset > text.length) return;
            fragment.append(document.createTextNode(text.slice(cursor, unit.start_offset)));
            const annotation = document.createElement("span");
            annotation.className = "meaningUnitAnnotation";
            const linkedCodes = codesForUnit(report, unit.id);
            const colorClass = codeColor(linkedCodes[0]?.code_number || unit.unit_number);
            const label = document.createElement("span");
            label.className = `meaningUnitCodeLabel ${colorClass}`;
            label.textContent = linkedCodes.length
                ? linkedCodes.map(code => `CO${code.code_number} ${code.code_label}`).join(" · ")
                : `MU${unit.unit_number} · no stored Code link`;
            const mark = document.createElement("mark");
            mark.className = colorClass;
            mark.textContent = text.slice(unit.start_offset, unit.end_offset);
            mark.title = `Stored MU${unit.unit_number} · ${label.textContent}`;
            annotation.append(label, mark);
            fragment.append(annotation);
            cursor = unit.end_offset;
        });
        fragment.append(document.createTextNode(text.slice(cursor)));
        return fragment;
    }

    function annotatedTranscript(detail, report) {
        const panel = document.createElement("section");
        panel.className = "automaticReanalysisPanel";
        panel.appendChild(heading("Stored report highlights"));
        panel.appendChild(paragraph(
            "These highlights reproduce the stored original report structure. They are displayed read-only and are not validation, approval, rejection, or a new analytical judgment.",
            "muted"
        ));
        detail.transcript.forEach(message => {
            const article = document.createElement("article");
            article.className = "message";
            const source = document.createElement("p");
            const speaker = document.createElement("strong");
            speaker.textContent = `${message.Speaker || "Speaker"}: `;
            source.append(speaker, highlightedMessage(message, report));
            article.appendChild(source);
            if (message.EnglishTranslation && message.EnglishTranslation !== message.Message) {
                article.appendChild(paragraph(
                    `English translation: ${message.EnglishTranslation}`,
                    "englishTranslation"
                ));
            }
            panel.appendChild(article);
        });
        return panel;
    }

    function preliminaryHierarchy(report) {
        const panel = document.createElement("section");
        panel.className = "automaticReanalysisPanel";
        panel.appendChild(heading("Stored MU → Code → Category → Theme report"));
        panel.appendChild(paragraph(
            "This is the original stored hierarchy restored for researcher inspection. The platform does not use it to accept or reject the model output.",
            "muted"
        ));
        const codeById = new Map((report.codes || []).map(code => [code.id, code]));
        const categoryById = new Map(
            (report.categories || []).map(category => [category.id, category])
        );
        const unitById = new Map(
            (report.meaningUnits || []).map(unit => [unit.id, unit])
        );
        const rows = [];
        (report.tentativeThemes || []).forEach(theme => {
            (report.themeCategories || [])
                .filter(link => link.theme_id === theme.id)
                .forEach(themeLink => {
                    const category = categoryById.get(themeLink.category_id);
                    (report.categoryCodes || [])
                        .filter(link => link.category_id === themeLink.category_id)
                        .forEach(categoryLink => {
                            const code = codeById.get(categoryLink.code_id);
                            const units = (report.codeMeaningUnits || [])
                                .filter(link => link.code_id === categoryLink.code_id)
                                .map(link => unitById.get(link.meaning_unit_id))
                                .filter(Boolean);
                            rows.push({ theme, category, code, units });
                        });
                });
        });
        const representedCodes = new Set(rows.map(row => row.code?.id));
        (report.codes || []).filter(code => !representedCodes.has(code.id))
            .forEach(code => {
                const units = (report.codeMeaningUnits || [])
                    .filter(link => link.code_id === code.id)
                    .map(link => unitById.get(link.meaning_unit_id))
                    .filter(Boolean);
                rows.push({ theme: null, category: null, code, units });
            });
        if (!rows.length && (report.meaningUnits || []).length) {
            report.meaningUnits.forEach(unit => rows.push({
                theme: null, category: null, code: null, units: [unit]
            }));
        }
        const built = table([
            "Tentative Theme", "Preliminary Category", "Preliminary Code",
            "Supporting Meaning Units"
        ]);
        const body = document.createElement("tbody");
        rows.forEach(item => {
            const row = document.createElement("tr");
            cell(row, item.theme
                ? `TH${item.theme.theme_number} · ${item.theme.theme_label}` : "—");
            cell(row, item.category
                ? `CA${item.category.category_number} · ${item.category.category_label}` : "—");
            cell(row, item.code
                ? `CO${item.code.code_number} · ${item.code.code_label}` : "—");
            cell(row, item.units.map(unit =>
                `MU${unit.unit_number}: ${unit.exact_source_text}`
            ).join(" | "));
            body.appendChild(row);
        });
        built.element.appendChild(body);
        panel.appendChild(built.scroll);
        return panel;
    }

    async function openCase(caseNumber) {
        dialogHeading.textContent = `${caseNumber} · Stage 1 exact first response`;
        dialogProvenance.textContent = "Loading preserved output and transcript…";
        dialogContent.replaceChildren();
        dialog.showModal();
        try {
            const detail = await request(
                `${API_PATH}&case=${encodeURIComponent(caseNumber)}&_=${Date.now()}`
            );
            const report = detail.report;
            if (!report) {
                dialogProvenance.textContent =
                    `System state: ${detail.job.status}. The participant and transcript remain included and processible.`;
                dialogContent.appendChild(paragraph(
                    detail.job.status === "processing"
                        ? "The original provider request is still running under its existing response ID. It has not been cancelled, replaced, or resubmitted."
                        : detail.job.last_error || "No first response has been stored yet."
                ));
                dialogContent.appendChild(sourceTranscript(detail));
                return;
            }
            dialogProvenance.textContent = [
                `Run ${detail.run.run_number}`,
                `${report.provider} / requested ${report.model}`,
                `recorded model ${report.resolved_model || report.model}`,
                `reasoning ${report.reasoning_effort}`,
                report.analysis_version,
                report.prompt_version,
                `report ${report.id}`,
                "source: original completed transcript"
            ].join(" · ");
            dialogContent.appendChild(heading("Exact first model response"));
            const preservedText = document.createElement("pre");
            preservedText.textContent = report.raw_model_output_text
                || "This historical report predates exact-response preservation. Its earlier relational projection remains retained only to avoid deleting the participant's sole stored analysis, and it is not eligible for Stage 2.";
            dialogContent.appendChild(preservedText);
            dialogContent.appendChild(heading("Execution provenance"));
            dialogContent.appendChild(paragraph(
                report.analytical_audit?.overallSummary
                    || "Historical implementation; exact first response availability is shown above."
            ));
            const hasStoredStructure = (report.meaningUnits || []).length
                || (report.codes || []).length
                || (report.categories || []).length
                || (report.tentativeThemes || []).length;
            if (hasStoredStructure) {
                dialogContent.appendChild(annotatedTranscript(detail, report));
                dialogContent.appendChild(preliminaryHierarchy(report));
            } else {
                dialogContent.appendChild(paragraph(
                    "No normalized MU/Code/Category/Theme structure was ever stored for this report. The verbatim model response above remains available without reconstruction.",
                    "muted"
                ));
                dialogContent.appendChild(sourceTranscript(detail));
            }
        } catch (error) {
            dialogContent.appendChild(paragraph(error.message, "errorMessage"));
        }
    }

    async function load({ quiet = false } = {}) {
        if (loading || !token() || workspace?.hidden) return;
        loading = true;
        if (!quiet) setStatus("Loading Stage 1 progress…");
        try {
            payload = await request(`${API_PATH}&page=${page}&_=${Date.now()}`);
            render();
            clearTimeout(refreshTimer);
            if (["queued", "processing"].includes(payload.run?.status)) {
                refreshTimer = setTimeout(() => load({ quiet: true }), 30000);
            }
        } catch (error) {
            setStatus(`${error.message} If access has expired, choose Lock workspace and unlock again.`, true);
        } finally {
            loading = false;
        }
    }

    startButton.addEventListener("click", async () => {
        const selectedProvider = providerSelect.value;
        const selectedModel = modelSelect.value.trim();
        if (!selectedProvider || !selectedModel) return;
        invalidateExecutionPlan();
        startButton.disabled = true;
        setStatus("Preparing the exact source, provider, model, and one-call-per-case plan. This preview makes no model call.");
        try {
            const result = await request(API_PATH, {
                method: "POST",
                body: JSON.stringify({
                    action: "preflight", operation: "fresh_independent_analysis",
                    provider: selectedProvider, model: selectedModel
                })
            });
            renderExecutionPlan(result);
            setStatus("Execution plan prepared. Review every field, then choose Start exactly this plan.");
        } catch (error) {
            setStatus(error.message, true);
            invalidateExecutionPlan();
        }
    });

    executeButton.addEventListener("click", async () => {
        if (!preparedExecution) return;
        executeButton.disabled = true;
        startButton.disabled = true;
        providerSelect.disabled = true;
        modelSelect.disabled = true;
        setStatus(`Starting ${preparedExecution.provider} / ${preparedExecution.model} directly, with no capability probe…`);
        try {
            const result = await request(API_PATH, {
                method: "POST", body: JSON.stringify({ action: "start", ...preparedExecution })
            });
            preparedExecution = null;
            executionPlanHost.replaceChildren();
            executeButton.hidden = true;
            setStatus(`Started the reviewed plan. Provider ${result.provider}; model ${result.model}; plan ${result.executionPlanHash}.`);
            page = 1;
            await load({ quiet: true });
        } catch (error) {
            setStatus(error.message, true);
            providerSelect.disabled = false;
            modelSelect.disabled = false;
            executeButton.disabled = false;
            startButton.disabled = false;
        }
    });

    cancelButton.addEventListener("click", async () => {
        if (!payload.run?.id) return;
        const reason = window.prompt(
            `Why should run ${payload.run.run_number} be stopped?`,
            "Stopped by the researcher."
        )?.trim();
        if (!reason) return;
        cancelButton.disabled = true;
        setStatus("Stopping new Stage 1 work. Stored transcripts and exact responses remain preserved.");
        try {
            await request(API_PATH, {
                method: "POST",
                body: JSON.stringify({ action: "cancel", runId: payload.run.id, reason })
            });
            await load({ quiet: true });
        } catch (error) {
            setStatus(error.message, true);
            cancelButton.disabled = false;
        }
    });

    downloadButton.addEventListener("click", async () => {
        downloadButton.disabled = true;
        setStatus("Preparing the exact Stage 1 response export…");
        try {
            const response = await fetch(
                `${API_PATH}&download=stage1-csv&_=${Date.now()}`,
                { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" }
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || "The Stage 1 export could not be prepared.");
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `sleeping-habits-stage1-exact-responses-run-${payload.run?.run_number || "latest"}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            render();
        } catch (error) {
            setStatus(error.message, true);
            downloadButton.disabled = false;
        }
    });

    providerSelect.addEventListener("change", invalidateExecutionPlan);
    modelSelect.addEventListener("input", invalidateExecutionPlan);
    refreshButton.addEventListener("click", () => load());
    lockButton.addEventListener("click", () => {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        clearTimeout(refreshTimer);
        workspace.hidden = true;
        gate.hidden = false;
        element("automaticAnalysisToken").value = "";
        setStatus("Researcher access is locked. Unlock to load or start Stage 1.");
    });
    previousButton.addEventListener("click", () => {
        if (page <= 1) return;
        page -= 1;
        load();
    });
    nextButton.addEventListener("click", () => {
        page += 1;
        load();
    });
    element("advancedPreliminaryDialogClose").addEventListener("click", () => dialog.close());

    const observer = new MutationObserver(() => {
        if (!workspace.hidden && token()) load({ quiet: true });
    });
    observer.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
    if (!workspace.hidden && token()) load({ quiet: true });
}());
