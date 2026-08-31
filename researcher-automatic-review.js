(function initializeAutomaticAnalysisReview() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const MAX_SELECTIONS = 8;
    const bridge = window.automaticAnalysisReviewBridge;
    if (!bridge) return;

    let workspace = { workbookImports: [], threads: [], messages: [] };
    let activeThreadId = null;
    let activeWorkbookId = null;
    let loadingPromise = null;
    const selection = new Map();

    const selectionList = document.getElementById("automaticReviewSelectionList");
    const conversation = document.getElementById("automaticReviewConversation");
    const workbookStatus = document.getElementById("automaticReviewWorkbookStatus");
    const threadSelect = document.getElementById("automaticReviewThreadSelect");
    const input = document.getElementById("automaticReviewDiscussionInput");
    const sendButton = document.getElementById(
        "automaticReviewDiscussionSendButton"
    );

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function sourceKey(source) {
        return `${source.sessionId}:${source.kind}:${source.position || "CASE"}`;
    }

    function sourceLabel(source) {
        return `${source.caseNumber} ${source.position}${
            source.label ? ` · ${source.label}` : ""
        }`;
    }

    function currentCase(source) {
        return bridge.cases().find(caseRecord =>
            caseRecord.transcriptIdentity?.sessionId === source?.sessionId
        ) || null;
    }

    function renderSelection() {
        selectionList.replaceChildren();
        const sources = [...selection.values()];
        if (!sources.length) {
            const empty = document.createElement("span");
            empty.className = "muted";
            empty.textContent = "Select a case, Tn theme, or Cn code above.";
            selectionList.appendChild(empty);
        } else {
            sources.forEach(source => {
                const chip = document.createElement("span");
                chip.className = "automaticReviewSource";
                const label = document.createElement("span");
                label.textContent = sourceLabel(source);
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = "Remove";
                remove.addEventListener("click", () => {
                    selection.delete(sourceKey(source));
                    renderSelection();
                });
                chip.append(label, remove);
                selectionList.appendChild(chip);
            });
        }

        const firstCase = currentCase(sources[0]);
        document.getElementById("automaticReviewOpenTranscriptButton").disabled =
            !firstCase?.transcriptIdentity?.sessionId;
        document.getElementById("automaticReviewOpenReportButton").disabled =
            !firstCase?.hasReport;
        document.getElementById("automaticReviewClearSelectionButton").disabled =
            !sources.length;
        sendButton.disabled = !sources.length;
    }

    function appendMessage(message) {
        const article = document.createElement("article");
        article.className = "analysisChatMessage";
        article.dataset.speaker = message.role;
        const speaker = document.createElement("strong");
        speaker.textContent = message.role === "assistant"
            ? "AI analytical collaborator"
            : "Researcher";
        const content = document.createElement("p");
        content.textContent = message.content;
        article.append(speaker, content);

        const sources = message.selected_sources || [];
        if (sources.length) {
            const line = document.createElement("p");
            line.className = "automaticReviewMessageSources";
            line.textContent = `Source context: ${sources.map(sourceLabel).join("; ")}`;
            article.appendChild(line);
        }

        const assessments = message.provenance?.sourceAssessments || [];
        const groupings = message.provenance?.proposedGroupings || [];
        if (assessments.length || groupings.length) {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Structured review notes and proposed groupings";
            const list = document.createElement("ul");
            assessments.forEach(item => {
                const line = document.createElement("li");
                line.textContent = `${item.caseNumber} ${item.position} · ${
                    String(item.decision).replaceAll("_", " ")
                }: ${item.explanation}`;
                list.appendChild(line);
            });
            groupings.forEach(item => {
                const line = document.createElement("li");
                line.textContent = `${item.caseNumber} ${item.position} · ${
                    item.sourceLabel
                } → ${item.proposedGroup}: ${item.rationale}`;
                list.appendChild(line);
            });
            details.append(summary, list);
            article.appendChild(details);
        }
        conversation.appendChild(article);
    }

    function renderConversation() {
        conversation.replaceChildren();
        if (!workspace.messages.length) {
            const article = document.createElement("article");
            article.className = "analysisChatMessage";
            article.dataset.speaker = "assistant";
            const speaker = document.createElement("strong");
            speaker.textContent = "AI analytical collaborator";
            const content = document.createElement("p");
            content.textContent = "Select a case or a Tn/Cn cell above. We can then check whether a rare theme is correct, should be regrouped or re-abstracted, or needs transcript review.";
            article.append(speaker, content);
            conversation.appendChild(article);
        } else {
            workspace.messages.forEach(appendMessage);
        }
        conversation.scrollTop = conversation.scrollHeight;
    }

    function renderWorkspace() {
        const latest = workspace.workbookImports.find(item =>
            item.id === activeWorkbookId
        ) || workspace.workbookImports[0];
        activeWorkbookId = latest?.id || null;
        workbookStatus.textContent = latest
            ? `Active researcher workbook: ${latest.source_filename} · ${
                new Date(latest.imported_at).toLocaleString()
            }. Its matching case rows are attached to the AI discussion.`
            : "No researcher workbook uploaded yet.";

        threadSelect.replaceChildren();
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "New discussion";
        threadSelect.appendChild(blank);
        workspace.threads.forEach(thread => {
            const option = document.createElement("option");
            option.value = thread.id;
            option.textContent = `${thread.title} · ${
                new Date(thread.updated_at).toLocaleString()
            }`;
            option.selected = thread.id === activeThreadId;
            threadSelect.appendChild(option);
        });
        renderConversation();
        renderSelection();
    }

    function restoreSelection(sources) {
        selection.clear();
        (sources || []).slice(0, MAX_SELECTIONS).forEach(source => {
            selection.set(sourceKey(source), source);
        });
    }

    async function loadWorkspace(threadId = activeThreadId) {
        if (!token()) return;
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            const url = new URL(
                "/api/automatic-analysis-review",
                window.location.origin
            );
            if (threadId) url.searchParams.set("threadId", threadId);
            const response = await fetch(url, {
                cache: "no-store",
                headers: { Authorization: `Bearer ${token()}` }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(
                    data.error || "The second-layer analysis workspace could not be loaded."
                );
            }
            workspace = data;
            activeThreadId = data.activeThreadId || null;
            if (activeThreadId && data.messages?.length) {
                const latestWithSources = [...data.messages].reverse().find(
                    message => (message.selected_sources || []).length
                );
                if (latestWithSources) {
                    restoreSelection(latestWithSources.selected_sources);
                }
            }
            renderWorkspace();
        })().finally(() => {
            loadingPromise = null;
        });
        return loadingPromise;
    }

    function fileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => resolve(
                String(reader.result).split(",")[1] || ""
            ));
            reader.addEventListener("error", () => reject(
                new Error("The selected workbook could not be read.")
            ));
            reader.readAsDataURL(file);
        });
    }

    async function uploadWorkbook(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".xlsx")) {
            throw new Error("Please choose an Excel .xlsx workbook.");
        }
        if (file.size > 3_000_000) {
            throw new Error("The researcher workbook must be smaller than 3 MB.");
        }
        bridge.setStatus("Uploading and indexing the researcher workbook…");
        const response = await fetch("/api/automatic-analysis-review", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "upload_workbook",
                filename: file.name,
                fileBase64: await fileAsBase64(file)
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "The researcher workbook could not be uploaded.");
        }
        activeWorkbookId = data.workbookImport.id;
        await loadWorkspace(activeThreadId);
        bridge.setStatus(data.duplicate
            ? "This workbook was already uploaded. Its preserved researcher layer is active."
            : "Researcher workbook uploaded. Its matching case rows are now available to the AI discussion. Original case reports were preserved."
        );
    }

    async function sendMessage(message) {
        const text = message.trim();
        if (!text || !selection.size) return;
        sendButton.disabled = true;
        bridge.setStatus("AI is checking the selected reports, evidence, and workbook rows…");
        try {
            const response = await fetch("/api/automatic-analysis-review", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    action: "discuss",
                    threadId: activeThreadId,
                    workbookImportId: activeWorkbookId,
                    selection: [...selection.values()],
                    message: text
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "The AI discussion could not continue.");
            }
            activeThreadId = data.thread.id;
            input.value = "";
            await loadWorkspace(activeThreadId);
            bridge.setStatus(
                "AI review ready. The discussion and its exact case/Tn/Cn provenance were saved."
            );
        } finally {
            sendButton.disabled = !selection.size;
        }
    }

    function startNewThread() {
        activeThreadId = null;
        workspace = { ...workspace, activeThreadId: null, messages: [] };
        renderWorkspace();
    }

    window.addEventListener("automatic-analysis-review-source", event => {
        const source = event.detail;
        if (!source?.sessionId || !source?.caseNumber) return;
        const key = sourceKey(source);
        if (selection.has(key)) {
            selection.delete(key);
        } else if (selection.size < MAX_SELECTIONS) {
            selection.set(key, source);
        } else {
            bridge.setStatus(
                "Select no more than eight source records for one discussion turn.",
                true
            );
        }
        renderSelection();
        document.getElementById("automaticAnalysisReview").scrollIntoView({
            behavior: "smooth",
            block: "start"
        });
    });
    window.addEventListener("automatic-analysis-review-ready", () => {
        loadWorkspace().catch(error => bridge.setStatus(error.message, true));
    });

    document.getElementById("automaticReviewUploadButton")
        .addEventListener("click", () =>
            document.getElementById("automaticReviewWorkbookInput").click()
        );
    document.getElementById("automaticReviewWorkbookInput")
        .addEventListener("change", event => {
            uploadWorkbook(event.target.files?.[0])
                .catch(error => bridge.setStatus(error.message, true));
            event.target.value = "";
        });
    document.getElementById("automaticReviewClearSelectionButton")
        .addEventListener("click", () => {
            selection.clear();
            renderSelection();
        });
    document.getElementById("automaticReviewOpenTranscriptButton")
        .addEventListener("click", () => {
            bridge.openTranscriptForSession([...selection.values()][0]?.sessionId);
        });
    document.getElementById("automaticReviewOpenReportButton")
        .addEventListener("click", () => {
            bridge.openReportForSession([...selection.values()][0]?.sessionId);
        });
    document.getElementById("automaticReviewNewThreadButton")
        .addEventListener("click", startNewThread);
    threadSelect.addEventListener("change", () => {
        activeThreadId = threadSelect.value || null;
        if (!activeThreadId) {
            startNewThread();
            return;
        }
        loadWorkspace(activeThreadId)
            .catch(error => bridge.setStatus(error.message, true));
    });
    document.getElementById("automaticReviewDiscussionForm")
        .addEventListener("submit", event => {
            event.preventDefault();
            sendMessage(input.value)
                .catch(error => bridge.setStatus(error.message, true));
        });

    renderWorkspace();
    loadWorkspace().catch(error => bridge.setStatus(error.message, true));
}());
