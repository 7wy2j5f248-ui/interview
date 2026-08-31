(function initializeProjectRules() {
    "use strict";

    const TOKEN_KEY = "researcherDashboardToken";
    const DRAFT_KEY = "pliProjectAnalysisRulesDraftV2";
    const ids = {
        projectName: "analysisProjectName",
        researchTopic: "analysisResearchTopic",
        studyScope: "analysisStudyScope",
        themeRequirements: "analysisThemeRequirements",
        codeDerivationRules: "analysisCodeDerivation",
        themeCodeFitRules: "analysisThemeCodeFit",
        inclusionRules: "analysisInclusionRules",
        exclusionRules: "analysisExclusionRules",
        provenanceExpectations: "analysisProvenance",
        analysisVersionNotes: "analysisVersionNotes"
    };
    const field = id => document.getElementById(id);
    const pin = field("analysisFrameworkPin");
    const projectSelect = field("analysisProjectSelect");
    const dialog = field("analysisFrameworkReviewDialog");
    let workspace = { projects: [], frameworks: [], activeFrameworks: [] };
    let reviewed = null;

    function token() {
        return pin.value || sessionStorage.getItem(TOKEN_KEY) || "";
    }

    function setStatus(message, error = false) {
        const host = field("analysisFrameworkStatus");
        host.textContent = message;
        host.style.color = error ? "#9b1c1c" : "#214f35";
    }

    function activeFramework(projectId) {
        const activeId = workspace.activeFrameworks.find(item =>
            item.project_id === projectId
        )?.framework_id;
        return workspace.frameworks.find(item => item.id === activeId) || null;
    }

    function fill(framework, project) {
        field(ids.projectName).value = project?.project_name || "";
        field(ids.researchTopic).value = project?.research_topic || "";
        field(ids.studyScope).value = framework?.studyScope || "";
        field(ids.themeRequirements).value = framework?.themeRequirements || "";
        field(ids.codeDerivationRules).value = framework?.codeDerivationRules || "";
        field(ids.themeCodeFitRules).value = framework?.themeCodeFitRules || "";
        field(ids.inclusionRules).value = framework?.inclusionRules || "";
        field(ids.exclusionRules).value = framework?.exclusionRules || "";
        field(ids.provenanceExpectations).value = framework?.provenanceExpectations || "";
        field(ids.analysisVersionNotes).value = "";
        field(ids.projectName).readOnly = Boolean(project);
        field(ids.researchTopic).readOnly = Boolean(project);
    }

    function collect() {
        return {
            action: "save_analysis_framework",
            projectId: projectSelect.value || null,
            ...Object.fromEntries(Object.entries(ids).map(([key, id]) =>
                [key, field(id).value.trim()]
            )),
            applicationScope: "future_only"
        };
    }

    function requireFields(value) {
        const required = [
            "projectName", "researchTopic", "studyScope",
            "themeRequirements", "codeDerivationRules",
            "themeCodeFitRules", "inclusionRules", "exclusionRules",
            "provenanceExpectations"
        ];
        if (required.some(key => !value[key])) {
            throw new Error("Complete every project analysis-rule field.");
        }
    }

    function saveDraft() {
        const draft = {
            projectId: projectSelect.value || null,
            value: collect(),
            savedAt: new Date().toISOString()
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        field("discardAnalysisFrameworkDraft").disabled = false;
        field("analysisFrameworkDraftStatus").textContent =
            `Draft protected at ${new Date(draft.savedAt).toLocaleTimeString()}.`;
    }

    function restoreDraft() {
        try {
            const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
            if (!draft?.value) return false;
            if (draft.projectId && workspace.projects.some(project =>
                project.id === draft.projectId
            )) projectSelect.value = draft.projectId;
            Object.entries(ids).forEach(([key, id]) => {
                if (typeof draft.value[key] === "string") {
                    field(id).value = draft.value[key];
                }
            });
            field("discardAnalysisFrameworkDraft").disabled = false;
            field("analysisFrameworkDraftStatus").textContent =
                `Protected draft restored from ${new Date(draft.savedAt).toLocaleString()}.`;
            return true;
        } catch {
            return false;
        }
    }

    function renderHistory() {
        const projectId = projectSelect.value;
        const records = workspace.frameworks
            .filter(item => item.projectId === projectId)
            .sort((a, b) => b.versionNumber - a.versionNumber);
        const host = field("analysisFrameworkHistory");
        if (!records.length) {
            host.textContent = "No project rule version exists yet.";
            return;
        }
        const list = document.createElement("ol");
        records.forEach(item => {
            const row = document.createElement("li");
            row.style.marginBottom = "10px";
            row.textContent = `v${item.versionNumber}${
                activeFramework(projectId)?.id === item.id ? " · active" : ""
            } · future analysis only · ${
                item.createdAt ? new Date(item.createdAt).toLocaleString() : "timestamp unavailable"
            }${item.predecessorId ? ` · predecessor ${item.predecessorId}` : " · first version"}${
                item.versionNotes ? ` — ${item.versionNotes}` : ""
            }`;
            list.appendChild(row);
        });
        host.replaceChildren(list);
    }

    function renderProjects() {
        const create = document.createElement("option");
        create.value = "";
        create.textContent = "Start a new research project/topic";
        projectSelect.replaceChildren(create);
        workspace.projects.forEach(project => {
            const option = document.createElement("option");
            option.value = project.id;
            option.textContent = `${project.project_name} — ${project.research_topic}`;
            projectSelect.appendChild(option);
        });
        const initial = workspace.projects.find(project =>
            activeFramework(project.id)
        ) || workspace.projects[0] || null;
        projectSelect.value = initial?.id || "";
        fill(initial ? activeFramework(initial.id) : null, initial);
        restoreDraft();
        renderHistory();
    }

    async function loadWorkspace() {
        if (!token()) throw new Error("Enter the researcher PIN.");
        setStatus("Loading project rule history…");
        const response = await fetch("/api/saveDesign?action=analysis_framework", {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token()}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Unable to load project rules.");
        sessionStorage.setItem(TOKEN_KEY, token());
        workspace = data;
        renderProjects();
        setStatus("Project rule history loaded. Saving creates a future-only version.");
    }

    function reviewField(label, value) {
        const section = document.createElement("section");
        section.style.marginBottom = "14px";
        const heading = document.createElement("h3");
        heading.textContent = label;
        const body = document.createElement("div");
        body.textContent = value || "—";
        body.style.whiteSpace = "pre-wrap";
        section.append(heading, body);
        return section;
    }

    field("loadAnalysisFrameworkButton").addEventListener("click", () => {
        loadWorkspace().catch(error => setStatus(error.message, true));
    });
    projectSelect.addEventListener("change", () => {
        const project = workspace.projects.find(item =>
            item.id === projectSelect.value
        ) || null;
        fill(project ? activeFramework(project.id) : null, project);
        renderHistory();
        saveDraft();
    });
    Object.values(ids).forEach(id => field(id).addEventListener("input", saveDraft));
    field("discardAnalysisFrameworkDraft").addEventListener("click", () => {
        localStorage.removeItem(DRAFT_KEY);
        field("discardAnalysisFrameworkDraft").disabled = true;
        const project = workspace.projects.find(item => item.id === projectSelect.value) || null;
        fill(project ? activeFramework(project.id) : null, project);
    });
    field("reviewAnalysisFrameworkButton").addEventListener("click", () => {
        try {
            reviewed = collect();
            requireFields(reviewed);
            const summary = field("analysisFrameworkReviewSummary");
            summary.replaceChildren(
                reviewField("Project", reviewed.projectName),
                reviewField("Research topic", reviewed.researchTopic),
                reviewField("Study scope", reviewed.studyScope),
                reviewField("Theme guidance", reviewed.themeRequirements),
                reviewField("Meaning-unit and code guidance", reviewed.codeDerivationRules),
                reviewField("Category and theme guidance", reviewed.themeCodeFitRules),
                reviewField("Inclusion rules", reviewed.inclusionRules),
                reviewField("Exclusion rules", reviewed.exclusionRules),
                reviewField("Provenance", reviewed.provenanceExpectations),
                reviewField("Version notes", reviewed.analysisVersionNotes),
                reviewField("Application", "Future analysis only; no completed report will be queued or changed.")
            );
            field("analysisFrameworkSaveStatus").textContent = "";
            dialog.showModal();
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    field("analysisFrameworkBackButton").addEventListener("click", () => {
        reviewed = null;
        dialog.close();
    });
    field("confirmAnalysisFrameworkButton").addEventListener("click", async event => {
        if (!reviewed) return;
        const button = event.currentTarget;
        button.disabled = true;
        const saveStatus = field("analysisFrameworkSaveStatus");
        saveStatus.textContent = "Saving immutable project rule version…";
        try {
            const response = await fetch("/api/saveDesign", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(reviewed)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || "Unable to save project rules.");
            localStorage.removeItem(DRAFT_KEY);
            reviewed = null;
            saveStatus.textContent = `${result.message} ${result.scopeExplanation}`;
            await loadWorkspace();
            projectSelect.value = result.projectId;
            renderHistory();
        } catch (error) {
            saveStatus.textContent = error.message;
            saveStatus.style.color = "#9b1c1c";
        } finally {
            button.disabled = false;
        }
    });

    const storedToken = sessionStorage.getItem(TOKEN_KEY);
    if (storedToken) {
        pin.value = storedToken;
        loadWorkspace().catch(error => setStatus(error.message, true));
    }
}());
