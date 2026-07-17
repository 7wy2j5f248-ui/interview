(function initializeAnalysisWorkspace() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    let workspace = null;
    let evidenceItemId = null;
    let provenanceView = null;

    const tokenGate = document.getElementById("analysisTokenGate");
    const workspaceElement = document.getElementById("analysisWorkspace");
    const statusElement = document.getElementById("analysisStatus");
    const runSelect = document.getElementById("analysisRunSelect");
    const evidenceDialog = document.getElementById("evidenceDialog");
    const provenanceDialog = document.getElementById("provenanceDialog");
    const completionFilter = document.getElementById(
        "analysisCompletionFilter"
    );

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
        parameters.set("completion", completionFilter.value);

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
        document.getElementById("newResearcherCodedPhrases").value = "";
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
            codedPhrases: row.querySelector(
                '[data-role="codedPhrases"]'
            ).value,
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

            if (provenanceView && provenanceDialog.open) {
                renderProvenanceDialog();
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

    function linkButton(label, handler) {
        const button = actionButton(label, handler);
        button.className = "linkButton";
        return button;
    }

    function descriptorSummary(descriptors) {
        if (!descriptors) {
            return "Unavailable";
        }

        const values = [
            ["Current country", descriptors.currentCountry],
            ["Origin", descriptors.countryOfOrigin],
            ["Diaspora", descriptors.diasporaStatus],
            ["Gender", descriptors.gender],
            ["Age", descriptors.age],
            ["Birth cohort", descriptors.birthCohort],
            ["Youth status", descriptors.youthStatus],
            ["Education", descriptors.educationLevel],
            ["Social identity", descriptors.socialIdentity]
        ].filter(([, value]) => value !== null && value !== undefined);

        return values.length
            ? values.map(([label, value]) => `${label}: ${value}`).join(" · ")
            : "No structured descriptors recovered";
    }

    function openTranscript(sessionId, messageId = null) {
        if (provenanceDialog.open) {
            provenanceDialog.close();
        }

        if (evidenceDialog.open) {
            evidenceDialog.close();
        }

        window.openResearcherTranscript?.(sessionId, messageId);
    }

    function openProvenance(view) {
        provenanceView = view;
        renderProvenanceDialog();
        provenanceDialog.showModal();
    }

    function provenanceItem() {
        return workspace?.items.find(item =>
            item.id === provenanceView?.itemId
        ) || null;
    }

    function appendBatchDetails(container, batch) {
        appendTextBlock(
            container,
            "Batch",
            `Batch ${batch.batchNumber} of ${batch.totalBatches}`
        );
        appendTextBlock(container, "Stable batch ID", batch.id);
        appendTextBlock(container, "Analysis run", batch.analysisRunId);
        appendTextBlock(container, "Sessions", String(batch.sessionCount));
        appendTextBlock(container, "Messages", String(batch.messageCount));
        appendTextBlock(
            container,
            "Input tokens",
            Number.isInteger(batch.inputTokenCount)
                ? String(batch.inputTokenCount)
                : "Unavailable"
        );
        appendTextBlock(
            container,
            "Grouping criteria",
            JSON.stringify(batch.groupingCriteria || {})
        );

        appendSectionHeading(container, "Language distribution");
        container.appendChild(distributionList(
            batch.languageDistribution,
            entry => `${entry.language}: ${entry.messageCount} messages, ${entry.sessionCount} sessions`
        ));
        appendSectionHeading(container, "Included sessions");

        if (!batch.sessions.length) {
            const note = document.createElement("p");
            note.className = "muted";
            note.textContent = "No usable session identifier was stored for this legacy batch.";
            container.appendChild(note);
            return;
        }

        batch.sessions.forEach(session => {
            const article = document.createElement("article");
            article.className = "provenanceCard";
            appendTextBlock(article, "Session", session.sessionId);
            appendTextBlock(article, "Participant", session.participantId);
            appendTextBlock(article, "Language", session.language);
            article.appendChild(linkButton("Open complete transcript", () => {
                openTranscript(session.sessionId);
            }));
            container.appendChild(article);
        });
    }

    function renderSupportingSessions(container, item) {
        const sessions = item.provenance?.supportingSessions || [];

        if (!sessions.length) {
            container.textContent = "No supporting sessions are linked.";
            return;
        }

        sessions.forEach(session => {
            const article = document.createElement("article");
            article.className = "provenanceCard";
            appendTextBlock(article, "Session", session.sessionId);
            appendTextBlock(article, "Participant", session.participantId);
            appendTextBlock(article, "Language", session.language);
            appendTextBlock(
                article,
                "Completion status",
                session.completed ? "Completed" : "Incomplete"
            );
            appendTextBlock(
                article,
                "Linked evidence messages",
                String(session.linkedEvidenceMessageCount)
            );
            appendTextBlock(
                article,
                "Available participant descriptors",
                descriptorSummary(session.descriptors)
            );
            article.appendChild(linkButton("Open complete transcript", () => {
                openTranscript(session.sessionId);
            }));
            container.appendChild(article);
        });
    }

    function suggestionAssociationText(evidence) {
        const associations = evidence.associatedSuggestions || {};
        const associatedCodes = [...new Set([
            ...(associations.codes || []),
            ...(evidence.codes || [])
        ])];
        const values = [
            ["Themes", associations.themes],
            ["Codes", associatedCodes],
            ["Coded phrases", associations.codedPhrases],
            ["Keywords", associations.keywords]
        ].filter(([, entries]) => entries?.length);

        return values.length
            ? values.map(([label, entries]) =>
                `${label}: ${entries.join(", ")}`
            ).join(" · ")
            : "No component-specific legacy attribution available";
    }

    function renderSupportingMessages(container, item, component = null) {
        const allowedIds = component
            ? new Set(component.messageIds)
            : null;
        const filteredMessages = (item.evidence || []).filter(evidence =>
            component
                ? allowedIds.has(evidence.messageId)
                : evidence.included
        );
        const messagesById = new Map();
        filteredMessages.forEach(evidence => {
            if (!messagesById.has(evidence.messageId)) {
                messagesById.set(evidence.messageId, evidence);
            }
        });
        const messages = [...messagesById.values()];

        if (!messages.length) {
            container.textContent = component
                ? "No stored source messages are available for this suggestion component."
                : "No supporting messages are linked.";
            return;
        }

        messages.forEach(evidence => {
            const article = document.createElement("article");
            article.className = "provenanceCard";
            appendTextBlock(article, "Message ID", evidence.messageId);
            appendTextBlock(article, "Session", evidence.session);
            appendTextBlock(article, "Participant", evidence.participant);
            appendTextBlock(article, "Language", evidence.language);
            appendTextBlock(article, "Speaker", evidence.speaker);
            appendTextBlock(
                article,
                "Current evidence state",
                evidence.included ? "Included" : "Excluded by researcher"
            );
            appendTextBlock(
                article,
                "Timestamp",
                evidence.timestamp
                    ? new Date(evidence.timestamp).toLocaleString()
                    : "Unavailable"
            );
            appendTextBlock(
                article,
                "Associated analytical suggestions",
                suggestionAssociationText(evidence)
            );
            const originalLabel = document.createElement("strong");
            originalLabel.textContent = "Original transcript message:";
            const original = document.createElement("p");
            original.className = "evidenceText";
            original.dir = "auto";
            original.textContent = evidence.originalText;
            article.append(originalLabel, original);

            if (evidence.englishTranslation) {
                appendTextBlock(
                    article,
                    "Stored English translation",
                    evidence.englishTranslation
                );
            }

            if (evidence.session) {
                article.appendChild(linkButton(
                    "Open this message in the complete transcript",
                    () => openTranscript(evidence.session, evidence.messageId)
                ));
            }
            container.appendChild(article);
        });
    }

    function renderProvenanceDialog() {
        const heading = document.getElementById("provenanceDialogHeading");
        const summary = document.getElementById("provenanceDialogSummary");
        const content = document.getElementById("provenanceDialogContent");
        content.replaceChildren();

        if (provenanceView?.mode === "batch") {
            const batch = workspace?.batches.find(entry =>
                entry.id === provenanceView.batchId
            );

            heading.textContent = batch
                ? `Batch ${batch.batchNumber} of ${batch.totalBatches}`
                : "Batch provenance unavailable";
            summary.textContent = batch?.legacy
                ? "Legacy batch membership reconstructed only from stored run-message batch numbers."
                : "Frozen computational batch membership.";

            if (batch) {
                appendBatchDetails(content, batch);
            }
            return;
        }

        const item = provenanceItem();

        if (!item) {
            heading.textContent = "Analysis provenance unavailable";
            summary.textContent = "The selected analytical item is no longer loaded.";
            return;
        }

        if (provenanceView?.mode === "sessions") {
            heading.textContent = "Supporting sessions";
            summary.textContent =
                `${item.provenance.supportingSessions.length} exact sessions support this analytical item.`;
            renderSupportingSessions(content, item);
            return;
        }

        const component = provenanceView?.component || null;
        heading.textContent = component
            ? `${component.type.replace("_", " ")} source messages — ${component.value}`
            : "Supporting messages";
        summary.textContent = component
            ? "Component-specific source attribution stored with the AI suggestion."
            : "Exact included evidence messages for this analytical item.";
        renderSupportingMessages(content, item, component);
    }

    function appendItemProvenance(container, item) {
        const provenance = item.provenance;
        const section = document.createElement("div");
        section.className = "provenanceSummary";
        const heading = document.createElement("strong");
        heading.textContent = "Source traceability";
        section.appendChild(heading);

        if (!provenance || provenance.status === "unavailable") {
            const note = document.createElement("p");
            note.className = "muted";
            note.textContent = item.origin === "ai"
                ? "Batch provenance unavailable for this legacy analytical item."
                : "Researcher-originated item; no generating AI batch.";
            section.appendChild(note);
            container.appendChild(section);
            return;
        }

        if (provenance.status === "legacy_reconstructed") {
            const note = document.createElement("p");
            note.className = "muted";
            note.textContent =
                "Legacy provenance reconstructed only from stored batch numbers and evidence links; missing component attribution was not invented.";
            section.appendChild(note);
        }

        const batchActions = document.createElement("div");
        batchActions.className = "provenanceActions";
        provenance.batches.forEach(batch => {
            batchActions.appendChild(linkButton(
                `Batch ${batch.batchNumber} of ${batch.totalBatches}`,
                () => openProvenance({
                    mode: "batch",
                    batchId: batch.id
                })
            ));
            const size = document.createElement("span");
            size.textContent =
                `${batch.sessionCount} sessions · ${batch.messageCount} messages · ${batch.supportingSessionCount} of ${batch.sessionCount} supporting sessions in this batch · ${batch.supportingMessageCount} supporting messages`;
            batchActions.appendChild(size);
        });
        section.appendChild(batchActions);

        const supportingSessions = provenance.supportingSessions.length;
        const supportingMessages = new Set(
            (item.evidence || [])
                .filter(evidence => evidence.included)
                .map(evidence => evidence.messageId)
        ).size;
        const actions = document.createElement("div");
        actions.className = "provenanceActions";
        actions.append(
            linkButton(`${supportingSessions} supporting sessions`, () => {
                openProvenance({ mode: "sessions", itemId: item.id });
            }),
            linkButton(`${supportingMessages} supporting messages`, () => {
                openProvenance({ mode: "messages", itemId: item.id });
            })
        );
        section.appendChild(actions);
        appendTextBlock(
            section,
            "Whole-corpus prevalence",
            `${item.descriptiveStatistics?.supportingSessionCount ?? 0} of ${item.descriptiveStatistics?.eligibleSessionCount ?? 0} eligible sessions`
        );

        const componentHeading = document.createElement("strong");
        componentHeading.textContent = "Suggestion-specific sources";
        section.appendChild(componentHeading);
        const componentActions = document.createElement("div");
        componentActions.className = "provenanceActions";
        provenance.components.forEach(component => {
            const label = `${component.type.replace("_", " ")}: ${component.value}`;

            if (!component.available) {
                const unavailable = document.createElement("span");
                unavailable.className = "muted";
                unavailable.textContent = `${label} — legacy attribution unavailable`;
                componentActions.appendChild(unavailable);
                return;
            }

            const button = linkButton(label, () => {
                openProvenance({
                    mode: "messages",
                    itemId: item.id,
                    component
                });
            });
            button.classList.add("componentSourceButton");
            componentActions.appendChild(button);
        });
        section.appendChild(componentActions);
        container.appendChild(section);
    }

    function appendStatisticsSummary(container, statistics) {
        appendTextBlock(
            container,
            "Messages",
            String(statistics?.supportingMessageCount ?? 0)
        );
        appendTextBlock(
            container,
            "Sessions",
            `${statistics?.supportingSessionCount ?? 0} of ${statistics?.eligibleSessionCount ?? 0}`
        );
        appendTextBlock(
            container,
            "Session prevalence",
            Number.isFinite(statistics?.sessionPrevalencePercentage)
                ? `${statistics.sessionPrevalencePercentage.toFixed(1)}%`
                : "Unavailable"
        );
        appendTextBlock(
            container,
            "Participants",
            statistics?.uniqueParticipantCountAvailable
                ? String(statistics.uniqueParticipantCount)
                : "Unavailable"
        );
        appendTextBlock(
            container,
            "Languages",
            String(statistics?.languageCount ?? 0)
        );
    }

    function distributionList(entries, formatter) {
        const list = document.createElement("ul");

        if (!entries?.length) {
            const item = document.createElement("li");
            item.textContent = "No included evidence";
            list.appendChild(item);
            return list;
        }

        entries.forEach(entry => {
            const item = document.createElement("li");
            item.textContent = formatter(entry);
            list.appendChild(item);
        });

        return list;
    }

    function appendSectionHeading(container, text) {
        const heading = document.createElement("strong");
        heading.textContent = text;
        container.appendChild(heading);
    }

    function renderStatistics(item) {
        const cell = document.createElement("td");
        cell.className = "descriptiveStatistics";
        const heading = document.createElement("strong");
        heading.textContent = "Linked-evidence distribution";
        const explanation = document.createElement("p");
        explanation.className = "muted";
        explanation.textContent =
            "Deterministic counts within this frozen analysis corpus.";
        cell.append(heading, explanation);
        appendStatisticsSummary(cell, item.descriptiveStatistics);

        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Distribution details";
        details.appendChild(summary);

        appendSectionHeading(details, "Language distribution");
        details.appendChild(distributionList(
            item.descriptiveStatistics?.languageDistribution,
            language => `${language.label} (${language.code}): ${language.messageCount} messages, ${language.sessionCount} sessions`
        ));
        appendSectionHeading(details, "Per-code distribution");
        details.appendChild(distributionList(
            item.descriptiveStatistics?.perCode,
            code => `${code.code}: ${code.messageCount} messages, ${code.sessionCount} sessions`
        ));
        appendSectionHeading(details, "Evidence rounds");
        details.appendChild(distributionList(
            item.descriptiveStatistics?.evidenceRoundDistribution,
            round => `Round ${round.round} (${round.source}): ${round.messageCount} messages`
        ));
        cell.appendChild(details);

        if (item.confirmed_statistics) {
            const confirmedDetails = document.createElement("details");
            const confirmedSummary = document.createElement("summary");
            confirmedSummary.textContent = "Confirmed statistics snapshot";
            confirmedDetails.appendChild(confirmedSummary);
            appendStatisticsSummary(confirmedDetails, item.confirmed_statistics);
            cell.appendChild(confirmedDetails);
        }

        return cell;
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
                "Coded phrases",
                (item.ai_coded_phrases || []).join(", ")
            );
            appendTextBlock(
                suggestionCell,
                "Keywords",
                (item.ai_keywords || []).join(", ")
            );
            appendTextBlock(suggestionCell, "Rationale", item.ai_rationale);
        }

        appendItemProvenance(suggestionCell, item);

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
                "Coded phrases (comma separated)",
                "codedPhrases",
                (item.researcher_coded_phrases || []).join(", "),
                (item.ai_coded_phrases || []).join(", ")
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

        const statisticsCell = renderStatistics(item);

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

        row.append(
            suggestionCell,
            feedbackCell,
            evidenceCell,
            statisticsCell,
            actionsCell
        );
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
            completionFilter.selectedOptions[0].textContent,
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
            cell.colSpan = 5;
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
        const manualCodes = document.getElementById("manualEvidenceCodes");
        container.replaceChildren();
        select.replaceChildren();
        manualCodes.replaceChildren();

        if (!item) {
            return;
        }

        document.getElementById("evidenceDialogHeading").textContent =
            `Supporting messages — ${item.researcher_theme || item.ai_theme || "analysis item"}`;
        const workingCodes = item.researcher_codes?.length
            ? item.researcher_codes
            : item.ai_codes || [];

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
            appendTextBlock(article, "Speaker", evidence.speaker || "Unknown / legacy");
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

            appendTextBlock(
                article,
                "Associated analytical suggestions",
                suggestionAssociationText(evidence)
            );
            if (evidence.session) {
                article.appendChild(linkButton(
                    "Open this message in the complete transcript",
                    () => openTranscript(evidence.session, evidence.messageId)
                ));
            }

            const attribution = document.createElement("fieldset");
            const attributionLegend = document.createElement("legend");
            attributionLegend.textContent = "Explicit code attribution";
            attribution.appendChild(attributionLegend);
            const attributedKeys = new Set(
                (evidence.codes || []).map(code => code.toLowerCase())
            );

            workingCodes.forEach(code => {
                const label = document.createElement("label");
                const input = document.createElement("input");
                input.type = "checkbox";
                input.value = code;
                input.checked = attributedKeys.has(code.toLowerCase());
                input.dataset.evidenceCode = "true";
                label.append(input, document.createTextNode(` ${code}`));
                attribution.appendChild(label);
            });

            attribution.appendChild(actionButton(
                "Save code attribution",
                () => {
                    const codes = [...attribution.querySelectorAll(
                        '[data-evidence-code="true"]:checked'
                    )].map(input => input.value);
                    postAction({
                        action: "set_evidence",
                        itemId: item.id,
                        evidenceId: evidence.evidenceId,
                        codes
                    }, "Saving code-to-evidence attribution…");
                }
            ));
            article.appendChild(attribution);

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
        workingCodes.forEach(code => {
            const option = document.createElement("option");
            option.value = code;
            option.textContent = code;
            manualCodes.appendChild(option);
        });
        select.disabled = candidates.length === 0;
        manualCodes.disabled = workingCodes.length === 0;
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
                end: period.end,
                completion: completionFilter.value
            }, "Generating provisional AI suggestions…");
        }
    );

    completionFilter.addEventListener("change", () => {
        workspace = null;

        if (researcherToken()) {
            loadStoredAnalysis();
        }
    });

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
                codedPhrases: document.getElementById(
                    "newResearcherCodedPhrases"
                ).value,
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

    document.getElementById("closeProvenanceDialogButton").addEventListener(
        "click",
        () => provenanceDialog.close()
    );

    document.getElementById("addManualEvidenceButton").addEventListener(
        "click",
        () => {
            const messageId = document.getElementById("manualEvidenceMessage").value;

            if (evidenceItemId && messageId) {
                const codes = [...document.getElementById("manualEvidenceCodes").selectedOptions]
                    .map(option => option.value);
                postAction({
                    action: "set_evidence",
                    itemId: evidenceItemId,
                    messageId,
                    codes,
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
