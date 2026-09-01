(function initializeStagedQualitativeAnalysis() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const API_PATH = "/api/automatic-analysis?view=advanced-preliminary";
    const section = document.getElementById("advancedPreliminaryAnalysis");
    if (!section) return;

    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const gate = document.getElementById("automaticAnalysisTokenGate");
    // Keep the current staged task above every historical form, regardless of
    // how many legacy case rows are rendered below it.
    workspace?.prepend(section);
    section.classList.add("stagedAnalysisPrimary");
    const status = document.getElementById("advancedPreliminaryStatus");
    const provenance = document.getElementById("advancedPreliminaryProvenance");
    const tableHost = document.getElementById("advancedPreliminaryTable");
    const attentionHost = document.getElementById("advancedPreliminaryAttentionTable");
    const legacyHost = document.getElementById("advancedPreliminaryLegacyTable");
    const stage2Status = document.getElementById("crossCaseCodeStatus");
    const stage2Provenance = document.getElementById("crossCaseCodeProvenance");
    const stage2Host = document.getElementById("crossCaseCodeTable");
    const stage2DownloadButton = document.getElementById("crossCaseCodeDownloadButton");
    const modelSelect = document.getElementById("advancedPreliminaryModel");
    const modelSuggestions = document.getElementById("advancedPreliminaryModelSuggestions");
    const startButton = document.getElementById("advancedPreliminaryStartButton");
    const refreshButton = document.getElementById("advancedPreliminaryRefreshButton");
    const downloadButton = document.getElementById("advancedPreliminaryDownloadButton");
    const lockButton = document.getElementById("advancedPreliminaryLockButton");
    const previousButton = document.getElementById("advancedPreliminaryPreviousPage");
    const nextButton = document.getElementById("advancedPreliminaryNextPage");
    const pageLabel = document.getElementById("advancedPreliminaryPageLabel");
    const dialog = document.getElementById("advancedPreliminaryDialog");
    const dialogHeading = document.getElementById("advancedPreliminaryDialogHeading");
    const dialogProvenance = document.getElementById("advancedPreliminaryDialogProvenance");
    const dialogContent = document.getElementById("advancedPreliminaryDialogContent");
    let payload = {
        run: null, cases: [], attentionCases: [], attentionCount: 0,
        legacyCases: [], legacyCount: 0,
        stage2: { run: null, mappings: [] },
        page: 1, pageSize: 50
    };
    let page = 1;
    let loading = false;
    let refreshTimer = null;

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
        const element = document.createElement("p");
        element.textContent = text;
        element.className = className;
        return element;
    }

    function heading(text) {
        const element = document.createElement("h3");
        element.textContent = text;
        return element;
    }

    function cell(row, value) {
        const element = document.createElement("td");
        element.textContent = value === null || value === undefined || value === ""
            ? "—" : String(value);
        row.appendChild(element);
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

    function renderModels() {
        const models = payload.availableModels || [];
        const currentValue = modelSelect.value;
        modelSuggestions?.replaceChildren();
        models.forEach(model => {
            const option = document.createElement("option");
            option.value = model;
            modelSuggestions?.appendChild(option);
        });
        // Suggestions never constrain the researcher. Keep every manually typed
        // model ID intact and only supply a default before the field is edited.
        if (!currentValue) {
            modelSelect.value = payload.defaultModel || models[0] || "";
        }
    }

    function render() {
        tableHost.replaceChildren();
        attentionHost?.replaceChildren();
        legacyHost?.replaceChildren();
        stage2Host?.replaceChildren();
        renderModels();
        const run = payload.run;
        [
            ["advancedPreliminaryPending", run?.pending_count || 0],
            ["advancedPreliminaryProcessing", run?.processing_count || 0],
            ["advancedPreliminaryCompleted", run?.completed_count || 0],
            ["advancedPreliminaryFailed", payload.attentionCount || 0]
            ,["advancedPreliminaryLegacy", payload.legacyCount || 0]
        ].forEach(([id, value]) => {
            document.getElementById(id).textContent = value;
        });

        if (!run) {
            provenance.textContent = "No Stage 1 Meaning Unit run has been created yet.";
            setStatus("Enter an exact model ID, then start Stage 1 for the Sleeping habits project.");
            startButton.disabled = !modelSelect.value;
            modelSelect.disabled = false;
            downloadButton.disabled = true;
            previousButton.disabled = true;
            nextButton.disabled = true;
            return;
        }

        const active = ["queued", "processing"].includes(run.status);
        provenance.textContent = [
            `Run ${run.run_number}`,
            `project ${run.project_snapshot?.[0]?.project_name || "Sleeping habits"}`,
            `topic ${run.project_snapshot?.[0]?.research_topic || "Sleeping habits"}`,
            `${run.provider} / requested ${run.model}`,
            `resolved ${run.resolved_model || "not recorded"}`,
            `reasoning ${run.reasoning_effort}`,
            `analysis ${run.analysis_version}`,
            `prompt ${run.prompt_version}`,
            `stop layer ${run.stop_layer}`,
            `model verified ${run.model_verified_at || "not verified"}`
        ].join(" · ");
        startButton.disabled = active || !modelSelect.value;
        modelSelect.disabled = active;
        downloadButton.disabled = run.completed_count < 1;
        setStatus(
            `Stage 1 run ${run.run_number}: ${run.status.replaceAll("_", " ")}. `
            + `${run.completed_count} of ${run.source_case_count} cases completed using `
            + `${run.resolved_model || run.model}. Codes, Categories, and Themes are locked. `
            + (run.status === "cancelled"
                ? "This run is stopped and cannot make further model calls."
                : "This run analyzes original transcripts without using earlier analysis as input.")
        );

        const renderCaseTable = (items, host, mode = "active") => {
        const built = table([
            "Case ID", "Project lineage", "Status", "Meaning Units",
            "Generation", "Inspect"
        ]);
        const body = document.createElement("tbody");
        items.forEach(item => {
            const row = document.createElement("tr");
            cell(row, item.case_number);
            cell(row, item.project_binding_status === "project_bound"
                ? "Sleeping habits" : "Out of scope");
            cell(row, mode === "legacy"
                ? `Legacy unusable · ${item.disposition_reason || "Historical interview data is not analytically usable."}`
                : mode === "attention"
                ? item.report
                    ? "Historical stopped-run output"
                    : `Needs attention${item.last_error ? `: ${item.last_error}` : ""}`
                : item.status === "failed"
                ? `Needs attention${item.last_error ? `: ${item.last_error}` : ""}`
                : item.status.replaceAll("_", " "));
            cell(row, item.report?.meaningUnitCount ?? "—");
            cell(row, item.report
                ? item.report.analytical_audit?.aiAnalysisPassCount === 1
                    && item.report.analytical_audit?.priorAnalysisUsed === false
                    ? "One pass · original transcript"
                    : "Historical stopped workflow"
                : "—");
            const action = document.createElement("td");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = item.report
                ? "Inspect Meaning Units"
                : mode === "legacy" ? "Inspect transcript"
                : item.status === "processing" ? "Processing" : "Not ready";
            button.disabled = !item.report && mode !== "legacy";
            button.addEventListener("click", () => openCase(item.case_number));
            action.appendChild(button);
            if (mode === "attention") {
                const legacyButton = document.createElement("button");
                legacyButton.type = "button";
                legacyButton.textContent = "Move to Legacy cases";
                legacyButton.addEventListener("click", () => markLegacy(item));
                action.appendChild(legacyButton);
            }
            row.appendChild(action);
            body.appendChild(row);
        });
        built.element.appendChild(body);
        host?.appendChild(built.scroll);
        };
        renderCaseTable(payload.cases, tableHost);
        renderCaseTable(payload.attentionCases || [], attentionHost, "attention");
        renderCaseTable(payload.legacyCases || [], legacyHost, "legacy");
        renderStage2();
        pageLabel.textContent = `Page ${payload.page}`;
        previousButton.disabled = payload.page <= 1;
        nextButton.disabled = payload.page * payload.pageSize >= run.source_case_count;
    }

    function renderStage2() {
        const stage2 = payload.stage2 || { run: null, mappings: [] };
        if (!stage2.run) {
            stage2Status.textContent =
                "Waiting for Stage 1 to finish. Stage 2 will start automatically without a researcher approval gate.";
            stage2Provenance.textContent =
                "Categories and Themes remain locked.";
            stage2DownloadButton.disabled = true;
            return;
        }
        stage2Status.textContent =
            `Stage 2 is ${stage2.run.status.replaceAll("_", " ")}. `
            + `${stage2.run.preliminary_completed_count}/${stage2.run.source_case_count} cases have preliminary Codes; `
            + `${stage2.run.refinement_completed_count} preliminary Codes have cross-case assignments; `
            + `${stage2.run.preliminary_failed_count + stage2.run.refinement_failed_count} terminal failures are retained for review.`;
        stage2Provenance.textContent = [
            `Stage 1 run ${stage2.run.stage1_run_id}`,
            `${stage2.run.provider} / ${stage2.run.resolved_model || stage2.run.model}`,
            `reasoning ${stage2.run.reasoning_effort}`,
            stage2.run.analysis_version,
            stage2.run.prompt_version,
            "stop layer: refined Codes"
        ].join(" · ");
        stage2DownloadButton.disabled = !["completed", "completed_with_failures"]
            .includes(stage2.run.status);
        if (!stage2.mappings?.length) return;
        const built = table([
            "Case ID", "Supporting MU / transcript", "Preliminary Code",
            "Refined Code", "Semantic decision"
        ]);
        const body = document.createElement("tbody");
        stage2.mappings.forEach(mapping => {
            const row = document.createElement("tr");
            cell(row, mapping.preliminaryCode?.case_number);
            cell(row, (mapping.meaningUnits || []).map(unit =>
                `MU${unit.unit_number} · message ${unit.message_id}: ${unit.exact_source_text}`
            ).join(" | "));
            cell(row, `CO${mapping.preliminaryCode?.code_number} · ${mapping.preliminaryCode?.code_label}`);
            cell(row, `RCO${mapping.refinedCode?.refined_code_number} · ${mapping.refinedCode?.refined_code_label}`);
            cell(row, `${mapping.decision}: ${mapping.semanticRationale}`);
            body.appendChild(row);
        });
        built.element.appendChild(body);
        stage2Host.appendChild(built.scroll);
    }

    stage2DownloadButton.addEventListener("click", async () => {
        if (!payload.stage2?.run?.id) return;
        stage2DownloadButton.disabled = true;
        setStatus("Preparing the final Stage 2 refined-code mapping…");
        try {
            const response = await fetch(
                `${API_PATH}&download=stage2-csv&runId=${encodeURIComponent(payload.run.id)}&_=${Date.now()}`,
                { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" }
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || "The Stage 2 export could not be prepared.");
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `sleeping-habits-stage2-refined-codes-${payload.stage2.run.id}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            render();
        } catch (error) {
            setStatus(error.message, true);
            stage2DownloadButton.disabled = false;
        }
    });

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
            setStatus(
                `${error.message} If access has expired, choose Lock workspace and unlock again.`,
                true
            );
        } finally {
            loading = false;
        }
    }

    function meaningUnitColor(unitNumber) {
        return `keywordColor${((Number(unitNumber) - 1) % 12) + 1}`;
    }

    function highlightedMessage(message, meaningUnits) {
        const text = message.Message || "";
        const highlights = meaningUnits
            .filter(unit => unit.message_id === message.id)
            .sort((left, right) => left.start_offset - right.start_offset);
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        highlights.forEach(unit => {
            if (unit.start_offset < cursor || unit.end_offset > text.length) return;
            fragment.append(document.createTextNode(text.slice(cursor, unit.start_offset)));
            const annotation = document.createElement("span");
            annotation.className = "meaningUnitAnnotation";
            const colorClass = meaningUnitColor(unit.unit_number);
            const label = document.createElement("span");
            label.className = `meaningUnitCodeLabel ${colorClass}`;
            label.textContent = `MU${unit.unit_number}`;
            const mark = document.createElement("mark");
            mark.className = colorClass;
            mark.textContent = text.slice(unit.start_offset, unit.end_offset);
            mark.title = `MU${unit.unit_number} · stable ID ${unit.id}`;
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
        panel.appendChild(heading("Stage 1 annotated transcript"));
        panel.appendChild(paragraph(
            `Participant code: ${report.participant_code || "—"} · `
            + `Participant ID: ${report.participant_id || "—"} · `
            + `Session ID: ${report.session_id || detail.job.session_id || "—"} · linked match`,
            "transcriptIdentity"
        ));
        panel.appendChild(paragraph(
            "This Stage 1 proposal uses transcripts and stored translations only. Every colored span below is an exact original-transcript Meaning Unit; no Code, Category, or Theme exists at this stage.",
            "muted"
        ));
        const legend = document.createElement("div");
        legend.setAttribute("aria-label", "Meaning Unit colour legend");
        report.meaningUnits.forEach(unit => {
            const item = document.createElement("span");
            item.className = `keywordLegend ${meaningUnitColor(unit.unit_number)}`;
            item.textContent = `MU${unit.unit_number}`;
            item.title = `Stable ID ${unit.id} · message ${unit.message_id}`;
            legend.appendChild(item);
        });
        panel.appendChild(legend);

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
            source.appendChild(highlightedMessage(message, report.meaningUnits));
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

    async function openCase(caseNumber) {
        dialogHeading.textContent = `${caseNumber} · Stage 1 Meaning Units`;
        dialogProvenance.textContent = "Loading exact evidence and provenance…";
        dialogContent.replaceChildren();
        dialog.showModal();
        try {
            const detail = await request(
                `${API_PATH}&case=${encodeURIComponent(caseNumber)}&_=${Date.now()}`
            );
            const report = detail.report;
            if (!report) {
                dialogContent.appendChild(paragraph(
                    detail.job.disposition === "legacy_unusable"
                        ? `Legacy unusable: ${detail.job.disposition_reason || "The respondent content did not qualify for this analysis framework."}`
                        : `This case is ${detail.job.status}; no Stage 1 proposal is available yet.`
                ));
                if (detail.job.disposition === "legacy_unusable") {
                    const rawReport = {
                        participant_code: null,
                        participant_id: detail.job.participant_id,
                        session_id: detail.job.session_id,
                        meaningUnits: []
                    };
                    dialogContent.appendChild(annotatedTranscript(detail, rawReport));
                }
                return;
            }
            dialogProvenance.textContent = [
                `Run ${detail.run.run_number}`,
                `project ${detail.run.project_snapshot?.[0]?.project_name || "Sleeping habits"}`,
                `topic ${detail.run.project_snapshot?.[0]?.research_topic || "Sleeping habits"}`,
                `${report.provider} / requested ${report.model}`,
                `resolved ${report.resolved_model || report.model}`,
                `reasoning ${report.reasoning_effort}`,
                report.analysis_version,
                report.prompt_version,
                `stop layer ${detail.run.stop_layer}`,
                `proposal report ${report.id}`,
                "source: transcripts and stored translations only"
            ].join(" · ");
            dialogContent.appendChild(paragraph(report.case_summary));
            dialogContent.appendChild(annotatedTranscript(detail, report));
            const singlePass = report.analytical_audit?.aiAnalysisPassCount === 1
                && report.analytical_audit?.priorAnalysisUsed === false;
            dialogContent.appendChild(heading(singlePass
                ? "Independent analysis provenance"
                : "Historical stopped-run provenance"));
            dialogContent.appendChild(paragraph(
                report.analytical_audit?.overallSummary
                    || "This report belongs to the stopped historical workflow."
            ));
            if (singlePass) {
                dialogContent.appendChild(paragraph(
                    `AI analysis passes: 1; prior analysis used: no; `
                    + `local exact-transcript validation: completed; Meaning Units: ${report.meaningUnits.length}.`,
                    "muted"
                ));
            }
            const gaps = report.analytical_audit?.omittedRelevantEvidence || [];
            const rejectedUnits = (report.analytical_audit?.meaningUnitChecks || [])
                .filter(check => !check.accepted);
            if (rejectedUnits.length) {
                dialogContent.appendChild(heading("Draft Meaning Units requiring review"));
                dialogContent.appendChild(paragraph(
                    "These exact transcript highlights remain visible as a proposal, but the independent audit did not verify them as final Stage 1 Meaning Units."
                ));
                rejectedUnits.forEach(check => {
                    const block = document.createElement("blockquote");
                    block.appendChild(paragraph(
                        `MU${check.unitNumber} · message ${check.messageId}`,
                        "muted"
                    ));
                    block.appendChild(paragraph(check.explanation));
                    dialogContent.appendChild(block);
                });
            }
            if (gaps.length) {
                dialogContent.appendChild(heading("Exact transcript passages requiring coverage review"));
                dialogContent.appendChild(paragraph(
                    "These passages were found by the independent audit but are not yet represented by a Meaning Unit. The proposal remains inspectable and is not labeled as fully verified."
                ));
                gaps.forEach(gap => {
                    const block = document.createElement("blockquote");
                    block.appendChild(paragraph(`Message ${gap.messageId}`,
                        "muted"));
                    block.appendChild(paragraph(`Original: ${gap.exactSourceText}`));
                    block.appendChild(paragraph(gap.explanation, "muted"));
                    dialogContent.appendChild(block);
                });
            }
            report.meaningUnits.forEach(unit => {
                const block = document.createElement("blockquote");
                block.appendChild(paragraph(
                    `MU${unit.unit_number} · stable ID ${unit.id} · message ${unit.message_id}`,
                    "muted"
                ));
                block.appendChild(paragraph(`Original: ${unit.exact_source_text}`));
                block.appendChild(paragraph(
                    `Offsets ${unit.start_offset}–${unit.end_offset}; occurrence ${unit.occurrence_index}. ${unit.context_note || ""}`,
                    "muted"
                ));
                dialogContent.appendChild(block);
            });
        } catch (error) {
            dialogContent.appendChild(paragraph(error.message, "errorMessage"));
        }
    }

    async function markLegacy(item) {
        const defaultReason =
            "Historical interview model did not elicit sufficiently clear or complete evidence; data is not usable for staged analysis.";
        const reason = window.prompt(
            `Why should ${item.case_number} be classified as a Legacy unusable case?`,
            defaultReason
        )?.trim();
        if (!reason) return;
        await request(API_PATH, {
            method: "POST",
            body: JSON.stringify({
                action: "mark-legacy",
                jobId: item.id,
                reason
            })
        });
        setStatus(`${item.case_number} was moved to Legacy cases. Its transcript and reason remain preserved.`);
        await load({ quiet: true });
    }

    startButton.addEventListener("click", async () => {
        const selectedModel = modelSelect.value.trim();
        if (!selectedModel) return;
        const confirmed = window.confirm(
            `Start Stage 1 Meaning Unit identification for all eligible completed Sleeping habits transcripts using ${selectedModel}? `
            + "This creates a separate proposal version, preserves every earlier report, and does not generate Codes, Categories, or Themes."
        );
        if (!confirmed) return;
        startButton.disabled = true;
        modelSelect.disabled = true;
        setStatus(`Verifying ${selectedModel} against the production API…`);
        try {
            const result = await request(API_PATH, {
                method: "POST",
                body: JSON.stringify({ action: "start", model: selectedModel })
            });
            setStatus(
                `Model verified: ${result.provider} ${result.resolvedModel}, reasoning ${result.reasoningEffort}. `
                + `The ${result.project.project_name} Stage 1 run is queued in source-completion order and stops at ${result.stopLayer}.`
            );
            page = 1;
            await load({ quiet: true });
        } catch (error) {
            setStatus(error.message, true);
            startButton.disabled = false;
            modelSelect.disabled = false;
        }
    });

    downloadButton.addEventListener("click", async () => {
        downloadButton.disabled = true;
        setStatus("Preparing the Stage 1 provenance export…");
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
            link.download = `sleeping-habits-stage1-run-${payload.run?.run_number || "latest"}.csv`;
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

    refreshButton.addEventListener("click", () => load());
    lockButton.addEventListener("click", () => {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        clearTimeout(refreshTimer);
        workspace.hidden = true;
        gate.hidden = false;
        document.getElementById("automaticAnalysisToken").value = "";
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
    document.getElementById("advancedPreliminaryDialogClose")
        .addEventListener("click", () => dialog.close());

    const observer = new MutationObserver(() => {
        if (!workspace.hidden && token()) load({ quiet: true });
    });
    observer.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
    if (!workspace.hidden && token()) load({ quiet: true });
}());
