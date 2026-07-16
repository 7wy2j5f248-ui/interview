(function initializeAnalysisWorkspace() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    let workspace = null;
    let evidenceItemId = null;

    const tokenGate = document.getElementById("analysisTokenGate");
    const workspaceElement = document.getElementById("analysisWorkspace");
    const statusElement = document.getElementById("analysisStatus");
    const runSelect = document.getElementById("analysisRunSelect");
    const evidenceDialog = document.getElementById("evidenceDialog");

    function researcherToken() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function currentPeriod() {
        return window.researcherCorpusPeriod || {
            start: null,
            end: null,
            allTime: true
        };
    }

    function analysisQuery(runId = null) {
        const period = currentPeriod();
        const parameters = new URLSearchParams({ action: "list" });

        if (period.start) {
            parameters.set("start", period.start);
        }

        if (period.end) {
            parameters.set("end", period.end);
        }

        if (runId) {
            parameters.set("runId", runId);
        }

        return `/api/analysis?${parameters.toString()}`;
    }

    async function authorizedRequest(url, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${researcherToken()}`);

        if (options.body) {
            headers.set("Content-Type", "application/json");
        }

        const response = await fetch(url, { ...options, headers });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = new Error(
                typeof data.error === "string"
                    ? data.error
                    : "The analysis request failed."
            );
            error.status = response.status;
            throw error;
        }

        return data;
    }

    function setUnlocked(unlocked) {
        tokenGate.hidden = unlocked;
        workspaceElement.hidden = !unlocked;
    }

    function setStatus(message, isError = false) {
        statusElement.textContent = message;
        statusElement.className = isError ? "errorMessage" : "";
    }

    function clearNewItemForm() {
        document.getElementById("newResearcherTheme").value = "";
        document.getElementById("newResearcherCodes").value = "";
        document.getElementById("newResearcherKeywords").value = "";
        document.getElementById("newResearcherNote").value = "";
    }

    function appendTextBlock(container, label, value) {
        const paragraph = document.createElement("p");
        const strong = document.createElement("strong");
        strong.textContent = `${label}: `;
        paragraph.append(strong, document.createTextNode(value || "—"));
        container.appendChild(paragraph);
    }

    function createWorkingField(labelText, role, value, placeholder = "") {
        const label = document.createElement("label");
        label.className = "analysisField";
        label.textContent = labelText;
        const field = role === "note"
            ? document.createElement("textarea")
            : document.createElement("input");
        field.dataset.role = role;
        field.value = value || "";
        field.placeholder = placeholder || "";
        label.appendChild(field);
        return label;
    }

    function itemWorkingPayload(row, itemId) {
        return {
            action: "save_feedback",
            itemId,
            theme: row.querySelector('[data-role="theme"]').value,
            codes: row.querySelector('[data-role="codes"]').value,
            keywords: row.querySelector('[data-role="keywords"]').value,
            note: row.querySelector('[data-role="note"]').value
        };
    }

    async function postAction(payload, progressMessage) {
        setStatus(progressMessage);

        try {
            workspace = await authorizedRequest("/api/analysis", {
                method: "POST",
                body: JSON.stringify(payload)
            });
            renderWorkspace();
            setStatus("Analysis workspace saved.");

            if (evidenceItemId && evidenceDialog.open) {
                renderEvidenceDialog();
            }

            return true;
        } catch (error) {
            setStatus(error.message, true);
            return false;
        }
    }

    async function saveRow(row, itemId, announce = true) {
        const saved = await postAction(
            itemWorkingPayload(row, itemId),
            "Saving researcher feedback…"
        );

        if (saved && announce) {
            setStatus("Researcher feedback saved. It has not been confirmed.");
        }

        return saved;
    }

    function actionButton(label, handler) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", handler);
        return button;
    }

    function renderItem(item) {
        const row = document.createElement("tr");
        row.dataset.itemId = item.id;

        const suggestionCell = document.createElement("td");
        const provenance = document.createElement("p");
        provenance.className = "provisionalLabel";
        provenance.textContent = item.origin === "ai"
            ? "Original provisional AI suggestion"
            : "Researcher-originated item — no AI suggestion";
        suggestionCell.appendChild(provenance);

        if (item.origin === "ai") {
            appendTextBlock(suggestionCell, "Theme", item.ai_theme);
            appendTextBlock(
                suggestionCell,
                "Codes",
                (item.ai_codes || []).join(", ")
            );
            appendTextBlock(
                suggestionCell,
                "Keywords",
                (item.ai_keywords || []).join(", ")
            );
            appendTextBlock(suggestionCell, "Rationale", item.ai_rationale);
        }

        const feedbackCell = document.createElement("td");
        feedbackCell.append(
            createWorkingField(
                "Theme",
                "theme",
                item.researcher_theme,
                item.ai_theme
            ),
            createWorkingField(
                "Codes (comma separated)",
                "codes",
                (item.researcher_codes || []).join(", "),
                (item.ai_codes || []).join(", ")
            ),
            createWorkingField(
                "Keywords (comma separated)",
                "keywords",
                (item.researcher_keywords || []).join(", "),
                (item.ai_keywords || []).join(", ")
            ),
            createWorkingField(
                "Analytical note",
                "note",
                item.researcher_note
            )
        );

        const evidenceCell = document.createElement("td");
        const includedEvidence = (item.evidence || []).filter(
            evidence => evidence.included
        );
        const collectedRounds = new Set(
            (item.evidence || [])
                .filter(evidence => evidence.source === "feedback_ai")
                .map(evidence => evidence.round)
        );
        appendTextBlock(
            evidenceCell,
            "Included messages",
            String(includedEvidence.length)
        );
        appendTextBlock(
            evidenceCell,
            "Feedback evidence rounds",
            String(collectedRounds.size)
        );
        evidenceCell.appendChild(actionButton("Review supporting messages", () => {
            evidenceItemId = item.id;
            renderEvidenceDialog();
            evidenceDialog.showModal();
        }));

        const actionsCell = document.createElement("td");
        actionsCell.className = "analysisActions";
        const status = document.createElement("span");
        status.className = "statusBadge";
        status.textContent = item.changed_since_confirmation
            ? `${item.status} — changed since confirmation`
            : item.status;
        actionsCell.appendChild(status);

        if (item.confirmed_at) {
            const confirmed = document.createElement("span");
            confirmed.className = "statusBadge";
            confirmed.textContent =
                `Confirmed ${new Date(item.confirmed_at).toLocaleString()}`;
            actionsCell.appendChild(confirmed);
        }

        if (item.status !== "archived") {
            actionsCell.append(
                actionButton("Save feedback / revision", () => {
                    saveRow(row, item.id);
                }),
                actionButton("Collect evidence", async () => {
                    if (await saveRow(row, item.id, false)) {
                        await postAction({
                            action: "collect_evidence",
                            itemId: item.id
                        }, "Collecting evidence from the stored corpus…");
                    }
                }),
                actionButton("Confirm analysis", async () => {
                    if (await saveRow(row, item.id, false)) {
                        await postAction({
                            action: "confirm",
                            itemId: item.id
                        }, "Saving confirmed analytical snapshot…");
                    }
                }),
                actionButton("Archive", () => {
                    postAction({
                        action: "archive",
                        itemId: item.id
                    }, "Archiving analysis item…");
                })
            );
        } else {
            actionsCell.appendChild(actionButton("Reopen", () => {
                postAction({
                    action: "reopen",
                    itemId: item.id
                }, "Reopening analysis item…");
            }));
        }

        row.append(suggestionCell, feedbackCell, evidenceCell, actionsCell);
        return row;
    }

    function renderRunSelector() {
        runSelect.replaceChildren();

        if (!workspace.runs.length) {
            const option = document.createElement("option");
            option.textContent = "No stored run for this period";
            option.value = "";
            runSelect.appendChild(option);
            runSelect.disabled = true;
            return;
        }

        runSelect.disabled = false;
        workspace.runs.forEach(run => {
            const option = document.createElement("option");
            option.value = run.id;
            option.textContent = `${new Date(run.created_at).toLocaleString()} — ${run.status}`;
            option.selected = workspace.run?.id === run.id;
            runSelect.appendChild(option);
        });
    }

    function renderWorkspace() {
        if (!workspace) {
            return;
        }

        renderRunSelector();
        const body = document.getElementById("analysisItemsBody");
        body.replaceChildren();
        document.getElementById("createResearcherItemButton").disabled =
            !workspace.run;

        const generateButton = document.getElementById("generateAnalysisButton");
        generateButton.textContent = workspace.run
            ? "Regenerate as a new analysis run"
            : "Generate AI suggestions";

        const metadata = document.getElementById("analysisRunMetadata");

        if (!workspace.run) {
            metadata.textContent =
                "No stored analysis exists for the active corpus period.";
            setStatus("Generate suggestions when you are ready.");
            return;
        }

        metadata.textContent = [
            `${workspace.run.messages_analyzed} participant messages analysed`,
            `${workspace.run.sessions_analyzed} sessions`,
            `${workspace.run.batches_used} batches`,
            `${workspace.run.skipped_records} skipped records`,
            `${workspace.run.invalid_evidence_ids} rejected evidence IDs`
        ].join(" · ");

        workspace.items.forEach(item => body.appendChild(renderItem(item)));

        if (!workspace.items.length) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 4;
            cell.textContent = "This analysis run has no stored items.";
            row.appendChild(cell);
            body.appendChild(row);
        }
    }

    async function loadStoredAnalysis(runId = null) {
        if (!researcherToken()) {
            return;
        }

        setUnlocked(true);
        setStatus("Loading stored analysis…");

        try {
            workspace = await authorizedRequest(analysisQuery(runId));
            renderWorkspace();
            setStatus("Stored analysis loaded. No AI generation was performed.");
        } catch (error) {
            setStatus(error.message, true);

            if (error.status === 401) {
                sessionStorage.removeItem(TOKEN_STORAGE_KEY);
                setUnlocked(false);
            }
        }
    }

    function evidenceSourceLabel(evidence) {
        if (evidence.source === "feedback_ai") {
            return `Evidence collected after researcher feedback — round ${evidence.round}`;
        }

        if (evidence.source === "researcher_manual") {
            return "Researcher manually added";
        }

        return "Initial AI suggestion";
    }

    function renderEvidenceDialog() {
        const item = workspace?.items.find(entry => entry.id === evidenceItemId);
        const container = document.getElementById("evidenceMessages");
        const select = document.getElementById("manualEvidenceMessage");
        container.replaceChildren();
        select.replaceChildren();

        if (!item) {
            return;
        }

        document.getElementById("evidenceDialogHeading").textContent =
            `Supporting messages — ${item.researcher_theme || item.ai_theme || "analysis item"}`;

        (item.evidence || []).forEach(evidence => {
            const article = document.createElement("article");
            article.className = "evidenceMessage";
            const selection = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = evidence.included;
            checkbox.addEventListener("change", () => {
                postAction({
                    action: "set_evidence",
                    itemId: item.id,
                    evidenceId: evidence.evidenceId,
                    included: checkbox.checked
                }, "Saving evidence selection…");
            });
            selection.append(checkbox, document.createTextNode(
                checkbox.checked ? " Included" : " Excluded"
            ));
            article.appendChild(selection);
            appendTextBlock(article, "Source", evidenceSourceLabel(evidence));
            appendTextBlock(article, "Session", evidence.session || "Unknown / legacy");
            appendTextBlock(article, "Participant", evidence.participant || "Unknown / legacy");
            appendTextBlock(article, "Language", evidence.language || "Unknown / legacy");
            appendTextBlock(
                article,
                "Timestamp",
                evidence.timestamp
                    ? new Date(evidence.timestamp).toLocaleString()
                    : "Unavailable"
            );
            const originalLabel = document.createElement("strong");
            originalLabel.textContent = "Original participant message:";
            const original = document.createElement("p");
            original.className = "evidenceText";
            original.dir = "auto";
            original.textContent = evidence.originalText;
            article.append(originalLabel, original);

            if (evidence.englishTranslation) {
                const translation = document.createElement("div");
                translation.className = "englishTranslation";
                appendTextBlock(
                    translation,
                    "Stored English translation",
                    evidence.englishTranslation
                );
                article.appendChild(translation);
            }

            container.appendChild(article);
        });

        if (!item.evidence?.length) {
            container.textContent = "No supporting messages are linked yet.";
        }

        const linkedIds = new Set(
            (item.evidence || []).map(evidence => evidence.messageId)
        );
        const candidates = workspace.corpusMessages.filter(
            message => !linkedIds.has(message.messageId)
        );
        candidates.forEach(message => {
            const option = document.createElement("option");
            option.value = message.messageId;
            option.textContent = [
                message.session || "Unknown / legacy",
                message.language || "unknown language",
                message.originalText.slice(0, 80)
            ].join(" — ");
            select.appendChild(option);
        });
        select.disabled = candidates.length === 0;
        document.getElementById("addManualEvidenceButton").disabled =
            candidates.length === 0;
    }

    document.getElementById("analysisUnlockButton").addEventListener(
        "click",
        () => {
            const input = document.getElementById("analysisToken");
            const token = input.value;

            if (!token) {
                return;
            }

            sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
            input.value = "";
            loadStoredAnalysis();
        }
    );

    document.getElementById("analysisLockButton").addEventListener(
        "click",
        () => {
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            workspace = null;
            setUnlocked(false);
            statusElement.textContent = "";
        }
    );

    document.getElementById("generateAnalysisButton").addEventListener(
        "click",
        () => {
            const period = currentPeriod();
            postAction({
                action: "generate",
                start: period.start,
                end: period.end
            }, "Generating provisional AI suggestions…");
        }
    );

    runSelect.addEventListener("change", () => {
        if (runSelect.value) {
            loadStoredAnalysis(runSelect.value);
        }
    });

    document.getElementById("createResearcherItemButton").addEventListener(
        "click",
        async () => {
            if (!workspace?.run) {
                return;
            }

            const saved = await postAction({
                action: "create_item",
                runId: workspace.run.id,
                theme: document.getElementById("newResearcherTheme").value,
                codes: document.getElementById("newResearcherCodes").value,
                keywords: document.getElementById("newResearcherKeywords").value,
                note: document.getElementById("newResearcherNote").value
            }, "Creating researcher analytical item…");

            if (saved) {
                clearNewItemForm();
            }
        }
    );

    document.getElementById("closeEvidenceDialogButton").addEventListener(
        "click",
        () => evidenceDialog.close()
    );

    document.getElementById("addManualEvidenceButton").addEventListener(
        "click",
        () => {
            const messageId = document.getElementById("manualEvidenceMessage").value;

            if (evidenceItemId && messageId) {
                postAction({
                    action: "set_evidence",
                    itemId: evidenceItemId,
                    messageId,
                    included: true
                }, "Adding researcher-selected evidence…");
            }
        }
    );

    window.addEventListener("researchercorpusperiodchange", () => {
        if (researcherToken()) {
            loadStoredAnalysis();
        }
    });

    if (researcherToken()) {
        setUnlocked(true);
        setStatus("Waiting for corpus statistics…");
    } else {
        setUnlocked(false);
    }
}());
