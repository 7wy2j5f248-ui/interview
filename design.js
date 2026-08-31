(function initializeDesignReview() {
    "use strict";

    const reviewDialog = document.getElementById("reviewDialog");
    const reviewSummary = document.getElementById("reviewSummary");
    const savePin = document.getElementById("savePin");
    const saveStatus = document.getElementById("saveStatus");
    const confirmSaveButton = document.getElementById("confirmSaveButton");
    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const FRAMEWORK_DRAFT_KEY = "pliAnalysisFrameworkDraftV1";
    const FRAMEWORK_DRAFT_FIELDS = Object.freeze({
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
    });
    const analysisProjectSelect = document.getElementById(
        "analysisProjectSelect"
    );
    const protocolProjectSelect = document.getElementById(
        "protocolProjectSelect"
    );
    const analysisReviewDialog = document.getElementById(
        "analysisFrameworkReviewDialog"
    );
    const analysisReviewSummary = document.getElementById(
        "analysisFrameworkReviewSummary"
    );
    const analysisSaveStatus = document.getElementById(
        "analysisFrameworkSaveStatus"
    );
    const analysisStatus = document.getElementById("analysisFrameworkStatus");
    const analysisPin = document.getElementById("analysisFrameworkPin");
    let frameworkWorkspace = {
        projects: [], frameworks: [], activeFrameworks: [], reanalysisBatches: []
    };
    let reviewedFramework = null;
    const versionInputs = [
        document.getElementById("topicNumber"),
        document.getElementById("versionNumber"),
        document.getElementById("progressNumber")
    ];
    let reviewedDesign = null;

    function positiveInteger(value, label) {
        const parsed = Number(value);

        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`${label} must be a whole number of 1 or greater.`);
        }

        return parsed;
    }

    function protocolVersion() {
        const topic = positiveInteger(versionInputs[0].value, "Topic number");
        const version = positiveInteger(versionInputs[1].value, "Version number");
        const progress = positiveInteger(versionInputs[2].value, "Progress number");
        return `${topic}.${version}.${progress}`;
    }

    function updateVersionPreview() {
        const values = versionInputs.map((input, index) => {
            const value = Number(input.value);
            return Number.isInteger(value) && value > 0
                ? value
                : [2, 1, 4][index];
        });

        document.getElementById("protocolVersionPreview").textContent =
            values.join(".");
    }

    function collectDesign() {
        return {
            projectId: protocolProjectSelect.value,
            researchTitle: document.getElementById("researchTitle").value,
            protocolVersion: protocolVersion(),
            versionNotes: document.getElementById("versionNotes").value,
            researchPurpose: document.getElementById("researchPurpose").value,
            interviewTopic: document.getElementById("interviewTopic").value,
            interviewModel: document.getElementById("interviewModel").value,
            interviewQuestions: document.getElementById("interviewQuestions").value,
            aiRole: document.getElementById("aiRole").value,
            researchGoal: document.getElementById("researchGoal").value,
            endingMessage: document.getElementById("endingMessage").value,
            interviewQuestionCount: document.getElementById("interviewQuestionCount").value,
            maximumInterviewerQuestions: document.getElementById("maximumInterviewerQuestions").value
        };
    }

    function reviewField(label, value) {
        const section = document.createElement("section");
        section.style.marginBottom = "16px";
        const heading = document.createElement("h3");
        heading.textContent = label;
        heading.style.marginBottom = "4px";
        const text = document.createElement("div");
        text.textContent = String(value || "—");
        text.style.whiteSpace = "pre-wrap";
        section.append(heading, text);
        return section;
    }

    function renderReview(design) {
        reviewSummary.replaceChildren(
            reviewField("Research title", design.researchTitle),
            reviewField("Protocol version", design.protocolVersion),
            reviewField("Version notes", design.versionNotes),
            reviewField("Research purpose", design.researchPurpose),
            reviewField("Interview topic", design.interviewTopic),
            reviewField("Interview model", design.interviewModel),
            reviewField("AI role", design.aiRole),
            reviewField("Research goal", design.researchGoal),
            reviewField("Interview questions", design.interviewQuestions),
            reviewField("Ending message", design.endingMessage),
            reviewField("Interview question count", design.interviewQuestionCount),
            reviewField("Maximum interviewer questions", design.maximumInterviewerQuestions)
        );
    }

    function setSaveStatus(message, isError = false) {
        saveStatus.textContent = message;
        saveStatus.style.color = isError ? "#9b1c1c" : "#333";
    }

    function setAnalysisStatus(message, isError = false) {
        analysisStatus.textContent = message;
        analysisStatus.style.color = isError ? "#9b1c1c" : "#333";
    }

    function setAnalysisSaveStatus(message, isError = false) {
        analysisSaveStatus.textContent = message;
        analysisSaveStatus.style.color = isError ? "#9b1c1c" : "#333";
    }

    function researcherToken() {
        return analysisPin.value
            || sessionStorage.getItem(TOKEN_STORAGE_KEY)
            || "";
    }

    function field(id) {
        return document.getElementById(id);
    }

    function selectedScope() {
        return document.querySelector(
            'input[name="analysisApplicationScope"]:checked'
        )?.value || "";
    }

    function draftStatus(message, isError = false) {
        const status = field("analysisFrameworkDraftStatus");
        status.textContent = message;
        status.style.color = isError ? "#9b1c1c" : "#2d6a4f";
    }

    function saveFrameworkDraft() {
        const values = Object.fromEntries(Object.entries(
            FRAMEWORK_DRAFT_FIELDS
        ).map(([key, id]) => [key, field(id).value]));
        const draft = {
            projectId: analysisProjectSelect.value || null,
            applicationScope: selectedScope() || "future_only",
            values,
            savedAt: new Date().toISOString()
        };
        try {
            localStorage.setItem(FRAMEWORK_DRAFT_KEY, JSON.stringify(draft));
            field("discardAnalysisFrameworkDraft").disabled = false;
            draftStatus(
                `Unsaved Analysis Framework draft protected automatically at ${
                    new Date(draft.savedAt).toLocaleTimeString()
                }.`
            );
        } catch {
            draftStatus(
                "This browser could not protect the draft automatically. Copy the text before leaving this page.",
                true
            );
        }
    }

    function loadStoredFrameworkDraft() {
        try {
            const parsed = JSON.parse(
                localStorage.getItem(FRAMEWORK_DRAFT_KEY) || "null"
            );
            return parsed?.values && parsed?.savedAt ? parsed : null;
        } catch {
            return null;
        }
    }

    function restoreFrameworkDraft() {
        const draft = loadStoredFrameworkDraft();
        if (!draft) return false;
        if (draft.projectId && frameworkWorkspace.projects.some(
            project => project.id === draft.projectId
        )) {
            analysisProjectSelect.value = draft.projectId;
            protocolProjectSelect.value = draft.projectId;
        } else if (!draft.projectId) {
            analysisProjectSelect.value = "";
        }
        Object.entries(FRAMEWORK_DRAFT_FIELDS).forEach(([key, id]) => {
            if (typeof draft.values[key] === "string") {
                field(id).value = draft.values[key];
            }
        });
        const scope = document.querySelector(
            `input[name="analysisApplicationScope"][value="${
                draft.applicationScope === "include_completed"
                    ? "include_completed"
                    : "future_only"
            }"]`
        );
        if (scope) scope.checked = true;
        const existingProject = Boolean(analysisProjectSelect.value);
        field("analysisProjectName").readOnly = existingProject;
        field("analysisResearchTopic").readOnly = existingProject;
        field("discardAnalysisFrameworkDraft").disabled = false;
        draftStatus(
            `Recovered an unsaved Analysis Framework draft from ${
                new Date(draft.savedAt).toLocaleString()
            }. Review it before saving.`
        );
        return true;
    }

    function clearFrameworkDraft() {
        localStorage.removeItem(FRAMEWORK_DRAFT_KEY);
        field("discardAnalysisFrameworkDraft").disabled = true;
        draftStatus(
            "No unsaved draft. New changes will be protected automatically while you type."
        );
    }

    function collectAnalysisFramework() {
        return {
            action: "save_analysis_framework",
            projectId: analysisProjectSelect.value || null,
            projectName: field("analysisProjectName").value.trim(),
            researchTopic: field("analysisResearchTopic").value.trim(),
            studyScope: field("analysisStudyScope").value.trim(),
            themeRequirements: field("analysisThemeRequirements").value.trim(),
            codeDerivationRules: field("analysisCodeDerivation").value.trim(),
            themeCodeFitRules: field("analysisThemeCodeFit").value.trim(),
            inclusionRules: field("analysisInclusionRules").value.trim(),
            exclusionRules: field("analysisExclusionRules").value.trim(),
            provenanceExpectations: field("analysisProvenance").value.trim(),
            analysisVersionNotes: field("analysisVersionNotes").value.trim(),
            applicationScope: selectedScope()
        };
    }

    function requireFrameworkFields(framework) {
        const labels = {
            projectName: "Project name",
            researchTopic: "Research topic",
            studyScope: "Study topic and scope",
            themeRequirements: "Theme requirements",
            codeDerivationRules: "Code derivation rules",
            themeCodeFitRules: "Theme-to-code fit",
            inclusionRules: "Inclusion rules",
            exclusionRules: "Exclusion rules",
            provenanceExpectations: "Provenance expectations",
            applicationScope: "Application scope"
        };
        const missing = Object.entries(labels).find(([key]) => !framework[key]);
        if (missing) throw new Error(`${missing[1]} is required.`);
    }

    function fillFramework(framework, project) {
        field("analysisProjectName").value = project?.project_name
            || framework?.projectName || "";
        field("analysisResearchTopic").value = project?.research_topic
            || framework?.researchTopic || "";
        field("analysisStudyScope").value = framework?.studyScope || "";
        field("analysisThemeRequirements").value =
            framework?.themeRequirements || "";
        field("analysisCodeDerivation").value =
            framework?.codeDerivationRules || "";
        field("analysisThemeCodeFit").value =
            framework?.themeCodeFitRules || "";
        field("analysisInclusionRules").value =
            framework?.inclusionRules || "";
        field("analysisExclusionRules").value =
            framework?.exclusionRules || "";
        field("analysisProvenance").value =
            framework?.provenanceExpectations || "";
        field("analysisVersionNotes").value = "";
        const existingProject = Boolean(project);
        field("analysisProjectName").readOnly = existingProject;
        field("analysisResearchTopic").readOnly = existingProject;
    }

    function activeFramework(projectId) {
        const activeId = frameworkWorkspace.activeFrameworks.find(
            item => item.project_id === projectId
        )?.framework_id;
        return frameworkWorkspace.frameworks.find(item => item.id === activeId)
            || null;
    }

    function renderProjectOptions() {
        const createOption = document.createElement("option");
        createOption.value = "";
        createOption.textContent = "Start a new research project/topic";
        analysisProjectSelect.replaceChildren(createOption);
        protocolProjectSelect.replaceChildren();
        frameworkWorkspace.projects.forEach(project => {
            const label = `${project.project_name} — ${project.research_topic}`;
            const analysisOption = document.createElement("option");
            analysisOption.value = project.id;
            analysisOption.textContent = label;
            analysisProjectSelect.appendChild(analysisOption);
            const protocolOption = document.createElement("option");
            protocolOption.value = project.id;
            protocolOption.textContent = label;
            protocolProjectSelect.appendChild(protocolOption);
        });
        const initial = frameworkWorkspace.projects.find(project =>
            activeFramework(project.id)
        ) || frameworkWorkspace.projects[0];
        if (initial) {
            analysisProjectSelect.value = initial.id;
            protocolProjectSelect.value = initial.id;
            fillFramework(activeFramework(initial.id), initial);
        } else {
            fillFramework(null, null);
        }
    }

    function renderFrameworkHistory() {
        const host = field("analysisFrameworkHistory");
        const projectId = analysisProjectSelect.value;
        const frameworks = frameworkWorkspace.frameworks
            .filter(item => item.projectId === projectId)
            .sort((a, b) => b.versionNumber - a.versionNumber);
        if (!frameworks.length) {
            host.textContent = "No framework version exists for this project yet.";
            return;
        }
        const list = document.createElement("ol");
        frameworks.forEach(framework => {
            const item = document.createElement("li");
            const active = activeFramework(projectId)?.id === framework.id;
            item.textContent = `v${framework.versionNumber}${active ? " · active" : ""} · ${framework.applicationScope.replaceAll("_", " ")} · ${framework.createdAt ? new Date(framework.createdAt).toLocaleString() : "timestamp unavailable"}${framework.predecessorId ? ` · predecessor ${framework.predecessorId}` : " · first version"}${framework.versionNotes ? ` — ${framework.versionNotes}` : ""}`;
            list.appendChild(item);
        });
        host.replaceChildren(list);
    }

    async function stopFrameworkRun(batch, cancellationReason) {
        const reason = cancellationReason.trim();
        if (!reason) throw new Error("Explain why the older run should stop.");
        if (!window.confirm(
            "Stop this project-wide re-analysis? Queued and in-flight work will be cancelled. Already completed versions remain current and fully auditable."
        )) return;
        setAnalysisStatus("Stopping the older project-wide instruction…");
        const response = await fetch("/api/saveDesign", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${researcherToken()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "cancel_project_wide_reanalysis",
                batchId: batch.id,
                cancellationReason: reason
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || "The older run could not be stopped.");
        }
        await loadFrameworkWorkspace();
        setAnalysisStatus(
            `${result.cancelledCaseCount} case requests stopped. Existing reports remain unchanged. You can now save or start the newer framework instruction.`
        );
    }

    function renderActiveFrameworkRuns() {
        const host = field("analysisFrameworkActiveRuns");
        const projectId = analysisProjectSelect.value;
        const batches = (frameworkWorkspace.reanalysisBatches || []).filter(
            batch => batch.project_id === projectId
        );
        host.replaceChildren();
        if (!batches.length) {
            host.textContent = "No project-wide re-analysis run exists for this project.";
            return;
        }
        batches.forEach(batch => {
            const framework = frameworkWorkspace.frameworks.find(
                item => item.id === batch.analysis_framework_id
            );
            const article = document.createElement("article");
            article.style.border = "1px solid #bbb";
            article.style.borderRadius = "6px";
            article.style.padding = "12px";
            article.style.marginBottom = "12px";
            const heading = document.createElement("strong");
            heading.textContent = `Analysis Framework v${
                framework?.versionNumber || "?"
            } · ${String(batch.status).replaceAll("_", " ")}`;
            const counts = document.createElement("p");
            counts.textContent = `Eligible ${batch.eligible_case_count}; queued ${
                batch.queued_case_count
            }; processing ${batch.processing_case_count}; awaiting review ${
                batch.proposal_ready_case_count
            }; failed ${batch.failed_case_count}; cancelled ${
                batch.cancelled_case_count || 0
            }.`;
            const instruction = document.createElement("p");
            instruction.textContent = batch.researcher_notes;
            article.append(heading, counts, instruction);

            if (batch.cancellation_reason) {
                const stopped = document.createElement("p");
                stopped.textContent = `Cancellation reason: ${batch.cancellation_reason}`;
                stopped.style.color = "#8a1c1c";
                article.appendChild(stopped);
            }

            if (new Set([
                "queued", "processing", "awaiting_review",
                "completed_with_failures", "cancellation_requested"
            ]).has(batch.status)) {
                const reason = document.createElement("textarea");
                reason.rows = 2;
                reason.placeholder =
                    "Why should this older instruction stop?";
                reason.style.width = "100%";
                reason.style.boxSizing = "border-box";
                const stop = document.createElement("button");
                stop.type = "button";
                stop.textContent = "Stop this project-wide run";
                stop.addEventListener("click", () => {
                    stop.disabled = true;
                    stopFrameworkRun(batch, reason.value)
                        .catch(error => setAnalysisStatus(error.message, true))
                        .finally(() => { stop.disabled = false; });
                });
                article.append(reason, stop);
            }
            host.appendChild(article);
        });
    }

    async function loadFrameworkWorkspace() {
        const token = researcherToken();
        if (!token) {
            throw new Error("Enter the researcher PIN to load the framework.");
        }
        setAnalysisStatus("Loading project-bound framework history…");
        const response = await fetch("/api/saveDesign?action=analysis_framework", {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Unable to load framework.");
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        frameworkWorkspace = data;
        renderProjectOptions();
        const recoveredDraft = restoreFrameworkDraft();
        renderFrameworkHistory();
        renderActiveFrameworkRuns();
        setAnalysisStatus(
            recoveredDraft
                ? "Framework history loaded and the protected unsaved draft was restored."
                : "Framework history loaded. Saving always creates a new immutable version."
        );
    }

    function renderAnalysisReview(framework) {
        const project = framework.projectId
            ? frameworkWorkspace.projects.find(item => item.id === framework.projectId)
            : null;
        const scope = framework.applicationScope === "include_completed"
            ? "Include completed interviews from this same project/topic only. Complete and publish new versions automatically while preserving earlier versions for review."
            : "Future analysis only. Leave all existing reports unchanged.";
        analysisReviewSummary.replaceChildren(
            reviewField("Research project", project?.project_name
                || `${framework.projectName} (new project)`),
            reviewField("Research topic", project?.research_topic
                || framework.researchTopic),
            reviewField("Study scope", framework.studyScope),
            reviewField("Theme requirements", framework.themeRequirements),
            reviewField("Code derivation", framework.codeDerivationRules),
            reviewField("Theme-to-code fit", framework.themeCodeFitRules),
            reviewField("Inclusion rules", framework.inclusionRules),
            reviewField("Exclusion rules", framework.exclusionRules),
            reviewField("Provenance", framework.provenanceExpectations),
            reviewField("Version notes", framework.analysisVersionNotes),
            reviewField("Application scope", scope)
        );
    }

    versionInputs.forEach(input => input.addEventListener("input", updateVersionPreview));
    updateVersionPreview();

    document.getElementById("reviewButton").addEventListener("click", () => {
        try {
            reviewedDesign = collectDesign();
            renderReview(reviewedDesign);
            savePin.value = "";
            setSaveStatus("");
            reviewDialog.showModal();
        } catch (error) {
            alert(error.message);
        }
    });

    document.getElementById("backToEditButton").addEventListener("click", () => {
        reviewedDesign = null;
        savePin.value = "";
        reviewDialog.close();
    });

    confirmSaveButton.addEventListener("click", async () => {
        const pin = savePin.value;

        if (!reviewedDesign) {
            setSaveStatus("Review the research design again before saving.", true);
            return;
        }

        if (!pin) {
            setSaveStatus("Enter the PIN security code before saving.", true);
            return;
        }

        confirmSaveButton.disabled = true;
        setSaveStatus("Verifying PIN and saving research design…");

        try {
            const response = await fetch("/api/saveDesign", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${pin}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(reviewedDesign)
            });
            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(result.error || "The research design could not be saved.");
            }

            setSaveStatus(result.message || "Research design saved.");
            sessionStorage.setItem(TOKEN_STORAGE_KEY, pin);
            savePin.value = "";
            reviewedDesign = null;
        } catch (error) {
            setSaveStatus(error.message, true);
        } finally {
            confirmSaveButton.disabled = false;
        }
    });

    document.getElementById("loadAnalysisFrameworkButton")
        .addEventListener("click", () => {
            loadFrameworkWorkspace().catch(error =>
                setAnalysisStatus(error.message, true)
            );
        });

    analysisProjectSelect.addEventListener("change", () => {
        const project = frameworkWorkspace.projects.find(
            item => item.id === analysisProjectSelect.value
        ) || null;
        fillFramework(
            project ? activeFramework(project.id) : null,
            project
        );
        if (project) protocolProjectSelect.value = project.id;
        renderFrameworkHistory();
        renderActiveFrameworkRuns();
        saveFrameworkDraft();
    });

    document.getElementById("reviewAnalysisFrameworkButton")
        .addEventListener("click", () => {
            try {
                reviewedFramework = collectAnalysisFramework();
                requireFrameworkFields(reviewedFramework);
                renderAnalysisReview(reviewedFramework);
                setAnalysisSaveStatus("");
                analysisReviewDialog.showModal();
            } catch (error) {
                setAnalysisStatus(error.message, true);
            }
        });

    document.getElementById("analysisFrameworkBackButton")
        .addEventListener("click", () => {
            reviewedFramework = null;
            analysisReviewDialog.close();
        });

    document.getElementById("confirmAnalysisFrameworkButton")
        .addEventListener("click", async event => {
            const button = event.currentTarget;
            if (!reviewedFramework) {
                setAnalysisSaveStatus(
                    "Review the Analysis Framework again before saving.",
                    true
                );
                return;
            }
            const token = researcherToken();
            if (!token) {
                setAnalysisSaveStatus("Enter the researcher PIN first.", true);
                return;
            }
            button.disabled = true;
            setAnalysisSaveStatus(
                "Saving an immutable framework version and its lineage…"
            );
            try {
                const response = await fetch("/api/saveDesign", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(reviewedFramework)
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(
                        result.error || "The Analysis Framework could not be saved."
                    );
                }
                sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
                setAnalysisSaveStatus(
                    `${result.message} ${result.scopeExplanation}`
                );
                setAnalysisStatus(
                    `${result.message} Project and topic lineage preserved.`
                );
                clearFrameworkDraft();
                reviewedFramework = null;
                await loadFrameworkWorkspace();
                analysisProjectSelect.value = result.projectId;
                protocolProjectSelect.value = result.projectId;
                const savedProject = frameworkWorkspace.projects.find(
                    item => item.id === result.projectId
                );
                fillFramework(
                    activeFramework(result.projectId),
                    savedProject
                );
                renderFrameworkHistory();
            } catch (error) {
                setAnalysisSaveStatus(error.message, true);
            } finally {
                button.disabled = false;
            }
        });

    Object.values(FRAMEWORK_DRAFT_FIELDS).forEach(id => {
        field(id).addEventListener("input", saveFrameworkDraft);
    });
    document.querySelectorAll(
        'input[name="analysisApplicationScope"]'
    ).forEach(input => input.addEventListener("change", saveFrameworkDraft));
    field("discardAnalysisFrameworkDraft").addEventListener("click", () => {
        clearFrameworkDraft();
        const project = frameworkWorkspace.projects.find(
            item => item.id === analysisProjectSelect.value
        ) || null;
        fillFramework(project ? activeFramework(project.id) : null, project);
    });

    const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (storedToken) {
        analysisPin.value = storedToken;
        loadFrameworkWorkspace().catch(error =>
            setAnalysisStatus(error.message, true)
        );
    } else {
        protocolProjectSelect.replaceChildren();
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Unlock Analysis Framework to select a project";
        protocolProjectSelect.appendChild(option);
        restoreFrameworkDraft();
    }
}());
