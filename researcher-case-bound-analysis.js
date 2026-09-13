(function initializeCaseBoundAnalysis() {
    "use strict";
    const API = "/api/automatic-analysis?view=case-bound-v2";
    const token = () => sessionStorage.getItem("researcherDashboardToken") || "";
    const element = id => document.getElementById(id);
    const project = element("v2Project");
    const provider = element("v2Provider");
    const model = element("v2Model");
    const models = element("v2Models");
    const reasoning = element("v2Reasoning");
    const output = element("v2Output");
    const guidelines = element("v2Guidelines");
    const status = element("v2Status");
    const configurationStatus = element("v2ConfigurationStatus");
    let state = null;
    let preview = null;

    async function request(options = {}) {
        const url = options.url || API;
        const { url: ignoredUrl, ...fetchOptions } = options;
        const response = await fetch(url, {
            ...fetchOptions,
            headers: {
                Authorization: `Bearer ${token()}`,
                ...(options.body ? { "Content-Type": "application/json" } : {})
            },
            cache: "no-store"
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
        return body;
    }

    function post(action, values = {}) {
        return request({ method: "POST", body: JSON.stringify({ action, ...values }) });
    }

    function option(value, label, disabled = false) {
        const node = document.createElement("option");
        node.value = value;
        node.textContent = label;
        node.disabled = disabled;
        return node;
    }

    function renderSelections() {
        project.replaceChildren(...(state.projects || []).map(item =>
            option(item.id, `${item.project_name} · ${item.research_topic}`)));
        provider.replaceChildren(...(state.availableProviders || []).map(item =>
            option(item.id, `${item.label}${item.configured ? "" : " (credential unavailable)"}`, !item.configured)));
        models.replaceChildren(...(state.availableModels || []).map(item => option(item, item)));
        if (!model.value && state.availableModels?.length) model.value = state.availableModels[0];
    }

    function metric(label, value) {
        const node = document.createElement("div");
        node.className = "metric";
        const number = document.createElement("strong");
        number.textContent = value;
        node.append(number, document.createTextNode(label));
        return node;
    }

    function make(tag, className, textValue) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (textValue !== undefined && textValue !== null) {
            node.textContent = String(textValue);
        }
        return node;
    }

    function chip(textValue, kind = "") {
        return make("span", `report-chip ${kind}`.trim(), textValue);
    }

    function appendChips(host, values, kind = "") {
        (values || []).forEach(value => host.appendChild(chip(value, kind)));
        if (!(values || []).length) host.appendChild(make("span", "muted", "—"));
    }

    function technicalDetails(record) {
        const details = make("details", "technical-record");
        details.appendChild(make("summary", "", "Technical frozen request and response"));
        details.appendChild(make("p", "muted",
            "This evidence is preserved for exact technical audit. It is not the default research report view."));
        details.appendChild(make("pre", "", JSON.stringify(record, null, 2)));
        return details;
    }

    function reportTable(columns, rows) {
        const wrap = make("div", "table report-table");
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        columns.forEach(column => headRow.appendChild(make("th", "", column.label)));
        head.appendChild(headRow);
        const body = document.createElement("tbody");
        rows.forEach(row => {
            const tableRow = document.createElement("tr");
            columns.forEach(column => {
                const cell = document.createElement("td");
                const value = column.value(row);
                if (value instanceof Node) cell.appendChild(value);
                else cell.textContent = value === null || value === undefined ? "—" : String(value);
                tableRow.appendChild(cell);
            });
            body.appendChild(tableRow);
        });
        table.append(head, body);
        wrap.appendChild(table);
        return wrap;
    }

    function linkedLabels(ids, lookup, kind) {
        const host = make("div", "chip-list");
        (ids || []).forEach(id => {
            const item = lookup.get(id);
            host.appendChild(chip(item ? `${id} · ${item.label || item.statement}` : id, kind));
        });
        return host;
    }

    function connectedHierarchy(report) {
        const unitLookup = new Map(report.meaningUnits.map(item => [item.id, item]));
        const codeLookup = new Map(report.codes.map(item => [item.id, item]));
        const categoryLookup = new Map(report.categories.map(item => [item.id, item]));
        const rows = [];
        report.themes.forEach(theme => theme.categoryIds.forEach(categoryId => {
            const category = categoryLookup.get(categoryId);
            (category?.codeIds || []).forEach(codeId => {
                const code = codeLookup.get(codeId);
                rows.push({ theme, category, code });
            });
        }));
        return reportTable([
            { label: "Tentative Theme", value: row => `${row.theme.id} · ${row.theme.statement}` },
            { label: "Preliminary Category", value: row => `${row.category.id} · ${row.category.label}` },
            { label: "Preliminary Code", value: row => `${row.code.id} · ${row.code.label} · ${row.code.mentionCount} MU mention${row.code.mentionCount === 1 ? "" : "s"}` },
            { label: "Supporting Meaning Units", value: row => {
                const list = document.createElement("ul");
                row.code.meaningUnitIds.forEach(id => {
                    const unit = unitLookup.get(id);
                    list.appendChild(make("li", "", `${id}: ${unit?.exactText || "—"}`));
                });
                return list;
            } }
        ], rows);
    }

    function annotatedTranscript(inspection) {
        const report = inspection.report;
        const codeByMu = new Map();
        const categoryByCode = new Map();
        report.codes.forEach(code => code.meaningUnitIds.forEach(id => {
            const list = codeByMu.get(id) || [];
            list.push(code);
            codeByMu.set(id, list);
        }));
        report.categories.forEach(category => category.codeIds.forEach(id => {
            const list = categoryByCode.get(id) || [];
            list.push(category);
            categoryByCode.set(id, list);
        }));

        function annotationLabel(unit) {
            const codes = codeByMu.get(unit.id) || [];
            const categories = [...new Map(codes.flatMap(code =>
                categoryByCode.get(code.id) || [])
                .map(category => [category.id, category])).values()];
            const parts = [unit.id];
            if (codes.length) {
                parts.push(codes.map(code =>
                    `${code.id} · ${code.label} (${code.mentionCount} MU mention${code.mentionCount === 1 ? "" : "s"})`
                ).join("; "));
            }
            if (categories.length) {
                parts.push(categories.map(category =>
                    `${category.id} · ${category.label}`).join("; "));
            }
            return parts.join(" · ");
        }

        function colorClass(unit) {
            const firstCode = (codeByMu.get(unit.id) || [])[0];
            const number = Number(String(firstCode?.id || unit.id)
                .replace(/\D/gu, "")) || 1;
            return `meaning-unit-color-${((number - 1) % 12) + 1}`;
        }

        function fieldRanges(message, fieldName, sourceText) {
            const ranges = [];
            report.meaningUnits.forEach(unit => unit.segments.forEach(segment => {
                if (String(segment.messageId) !== String(message.id)) return;
                if (segment.textField && segment.textField !== fieldName) return;
                const exact = (segment.exactText || "").trim()
                    .replace(/^[“”"']+|[“”"']+$/gu, "");
                if (!exact) return;
                let start = Number.isInteger(segment.startOffset)
                    ? segment.startOffset : -1;
                let end = Number.isInteger(segment.endOffset)
                    ? segment.endOffset : -1;
                if (start < 0 || end <= start
                    || sourceText.slice(start, end).trim() !== exact) {
                    start = sourceText.indexOf(exact);
                    if (start < 0) {
                        start = sourceText.toLocaleLowerCase().indexOf(
                            exact.toLocaleLowerCase()
                        );
                    }
                    end = start < 0 ? -1 : start + exact.length;
                }
                if (start >= 0 && end > start) ranges.push({ start, end, unit });
            }));
            ranges.sort((left, right) => left.start - right.start
                || left.end - right.end);
            const merged = [];
            ranges.forEach(range => {
                const previous = merged.at(-1);
                if (previous && range.start < previous.end) {
                    previous.end = Math.max(previous.end, range.end);
                    if (!previous.units.some(unit => unit.id === range.unit.id)) {
                        previous.units.push(range.unit);
                    }
                    return;
                }
                merged.push({
                    start: range.start,
                    end: range.end,
                    units: [range.unit]
                });
            });
            return merged;
        }

        function annotatedField(message, fieldName, fieldLabel, sourceText) {
            const paragraph = make("p", `annotated-text transcript-${fieldName}`);
            paragraph.appendChild(make("strong", "transcript-field-label",
                `${fieldLabel}: `));
            const ranges = fieldRanges(message, fieldName, sourceText);
            let cursor = 0;
            ranges.forEach(range => {
                paragraph.appendChild(document.createTextNode(
                    sourceText.slice(cursor, range.start)
                ));
                const annotation = make("span", "inline-mu-annotation");
                const labelText = range.units.map(annotationLabel).join(" | ");
                const color = colorClass(range.units[0]);
                annotation.appendChild(make("span",
                    `inline-mu-label ${color}`, labelText));
                const mark = make("mark", `meaning-unit-mark ${color}`,
                    sourceText.slice(range.start, range.end));
                mark.title = labelText;
                mark.dataset.meaningUnits = range.units
                    .map(unit => unit.id).join(",");
                annotation.appendChild(mark);
                paragraph.appendChild(annotation);
                range.units.forEach(unit => anchored.add(unit.id));
                cursor = range.end;
            });
            paragraph.appendChild(document.createTextNode(sourceText.slice(cursor)));
            return paragraph;
        }

        const anchored = new Set();
        const host = make("div", "transcript-report");
        inspection.transcript.forEach(message => {
            const card = make("article", `transcript-turn ${message.speaker}`);
            card.appendChild(make("h4", "",
                `${message.turnId} · ${message.speaker === "participant" ? "Participant" : "Interviewer"}`));
            if (message.originalText) {
                card.appendChild(annotatedField(
                    message, "original",
                    `Original${message.language ? ` (${message.language})` : ""}`,
                    message.originalText
                ));
            }
            if (message.englishText
                && message.englishText !== message.originalText) {
                card.appendChild(annotatedField(
                    message, "english", "English analytical text",
                    message.englishText
                ));
            }
            host.appendChild(card);
        });
        const unanchored = report.meaningUnits.filter(unit => !anchored.has(unit.id));
        if (unanchored.length) {
            const panel = make("div", "warning");
            panel.appendChild(make("strong", "", "Meaning Units not found verbatim in the stored transcript"));
            panel.appendChild(make("p", "",
                "Their exact GPT-5.6 text remains below, but the interface does not invent a passage location when it cannot find the text in either the original message or its English analytical text."));
            const list = document.createElement("ul");
            unanchored.forEach(unit => list.appendChild(
                make("li", "", `${unit.id}: ${unit.exactText}`)));
            panel.appendChild(list);
            host.appendChild(panel);
        }
        return host;
    }

    function showCaseReport(record) {
        const inspection = record.inspection;
        const report = inspection.report;
        const codeLookup = new Map(report.codes.map(item => [item.id, item]));
        const categoryLookup = new Map(report.categories.map(item => [item.id, item]));
        const content = element("v2RecordContent");
        content.replaceChildren();
        element("v2RecordTitle").textContent = `${inspection.caseNumber} · Stage 1 report`;

        const completion = make("div", "contract report-completion");
        completion.appendChild(make("strong", "", "Stage 1 report submitted"));
        completion.appendChild(make("p", "",
            "The complete MU → CO → CA → TH report is required before Stage 1 can be complete. Viewing this page is optional and never affects progression."));
        content.appendChild(completion);

        const provenance = make("section", "report-section provenance");
        provenance.appendChild(make("h3", "", "Source and lineage"));
        const p = inspection.provenance;
        provenance.appendChild(make("p", "lineage-primary",
            `${p.provider || "Provider"} · ${p.model || "model unavailable"} · ${p.reasoningEffort || "reasoning unavailable"} reasoning`));
        provenance.appendChild(make("p", p.sourceResponseHashMatches ? "lineage-ok" : "warning",
            p.sourceResponseHashMatches
                ? "Verified: this report is derived from the exact frozen provider response. No GPT-5.1 analytical content and no new AI call were used."
                : "The frozen-response hash could not be verified in this view."));
        provenance.appendChild(make("p", "muted",
            `Attempt ${p.attemptNumber || "—"}; preserved provider status: ${p.providerStatus || "—"}; source response SHA-256: ${p.sourceResponseSha256 || "—"}`));
        content.appendChild(provenance);

        const metrics = make("div", "grid report-metrics");
        [
            ["Transcript messages", inspection.counts.messages],
            ["Participant turns", inspection.counts.participantTurns],
            ["Meaning Units", inspection.counts.meaningUnits],
            ["Preliminary Codes", inspection.counts.codes],
            ["Preliminary Categories", inspection.counts.categories],
            ["Tentative Themes", inspection.counts.themes],
            ["Linked MU mentions", inspection.counts.linkedMeaningUnitMentions]
        ].forEach(([label, value]) => metrics.appendChild(metric(label, value)));
        content.appendChild(metrics);

        const transcriptSection = make("section", "report-section");
        transcriptSection.appendChild(make("h3", "", "Full transcript with inline MU highlights"));
        transcriptSection.appendChild(make("p", "muted",
            "Each GPT-5.6 Meaning Unit is highlighted directly inside its stored message. Its MU, linked Code, and linked Category labels sit immediately above that passage. The original-language message is always shown; when the analysis used an English translation, that translation appears directly below the same original message with its own inline highlights."));
        transcriptSection.appendChild(annotatedTranscript(inspection));
        content.appendChild(transcriptSection);

        const hierarchy = make("section", "report-section");
        hierarchy.appendChild(make("h3", "", "MU → CO → CA → TH hierarchy"));
        hierarchy.appendChild(make("p", "muted",
            "A mention count is the mechanical number of linked Meaning Units, not a quality judgment or keyword count."));
        hierarchy.appendChild(make("h4", "", "Connected four-layer report"));
        hierarchy.appendChild(connectedHierarchy(report));
        hierarchy.appendChild(make("h4", "", "Preliminary Codes"));
        hierarchy.appendChild(reportTable([
            { label: "Code", value: row => `${row.id} · ${row.label}` },
            { label: "MU mentions", value: row => row.mentionCount },
            { label: "Meaning Units", value: row => { const host = make("div", "chip-list"); appendChips(host, row.meaningUnitIds, "mu"); return host; } },
            { label: "Categories", value: row => linkedLabels(row.categoryIds, categoryLookup, "ca") }
        ], report.codes));
        hierarchy.appendChild(make("h4", "", "Preliminary Categories"));
        hierarchy.appendChild(reportTable([
            { label: "Category", value: row => `${row.id} · ${row.label}` },
            { label: "MU mentions", value: row => row.mentionCount },
            { label: "Codes", value: row => linkedLabels(row.codeIds, codeLookup, "co") }
        ], report.categories));
        hierarchy.appendChild(make("h4", "", "Preliminary Tentative Themes"));
        hierarchy.appendChild(reportTable([
            { label: "Theme", value: row => `${row.id} · ${row.statement}` },
            { label: "MU mentions", value: row => row.mentionCount },
            { label: "Categories", value: row => linkedLabels(row.categoryIds, categoryLookup, "ca") }
        ], report.themes));
        content.appendChild(hierarchy);
        content.appendChild(technicalDetails(record));
        element("v2RecordDialog").showModal();
    }

    function showStage2Report(record) {
        const content = element("v2RecordContent");
        const run = record.run;
        const layer = String(run.analysis_layer).toUpperCase();
        const presentation = record.explicitPresentation?.presentation_json;
        content.replaceChildren();
        element("v2RecordTitle").textContent = `Stage ${layer} report · attempt ${run.attempt_number}`;
        const source = layer === "2A" ? presentation?.harmonized_codes
            : layer === "2B" ? presentation?.harmonized_categories
                : presentation?.harmonized_themes;
        const labelField = layer === "2C" ? "statement" : "label";
        const linkField = layer === "2A" ? "source_codes"
            : layer === "2B" ? "source_categories" : "source_themes";
        const intro = make("div", presentation ? "contract" : "warning");
        intro.appendChild(make("strong", "",
            presentation ? `Stage ${layer} report submitted` : `Stage ${layer} is not finalized with a report`));
        intro.appendChild(make("p", "",
            presentation
                ? "This stored report finalizes the stage. Opening it is optional and has no workflow effect."
                : "The exact attempt remains preserved, but this stage is not report-complete."));
        content.appendChild(intro);
        content.appendChild(make("p", "lineage-primary",
            `${run.provider} · ${run.model} · ${run.reasoning_effort} reasoning · preserved provider status: ${run.provider_status || "—"}`));
        if (presentation) {
            content.appendChild(reportTable([
                { label: layer === "2A" ? "Harmonized Code" : layer === "2B" ? "Harmonized Category" : "Harmonized Theme", value: row => `${row.id} · ${row[labelField]}` },
                { label: "Source mentions", value: row => (row[linkField] || []).length },
                { label: "Frozen source references", value: row => { const host = make("div", "chip-list"); appendChips(host, row[linkField], "source"); return host; } }
            ], source || []));
        }
        content.appendChild(technicalDetails(record));
        element("v2RecordDialog").showModal();
    }

    async function downloadHarmonizedReport(cohort, button) {
        button.disabled = true;
        status.textContent = "Preparing the five-form Harmonized Report from the three exact provider outputs…";
        status.className = "muted";
        try {
            const response = await fetch(
                `${API}&download=harmonized-report-xlsx&cohortId=${encodeURIComponent(cohort.id)}&_=${Date.now()}`,
                {
                    headers: { Authorization: `Bearer ${token()}` },
                    cache: "no-store"
                }
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || "The Harmonized Report could not be prepared.");
            }
            const disposition = response.headers.get("Content-Disposition") || "";
            const filename = disposition.match(/filename="([^"]+)"/u)?.[1]
                || "harmonized-report.xlsx";
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            const cases = response.headers.get("X-Harmonized-Report-Cases") || "all";
            const hco = response.headers.get("X-Harmonized-Codes") || "—";
            const coMentions = response.headers.get("X-Harmonized-Code-Mentions") || "—";
            const hca = response.headers.get("X-Harmonized-Categories") || "—";
            const caMentions = response.headers.get("X-Harmonized-Category-Mentions") || "—";
            const hth = response.headers.get("X-Harmonized-Themes") || "—";
            const thMentions = response.headers.get("X-Harmonized-Theme-Mentions") || "—";
            status.textContent = `Harmonized Report downloaded for ${cases} cases: ${hco} HCO from ${coMentions} preliminary CO mentions; ${hca} HCA from ${caMentions} preliminary CA mentions; ${hth} HTH from ${thMentions} preliminary TH mentions. No AI call or analytical review was made.`;
        } catch (error) {
            status.textContent = error.message;
            status.className = "error";
        } finally {
            button.disabled = false;
        }
    }

    function renderCases() {
        const host = element("v2Cases");
        if (!state.cases.length) {
            host.textContent = "No future case has frozen under an active v2 contract yet.";
            return;
        }
        const table = document.createElement("table");
        const head = document.createElement("thead");
        head.innerHTML = "<tr><th>Case</th><th>Frozen source</th><th>Stage 1</th><th>Attempts</th><th>Optional report view</th></tr>";
        const body = document.createElement("tbody");
        state.cases.forEach(item => {
            const attempts = state.attempts.filter(attempt => attempt.case_id === item.id);
            const row = document.createElement("tr");
            [item.case_number, new Date(item.frozen_at).toLocaleString(), item.stage1_status,
                attempts.map(attempt => {
                    const resolution = attempt.completion_authority
                        === "researcher_pilot_assumption"
                        ? " · researcher-resolved for Stage 2 pilot"
                        : "";
                    return `${attempt.attempt_number}: ${attempt.status}${resolution}`;
                }).join(" · ") || "—"]
                .forEach(value => { const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell); });
            const action = document.createElement("td");
            if (item.stage1_status === "unresolved") {
                const resolve = document.createElement("button");
                resolve.type = "button";
                resolve.textContent = "Start a separate attempt using the active researcher configuration";
                resolve.addEventListener("click", async () => {
                    await post("run_unresolved_stage1", { caseId: item.id });
                    await load();
                });
                action.appendChild(resolve);
                action.appendChild(document.createTextNode(" "));
            }
            const inspect = document.createElement("button");
            inspect.type = "button";
            inspect.textContent = "View annotated Stage 1 report";
            inspect.addEventListener("click", async () => {
                const record = await request({
                    url: `${API}&caseId=${encodeURIComponent(item.id)}`
                });
                showCaseReport(record);
            });
            action.appendChild(document.createTextNode(" "));
            action.appendChild(inspect);
            row.appendChild(action);
            body.appendChild(row);
        });
        table.append(head, body);
        host.replaceChildren(table);
    }

    function renderCohorts() {
        const host = element("v2Cohorts");
        host.replaceChildren();
        (state.cohorts || []).forEach(item => {
            const panel = document.createElement("div");
            panel.className = "contract";
            const runs = state.stage2Runs.filter(candidate => candidate.cohort_id === item.id)
                .sort((left, right) => left.analysis_layer.localeCompare(right.analysis_layer));
            const text = document.createElement("p");
            const runStatus = runs.map(run =>
                `Stage ${run.analysis_layer.toUpperCase()} attempt ${run.attempt_number} ${run.status}`).join("; ");
            text.textContent = `${item.name} — ${item.status}${runStatus ? `; ${runStatus}` : ""}${item.blocked_reason ? `; ${item.blocked_reason}` : ""}`;
            panel.appendChild(text);
            runs.forEach(run => {
                const inspect = document.createElement("button");
                inspect.type = "button";
                inspect.textContent = `${run.status === "completed" ? "View" : "Inspect"} Stage ${run.analysis_layer.toUpperCase()} ${run.status === "completed" ? "report" : "attempt record"} ${run.attempt_number}`;
                inspect.addEventListener("click", async () => {
                    const record = await request({
                        url: `${API}&runId=${encodeURIComponent(run.id)}`
                    });
                    showStage2Report(record);
                });
                panel.appendChild(inspect);
                panel.appendChild(document.createTextNode(" "));
            });
            const latestByLayer = new Map();
            runs.forEach(run => {
                const current = latestByLayer.get(run.analysis_layer);
                if (!current || Number(run.attempt_number) > Number(current.attempt_number)) {
                    latestByLayer.set(run.analysis_layer, run);
                }
            });
            const reportReady = ["2a", "2b", "2c"].every(layer =>
                latestByLayer.get(layer)?.status === "completed");
            const latestSetTerminal = ["2a", "2b", "2c"].every(layer =>
                ["completed", "technically_incomplete", "failed"]
                    .includes(latestByLayer.get(layer)?.status));
            if (latestSetTerminal) {
                const runSet = document.createElement("button");
                runSet.type = "button";
                runSet.textContent = "Run 2A, 2B, and 2C concurrently from the frozen sources";
                runSet.addEventListener("click", async () => {
                    await post("run_stage2_set", { cohortId: item.id });
                    await load();
                });
                panel.appendChild(runSet);
                panel.appendChild(document.createTextNode(" "));
            }
            if (reportReady) {
                const download = document.createElement("button");
                download.type = "button";
                download.textContent = "Download Harmonized Report";
                download.addEventListener("click", () =>
                    downloadHarmonizedReport(item, download));
                panel.appendChild(download);
            }
            if (item.status === "open") {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "Close and freeze this cohort";
                button.addEventListener("click", async () => {
                    if (!window.confirm("Close this cohort permanently? Its membership will freeze and Stage 2A, 2B, and 2C will start concurrently once every member completes Stage 1.")) return;
                    await post("close_cohort", { cohortId: item.id });
                    await load();
                });
                panel.appendChild(button);
            }
            host.appendChild(panel);
        });
        if (!state.cohorts.length) host.textContent = "No v2 cohort has been defined.";
    }

    function render() {
        renderSelections();
        const counts = Object.fromEntries(["pending", "processing", "provider_pending", "report_pending", "completed", "unresolved"]
            .map(name => [name, state.cases.filter(item => item.stage1_status === name).length]));
        element("v2Metrics").replaceChildren(
            metric("Frozen cases", state.cases.length),
            metric("Stage 1 completed", counts.completed),
            metric("Unresolved blockers", counts.unresolved),
            metric("Open or processing", counts.pending + counts.processing + counts.provider_pending + counts.report_pending)
        );
        renderCases();
        renderCohorts();
        status.textContent = "Current stored status loaded. No automatic dashboard refresh is running.";
    }

    async function load() {
        try {
            state = await request();
            render();
        } catch (error) {
            status.textContent = error.message;
            status.className = "error";
        }
    }

    function configurationValues() {
        return {
            projectId: project.value,
            provider: provider.value,
            model: model.value.trim(),
            reasoningEffort: reasoning.value,
            maxOutputTokens: output.value.trim() ? Number(output.value) : null,
            analysisSpecificGuidelines: guidelines.value
        };
    }

    element("v2Preview").addEventListener("click", async () => {
        try {
            preview = await post("preview_configuration", configurationValues());
            element("v2PreviewText").textContent = JSON.stringify(preview, null, 2);
            element("v2PreviewPanel").hidden = false;
            element("v2Activate").disabled = false;
            configurationStatus.textContent = `Preview frozen as ${preview.configurationSha256}. No AI call was made.`;
        } catch (error) {
            configurationStatus.textContent = error.message;
            configurationStatus.className = "error";
        }
    });

    [project, provider, model, reasoning, output, guidelines].forEach(control =>
        control.addEventListener("input", () => {
            preview = null;
            element("v2Activate").disabled = true;
        }));

    element("v2Activate").addEventListener("click", async () => {
        if (!preview || !window.confirm("Activate this exact contract for future completed cases?")) return;
        const result = await post("activate_configuration", {
            ...configurationValues(),
            confirmedConfigurationSha256: preview.configurationSha256
        });
        configurationStatus.textContent = `Activated immutable contract ${result.configurationId}.`;
        preview = null;
        element("v2Activate").disabled = true;
        await load();
    });

    element("v2CreateCohort").addEventListener("click", async () => {
        const name = element("v2CohortName").value.trim();
        if (!name) return;
        await post("create_cohort", { projectId: project.value, name });
        element("v2CohortName").value = "";
        await load();
    });
    element("v2Refresh").addEventListener("click", load);
    element("v2CloseRecord").addEventListener("click", () =>
        element("v2RecordDialog").close());

    if (token()) load();
    element("automaticAnalysisUnlockButton").addEventListener("click", () => {
        if (token()) load();
    });
}());
