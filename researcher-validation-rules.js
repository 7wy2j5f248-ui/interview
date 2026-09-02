(function initializeValidationRulesPage() {
    "use strict";

    const TOKEN_KEY = "researcherDashboardToken";
    const tokenInput = document.getElementById("validationRulesToken");
    const loadButton = document.getElementById("validationRulesLoadButton");
    const status = document.getElementById("validationRulesStatus");
    const workspace = document.getElementById("validationRulesWorkspace");
    const search = document.getElementById("validationRuleSearch");
    const layerFilter = document.getElementById("validationRuleLayer");
    const authorityFilter = document.getElementById("validationRuleAuthority");
    const list = document.getElementById("validationRuleList");
    const resultCount = document.getElementById("validationRuleResultCount");
    let payload = null;

    function token() {
        return tokenInput.value.trim()
            || sessionStorage.getItem(TOKEN_KEY)
            || "";
    }

    function setStatus(message, error = false) {
        status.textContent = message;
        status.className = error ? "error" : "muted";
    }

    function text(value) {
        return value === null || value === undefined || value === ""
            ? "—" : String(value);
    }

    function addDefinition(listElement, term, value) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = text(value);
        listElement.append(dt, dd);
    }

    function authorityLabel(value) {
        if (value === "researcher_directive") return "Researcher directive";
        if (value === "withdrawn_system_derived") {
            return "Withdrawn system-derived rule · prohibited";
        }
        return "System-derived · researcher review required";
    }

    function renderRule(item) {
        const article = document.createElement("article");
        article.className = "ruleCard";
        article.dataset.authority = item.authority;

        const header = document.createElement("div");
        header.className = "ruleHeader";
        const title = document.createElement("div");
        const id = document.createElement("p");
        id.className = "ruleId";
        id.textContent = item.id;
        const heading = document.createElement("h3");
        heading.textContent = item.title;
        title.append(id, heading);
        const badges = document.createElement("div");
        [item.layer, item.object, item.status].forEach(value => {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = value;
            badges.appendChild(badge);
        });
        const authority = document.createElement("span");
        authority.className = `badge${item.authority !== "researcher_directive" ? " reviewBadge" : ""}`;
        authority.textContent = authorityLabel(item.authority);
        badges.appendChild(authority);
        header.append(title, badges);

        const ruleText = document.createElement("p");
        ruleText.textContent = item.rule;
        const details = document.createElement("dl");
        addDefinition(details, "Failure or transformation effect", item.failureEffect);
        addDefinition(details, "Participant/session consequence", item.participantConsequence);
        addDefinition(details, "Responsibility", item.responsibility === "system" ? "System—not participant" : item.responsibility);
        addDefinition(details, "Who decided / approval record", item.decisionRecord);
        addDefinition(details, "Why it exists", item.rationale);
        addDefinition(details, "Model association", item.modelAssociation);
        addDefinition(details, "Introduced", item.introduced);
        addDefinition(details, "Changed or superseded", item.changed);
        addDefinition(details, "Exact implementation source", item.origin);
        article.append(header, ruleText, details);
        return article;
    }

    function renderRules() {
        if (!payload) return;
        const query = search.value.trim().toLocaleLowerCase();
        const layer = layerFilter.value;
        const authority = authorityFilter.value;
        const filtered = payload.rules.filter(item => {
            if (layer && item.layer !== layer) return false;
            if (authority && item.authority !== authority) return false;
            if (!query) return true;
            return JSON.stringify(item).toLocaleLowerCase().includes(query);
        });
        list.replaceChildren(...filtered.map(renderRule));
        resultCount.textContent = `Showing ${filtered.length} of ${payload.rules.length} disclosed rules.`;
    }

    function renderModelContext() {
        const host = document.getElementById("validationModelContext");
        if (!payload.modelContext) {
            host.textContent = payload.modelContextError
                || "No Stage-1 run exists. Application and database rules remain model-independent unless a rule says otherwise.";
        } else {
            const run = payload.modelContext;
            const definitions = document.createElement("dl");
            addDefinition(definitions, "Run", `${run.runNumber} · ${run.status}`);
            addDefinition(definitions, "Provider", run.provider);
            addDefinition(definitions, "Requested model", run.requestedModel);
            addDefinition(definitions, "Resolved model", run.resolvedModel);
            addDefinition(definitions, "Reasoning effort", run.reasoningEffort);
            addDefinition(definitions, "Analysis version", run.analysisVersion);
            addDefinition(definitions, "Prompt version", run.promptVersion);
            addDefinition(definitions, "Execution contract", run.executionContractVersion);
            addDefinition(definitions, "Execution plan hash", run.executionPlanHash);
            addDefinition(definitions, "Authoritative source", run.authoritativeSource);
            addDefinition(definitions, "Legacy analysis input", run.legacyAnalysisInput);
            host.replaceChildren(definitions);
        }
        document.getElementById("frozenResearcherRules").textContent =
            payload.frozenResearcherRules
                ? JSON.stringify(payload.frozenResearcherRules, null, 2)
                : "No frozen run rules are available.";
    }

    function renderRecentControl(item) {
        const article = document.createElement("article");
        article.className = "ruleCard";
        article.dataset.authority = item.classification === "explicit researcher directive"
            ? "researcher_directive" : "system_derived_researcher_review_required";
        const heading = document.createElement("h3");
        heading.textContent = `${item.id} · ${item.title}`;
        const effect = document.createElement("p");
        effect.textContent = item.effect;
        const details = document.createElement("dl");
        addDefinition(details, "Introduced", item.introduced);
        addDefinition(details, "Classification", item.classification);
        addDefinition(details, "Authorization record", item.authorization);
        addDefinition(details, "Repository attribution boundary", item.repositoryAttribution);
        addDefinition(details, "Model association", item.modelAssociation);
        addDefinition(details, "Current status", item.currentStatus);
        addDefinition(details, "Implementation sources", item.source);
        article.append(heading, effect, details);
        return article;
    }

    function renderRecentControls() {
        document.getElementById("recentControlInventoryVersion").textContent =
            `Inventory version: ${payload.recentPlatformControlInventoryVersion}`;
        document.getElementById("recentPlatformControlList").replaceChildren(
            ...payload.recentPlatformControls.map(renderRecentControl)
        );
    }

    function render() {
        document.getElementById("registryVersion").textContent = payload.registryVersion;
        document.getElementById("registryTotal").textContent = payload.summary.total;
        document.getElementById("registryReviewCount").textContent =
            payload.summary.researcherReviewRequired.length;
        document.getElementById("registryBlockerCount").textContent =
            payload.summary.wholeReportBlockers.length;
        document.getElementById("registryWithdrawnBlockerCount").textContent =
            payload.summary.withdrawnWholeReportBlockers.length;
        document.getElementById("registryCommit").textContent =
            payload.repositoryCommit || "Deployment commit unavailable";
        document.getElementById("participantPolicyText").textContent =
            `${payload.participantInclusionPolicy.rule} ${payload.participantInclusionPolicy.readinessBoundary}`;

        const layers = [...new Set(payload.rules.map(item => item.layer))].sort();
        layerFilter.replaceChildren(new Option("All layers", ""),
            ...layers.map(value => new Option(value, value)));
        renderModelContext();
        renderRecentControls();
        renderRules();
        workspace.hidden = false;
    }

    async function load() {
        if (!token()) {
            setStatus("Enter the researcher dashboard token.", true);
            return;
        }
        loadButton.disabled = true;
        setStatus("Loading Stage-1 processing transparency and withdrawn-rule history…");
        try {
            const response = await fetch("/api/automatic-analysis?view=stage1-validation-rules", {
                cache: "no-store",
                headers: { Authorization: `Bearer ${token()}` }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "The rule registry could not be loaded.");
            sessionStorage.setItem(TOKEN_KEY, token());
            payload = data;
            render();
            setStatus(`Loaded ${data.summary.total} current and withdrawn Stage-1 controls.`);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            loadButton.disabled = false;
        }
    }

    loadButton.addEventListener("click", load);
    [search, layerFilter, authorityFilter].forEach(control =>
        control.addEventListener("input", renderRules)
    );

    const stored = sessionStorage.getItem(TOKEN_KEY) || "";
    if (stored) {
        tokenInput.value = stored;
        load();
    }
}());
