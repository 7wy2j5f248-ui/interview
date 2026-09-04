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

    function renderCases() {
        const host = element("v2Cases");
        if (!state.cases.length) {
            host.textContent = "No future case has frozen under an active v2 contract yet.";
            return;
        }
        const table = document.createElement("table");
        const head = document.createElement("thead");
        head.innerHTML = "<tr><th>Case</th><th>Frozen source</th><th>Stage 1</th><th>Attempts</th><th>Researcher action</th></tr>";
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
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "Authorize a separate new attempt";
                button.addEventListener("click", async () => {
                    const reason = window.prompt("Record why you are explicitly authorizing a separate attempt. The earlier attempt remains frozen.");
                    if (!reason?.trim()) return;
                    await post("authorize_new_attempt", { caseId: item.id, reason: reason.trim() });
                    await load();
                });
                action.appendChild(button);
            } else {
                action.textContent = item.stage1_status === "completed" ? "Permanently closed" : "No action required";
            }
            const inspect = document.createElement("button");
            inspect.type = "button";
            inspect.textContent = "Inspect frozen record";
            inspect.addEventListener("click", async () => {
                const record = await request({
                    url: `${API}&caseId=${encodeURIComponent(item.id)}`
                });
                element("v2RecordText").textContent = JSON.stringify(record, null, 2);
                element("v2RecordDialog").showModal();
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
            const run = state.stage2Runs.find(candidate => candidate.cohort_id === item.id);
            const text = document.createElement("p");
            text.textContent = `${item.name} — ${item.status}${run ? `; Stage 2A ${run.status}` : ""}${item.blocked_reason ? `; ${item.blocked_reason}` : ""}`;
            panel.appendChild(text);
            if (item.status === "open") {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "Close and freeze this cohort";
                button.addEventListener("click", async () => {
                    if (!window.confirm("Close this cohort permanently? Its membership will freeze and Stage 2A will start automatically once every member completes Stage 1.")) return;
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
        const counts = Object.fromEntries(["pending", "processing", "provider_pending", "completed", "unresolved"]
            .map(name => [name, state.cases.filter(item => item.stage1_status === name).length]));
        element("v2Metrics").replaceChildren(
            metric("Frozen cases", state.cases.length),
            metric("Stage 1 completed", counts.completed),
            metric("Unresolved blockers", counts.unresolved),
            metric("Open or processing", counts.pending + counts.processing + counts.provider_pending)
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
            maxOutputTokens: Number(output.value),
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
