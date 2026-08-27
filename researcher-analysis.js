(function initializeAnalysisWorkspace() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    let workspace = null;
    let evidenceItemId = null;
    let provenanceView = null;
    let activeAnalysisView = "themes";
    let selectedThemeItemId = null;
    let selectedCode = null;
    let pendingDiscussionProposal = null;
    const discussionMessages = new Map();

    const tokenGate = document.getElementById("analysisTokenGate");
    const workspaceElement = document.getElementById("analysisWorkspace");
    const statusElement = document.getElementById("analysisStatus");
    const runSelect = document.getElementById("analysisRunSelect");
    const analysisModel = document.getElementById("analysisModel");
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

    function lifecycleLabel(value, fallback = "Not applicable") {
        if (typeof value !== "string" || !value.trim()) {
            return fallback;
        }

        return value
            .trim()
            .replaceAll("_", " ")
            .replace(/^./, character => character.toUpperCase());
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
            appendTextBlock(
                article,
                "Session status",
                lifecycleLabel(session.sessionStatus)
            );
            appendTextBlock(
                article,
                "End reason",
                lifecycleLabel(session.endReason)
            );
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
                "Session status",
                lifecycleLabel(session.sessionStatus)
            );
            appendTextBlock(
                article,
                "End reason",
                lifecycleLabel(session.endReason)
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
        componentHeading.textContent =
            "Suggestion-specific sources — keyword evidence links";
        section.appendChild(componentHeading);
        const componentActions = document.createElement("div");
        componentActions.className = "provenanceActions";
        provenance.components.filter(component =>
            component.type === "keyword"
        ).forEach(component => {
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
                actionButton("Save theme/code revision", () => {
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
                actionButton("Accept theme and codes", async () => {
                    if (await saveRow(row, item.id, false)) {
                        await postAction({
                            action: "confirm",
                            itemId: item.id
                        }, "Saving confirmed analytical snapshot…");
                    }
                }),
                actionButton("Reject theme", () => {
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

    function workingTheme(item) {
        return item.researcher_theme?.trim() || item.ai_theme?.trim()
            || "Untitled theme";
    }

    function workingList(item, researcherField, aiField) {
        const researcherValues = item[researcherField] || [];
        return researcherValues.length
            ? researcherValues
            : (item[aiField] || []);
    }

    function uniqueValues(values) {
        return [...new Set(values.filter(value =>
            typeof value === "string" && value.trim()
        ).map(value => value.trim()))];
    }

    function itemComponents(item, type) {
        return (item.provenance?.components || []).filter(component =>
            component.type === type
        );
    }

    function componentForValue(item, type, value) {
        const normalizedValue = value.trim().toLocaleLowerCase();
        return itemComponents(item, type).find(component =>
            component.value?.trim().toLocaleLowerCase() === normalizedValue
        ) || {
            type,
            value,
            available: false,
            messageIds: []
        };
    }

    function activeItems() {
        return (workspace?.items || []).filter(item =>
            item.status !== "archived"
        );
    }

    function normalizedLabel(value) {
        return typeof value === "string"
            ? value.trim().toLocaleLowerCase()
            : "";
    }

    function worksheetIdentifier(prefix, index) {
        return `${prefix}${String(index + 1).padStart(2, "0")}`;
    }

    function participantRecords() {
        const participants = new Map();

        function mergeSession(session) {
            const participantId = session?.participantId
                || session?.participant
                || session?.sessionId
                || session?.session
                || "Unknown participant";
            const sessionId = session?.sessionId || session?.session || null;
            const existing = participants.get(participantId) || {
                participantId,
                sessionIds: new Set(),
                language: null,
                descriptors: null
            };
            if (sessionId) {
                existing.sessionIds.add(sessionId);
            }
            existing.language ||= session?.language || null;
            existing.descriptors ||= session?.descriptors || null;
            participants.set(participantId, existing);
        }

        (workspace?.participants || []).forEach(mergeSession);
        (workspace?.corpusMessages || []).forEach(mergeSession);

        (workspace?.items || []).forEach(item => {
            (item.provenance?.supportingSessions || []).forEach(mergeSession);
            (item.evidence || []).forEach(mergeSession);
        });

        return [...participants.values()].sort((first, second) =>
            first.participantId.localeCompare(second.participantId, undefined, {
                numeric: true
            })
        );
    }

    function additionalDescriptor(descriptors, ...keys) {
        const additional = descriptors?.additionalDescriptors || {};
        for (const key of keys) {
            const value = additional[key];
            if (value !== null && value !== undefined && String(value).trim()) {
                return String(value);
            }
        }
        return "—";
    }

    function metadataValues(participant) {
        const descriptors = participant.descriptors || {};
        return [
            participant.language || "—",
            descriptors.currentCountry || "—",
            descriptors.countryOfOrigin || "—",
            descriptors.gender || "—",
            descriptors.age ?? "—",
            additionalDescriptor(
                descriptors,
                "occupation",
                "profession",
                "employment",
                "work"
            ),
            descriptors.educationLevel || "—"
        ];
    }

    function participantEvidence(item, participant) {
        return (item.evidence || []).filter(evidence =>
            (evidence.participant === participant.participantId
                || participant.sessionIds.has(evidence.session))
            && evidence.included !== false
        );
    }

    function sourceIdsForParticipant(item, component, participant) {
        const participantIds = new Set(
            participantEvidence(item, participant).map(evidence =>
                evidence.messageId
            )
        );
        return (component.messageIds || []).filter(messageId =>
            participantIds.has(messageId)
        );
    }

    function itemSupportsParticipant(item, participant) {
        if (participantEvidence(item, participant).length) {
            return true;
        }

        return (item.provenance?.supportingSessions || []).some(session =>
            session.participantId === participant.participantId
            || participant.sessionIds.has(session.sessionId)
        );
    }

    const participantMetadataHeadings = [
        "Language",
        "Country of residence",
        "Country of origin",
        "Gender",
        "Age",
        "Occupation",
        "Education"
    ];

    const PARTICIPANT_THEME_SLOT_COUNT = 8;

    function participantThemeSlotIdentifier(index) {
        return `T${index + 1}`;
    }

    function participantThemeRecords(participant) {
        return activeItems().filter(item =>
            itemSupportsParticipant(item, participant)
        ).map((item, index) => ({
            identifier: participantThemeSlotIdentifier(index),
            label: workingTheme(item),
            item
        }));
    }

    function themeRecords() {
        return activeItems().map((item, index) => ({
            identifier: worksheetIdentifier("T", index),
            label: workingTheme(item),
            item
        }));
    }

    function codeRecords() {
        const records = new Map();
        activeItems().forEach(item => {
            uniqueValues(workingList(
                item,
                "researcher_codes",
                "ai_codes"
            )).forEach(label => {
                const key = normalizedLabel(label);
                if (!records.has(key)) {
                    records.set(key, { label, occurrences: [] });
                }
                records.get(key).occurrences.push({
                    item,
                    component: componentForValue(item, "code", label)
                });
            });
        });
        return [...records.values()].map((record, index) => ({
            ...record,
            identifier: worksheetIdentifier("C", index)
        }));
    }

    function keywordRecords() {
        const records = new Map();
        activeItems().forEach(item => {
            uniqueValues(workingList(
                item,
                "researcher_keywords",
                "ai_keywords"
            )).forEach(label => {
                const key = normalizedLabel(label);
                if (!records.has(key)) {
                    records.set(key, { label, occurrences: [] });
                }
                records.get(key).occurrences.push({
                    item,
                    component: componentForValue(item, "keyword", label)
                });
            });
        });
        return [...records.values()].map((record, index) => ({
            ...record,
            identifier: worksheetIdentifier("K", index)
        }));
    }

    function attributedMessageIds(item, participant, type, label) {
        const key = normalizedLabel(label);
        return participantEvidence(item, participant).filter(evidence => {
            const directValues = type === "code"
                ? (evidence.codes || [])
                : (evidence.associatedSuggestions?.keywords || []);
            const sourceValues = type === "code"
                ? (evidence.associatedSuggestions?.codes || [])
                : [];
            return [...directValues, ...sourceValues].some(value =>
                normalizedLabel(value) === key
            );
        }).map(evidence => evidence.messageId);
    }

    function occurrenceMessageIds(occurrence, participant, type, label) {
        return uniqueValues([
            ...sourceIdsForParticipant(
                occurrence.item,
                occurrence.component,
                participant
            ),
            ...attributedMessageIds(
                occurrence.item,
                participant,
                type,
                label
            )
        ]);
    }

    function appendHeader(row, label, identifier = null) {
        const heading = document.createElement("th");
        heading.scope = "col";
        if (identifier) {
            const id = document.createElement("span");
            id.className = "analysisColumnId";
            id.textContent = identifier;
            heading.append(id, document.createTextNode(label));
        } else {
            heading.textContent = label;
        }
        row.appendChild(heading);
    }

    function worksheetTable(className = "") {
        const table = document.createElement("table");
        table.className = `analysisMatrix ${className}`.trim();
        return table;
    }

    function appendRowHeading(row, value) {
        const cell = document.createElement("th");
        cell.scope = "row";
        cell.textContent = value;
        row.appendChild(cell);
    }

    function appendCell(row, value, className = "") {
        const cell = document.createElement("td");
        cell.textContent = value;
        cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function appendEmptyRow(body, columnCount, message) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = columnCount;
        cell.className = "analysisEmptyRow";
        cell.textContent = message;
        row.appendChild(cell);
        body.appendChild(row);
    }

    function relationCell(row, messageIds) {
        if (!messageIds.length) {
            appendCell(row, "—", "analysisEmptyCell");
            return;
        }
        const label = messageIds.length === 1
            ? "✓ 1 passage"
            : `✓ ${messageIds.length} passages`;
        appendCell(row, label, "analysisRelationCell");
    }

    function selectDiscussionContext(item, code = null) {
        const changed = selectedThemeItemId !== item?.id
            || selectedCode !== code;
        selectedThemeItemId = item?.id || selectedThemeItemId;
        selectedCode = code;
        if (changed) {
            pendingDiscussionProposal = null;
        }
        renderDiscussionPanel(selectedThemeItem());
    }

    function expressionButton(label, item, code = null) {
        const button = actionButton(label, () =>
            selectDiscussionContext(item, code)
        );
        button.className = "worksheetExpressionButton";
        button.title = "Select this row for the AI discussion below";
        return button;
    }

    function switchAnalysisView(view, itemId = null, code = null) {
        const previousContext = `${selectedThemeItemId}:${selectedCode}`;
        activeAnalysisView = view;
        selectedThemeItemId = itemId || selectedThemeItemId;
        selectedCode = code || (view === "themes" ? null : selectedCode);
        if (`${selectedThemeItemId}:${selectedCode}` !== previousContext) {
            pendingDiscussionProposal = null;
        }
        renderHierarchyView();
    }

    function renderThemeWorksheet(container) {
        const participants = participantRecords();
        const table = worksheetTable("themeWorksheet");
        const head = document.createElement("thead");
        const headingRow = document.createElement("tr");
        appendHeader(headingRow, "Participant ID");
        appendHeader(headingRow, "Link to transcript");
        participantMetadataHeadings.forEach(label => appendHeader(
            headingRow,
            label
        ));
        Array.from({ length: PARTICIPANT_THEME_SLOT_COUNT }).forEach(
            (_, slotIndex) => appendHeader(
                headingRow,
                participantThemeSlotIdentifier(slotIndex)
            )
        );
        head.appendChild(headingRow);
        table.appendChild(head);

        const body = document.createElement("tbody");
        participants.forEach(participant => {
            const row = document.createElement("tr");
            appendRowHeading(row, participant.participantId);
            const transcriptCell = document.createElement("td");
            const sessionIds = [...participant.sessionIds];
            if (sessionIds.length) {
                const button = actionButton(
                    sessionIds.length === 1
                        ? "Open transcript"
                        : `Open transcript (${sessionIds.length} sessions)`,
                    () => openTranscript(sessionIds[0])
                );
                button.className = "worksheetTranscriptButton";
                transcriptCell.appendChild(button);
            } else {
                transcriptCell.textContent = "—";
                transcriptCell.className = "analysisEmptyCell";
            }
            row.appendChild(transcriptCell);
            metadataValues(participant).forEach(value => appendCell(
                row,
                String(value)
            ));
            const participantThemes = participantThemeRecords(participant);
            Array.from({ length: PARTICIPANT_THEME_SLOT_COUNT }).forEach(
                (_, slotIndex) => {
                    const theme = participantThemes[slotIndex];
                    if (!theme) {
                        appendCell(row, "—", "analysisEmptyCell");
                        return;
                    }
                    const cell = document.createElement("td");
                    cell.className = "participantThemeCell";
                    cell.dataset.themeSlot = theme.identifier;
                    cell.appendChild(expressionButton(
                        theme.label,
                        theme.item
                    ));
                    row.appendChild(cell);
                }
            );
            if (participantThemes.length > PARTICIPANT_THEME_SLOT_COUNT) {
                const finalCell = row.lastElementChild;
                const overflow = document.createElement("span");
                overflow.className = "analysisColumnDetail";
                overflow.textContent = `+${participantThemes.length - PARTICIPANT_THEME_SLOT_COUNT} additional themes in the individual analysis`;
                finalCell.appendChild(overflow);
            }
            body.appendChild(row);
        });
        if (!participants.length) {
            appendEmptyRow(
                body,
                2 + participantMetadataHeadings.length
                    + PARTICIPANT_THEME_SLOT_COUNT,
                "No interview participants are available in this corpus scope."
            );
        }
        table.appendChild(body);
        container.appendChild(table);
    }

    function selectedThemeItem() {
        const availableItems = (workspace.items || []).filter(item =>
            item.status !== "archived"
        );
        return availableItems.find(item => item.id === selectedThemeItemId)
            || availableItems[0]
            || null;
    }

    function renderCodeWorksheet(container) {
        const themes = themeRecords();
        const codes = codeRecords();
        const rows = [];
        participantRecords().forEach(participant => {
            codes.forEach(code => {
                const relations = themes.map(theme => {
                    const occurrence = code.occurrences.find(entry =>
                        entry.item.id === theme.item.id
                    );
                    return occurrence
                        ? occurrenceMessageIds(
                            occurrence,
                            participant,
                            "code",
                            code.label
                        )
                        : [];
                });
                if (relations.some(messageIds => messageIds.length)) {
                    rows.push({ participant, code, relations });
                }
            });
        });

        const table = worksheetTable("codeWorksheet");
        const head = document.createElement("thead");
        const headingRow = document.createElement("tr");
        appendHeader(headingRow, "Participant ID");
        appendHeader(headingRow, "Code #");
        appendHeader(headingRow, "Expression");
        themes.forEach(theme => appendHeader(
            headingRow,
            theme.label,
            theme.identifier
        ));
        head.appendChild(headingRow);
        table.appendChild(head);

        const body = document.createElement("tbody");
        rows.forEach(entry => {
            const row = document.createElement("tr");
            appendRowHeading(row, entry.participant.participantId);
            appendCell(row, entry.code.identifier, "analysisIdentifierCell");
            const expressionCell = document.createElement("td");
            const relatedThemeIndex = entry.relations.findIndex(
                messageIds => messageIds.length
            );
            const context = entry.code.occurrences.find(occurrence =>
                occurrence.item.id === themes[relatedThemeIndex]?.item.id
            ) || entry.code.occurrences[0];
            expressionCell.appendChild(expressionButton(
                entry.code.label,
                context?.item,
                entry.code.label
            ));
            row.appendChild(expressionCell);
            entry.relations.forEach(messageIds => relationCell(row, messageIds));
            body.appendChild(row);
        });
        if (!rows.length) {
            appendEmptyRow(
                body,
                3 + themes.length,
                workspace?.run
                    ? "No participant–code relationships are available in this analysis run."
                    : "Generate an analysis run to populate codes from the stored interviews."
            );
        }
        table.appendChild(body);
        container.appendChild(table);
    }

    function renderKeywordWorksheet(container) {
        const codes = codeRecords();
        const keywords = keywordRecords();
        const rows = [];
        participantRecords().forEach(participant => {
            keywords.forEach(keyword => {
                const keywordSources = keyword.occurrences.map(occurrence => ({
                    occurrence,
                    messageIds: occurrenceMessageIds(
                        occurrence,
                        participant,
                        "keyword",
                        keyword.label
                    )
                })).filter(source => source.messageIds.length);
                if (!keywordSources.length) {
                    return;
                }
                const relations = codes.map(code => {
                    const linked = new Set();
                    keywordSources.forEach(source => {
                        const codeOccurrence = code.occurrences.find(entry =>
                            entry.item.id === source.occurrence.item.id
                        );
                        if (!codeOccurrence) {
                            return;
                        }
                        const codeIds = new Set(occurrenceMessageIds(
                            codeOccurrence,
                            participant,
                            "code",
                            code.label
                        ));
                        source.messageIds.forEach(messageId => {
                            if (codeIds.has(messageId)) {
                                linked.add(messageId);
                            }
                        });
                    });
                    return [...linked];
                });
                rows.push({ participant, keyword, keywordSources, relations });
            });
        });

        const table = worksheetTable("keywordWorksheet");
        const head = document.createElement("thead");
        const headingRow = document.createElement("tr");
        appendHeader(headingRow, "Participant ID");
        appendHeader(headingRow, "Keyword #");
        appendHeader(headingRow, "Expression");
        codes.forEach(code => appendHeader(
            headingRow,
            code.label,
            code.identifier
        ));
        head.appendChild(headingRow);
        table.appendChild(head);

        const body = document.createElement("tbody");
        rows.forEach(entry => {
            const row = document.createElement("tr");
            appendRowHeading(row, entry.participant.participantId);
            appendCell(row, entry.keyword.identifier, "analysisIdentifierCell");
            const expressionCell = document.createElement("td");
            const relatedCodeIndex = entry.relations.findIndex(
                messageIds => messageIds.length
            );
            const relatedCode = codes[relatedCodeIndex];
            const contextSource = entry.keywordSources.find(source =>
                relatedCode?.occurrences.some(occurrence =>
                    occurrence.item.id === source.occurrence.item.id
                )
            ) || entry.keywordSources[0];
            expressionCell.appendChild(expressionButton(
                entry.keyword.label,
                contextSource?.occurrence.item,
                relatedCode?.label || null
            ));
            row.appendChild(expressionCell);
            entry.relations.forEach(messageIds => relationCell(row, messageIds));
            body.appendChild(row);
        });
        if (!rows.length) {
            appendEmptyRow(
                body,
                3 + codes.length,
                workspace?.run
                    ? "No participant–keyword relationships are available in this analysis run."
                    : "Generate an analysis run to populate keywords from the stored interviews."
            );
        }
        table.appendChild(body);
        container.appendChild(table);
    }

    function renderHierarchyView() {
        const container = document.getElementById("analysisHierarchyView");
        const breadcrumb = document.getElementById("analysisBreadcrumb");
        const description = document.getElementById("analysisViewDescription");
        if (!container || !workspace) {
            return;
        }

        container.replaceChildren();
        document.querySelectorAll("[data-analysis-view]").forEach(button => {
            button.setAttribute(
                "aria-pressed",
                String(button.dataset.analysisView === activeAnalysisView)
            );
        });

        const item = selectedThemeItem();
        if (activeAnalysisView === "themes") {
            breadcrumb.textContent = "Worksheet 1 · Participants & Themes";
            description.textContent =
                "One row per participant. T1–T8 are participant-specific positions: each cell contains that participant’s own theme, and themes in the same column are not assumed to have the same meaning. This is the only worksheet with a direct link to the complete transcript.";
            renderThemeWorksheet(container);
            renderDiscussionPanel(item);
            return;
        }

        if (activeAnalysisView === "codes") {
            breadcrumb.textContent = "Worksheet 2 · Codes & Themes";
            description.textContent =
                "Each participant–code combination appears once. Theme columns show where the same code occurs across themes; no transcript link is repeated here.";
            renderCodeWorksheet(container);
            renderDiscussionPanel(item);
            return;
        }

        breadcrumb.textContent = "Worksheet 3 · Keywords & Codes";
        description.textContent =
            "Each participant–keyword expression appears once. Code columns show which code or codes that expression supports; transcript links remain in Worksheet 1.";
        renderKeywordWorksheet(container);
        renderDiscussionPanel(item);
    }

    function renderAnalysisOverview() {
        const items = (workspace.items || []).filter(item =>
            item.status !== "archived"
        );
        document.getElementById("analysisParticipantCount").textContent =
            String(participantRecords().length);
        document.getElementById("analysisThemeCount").textContent = String(
            participantRecords().reduce((total, participant) =>
                total + participantThemeRecords(participant).length, 0)
        );
        document.getElementById("analysisCodeCount").textContent = String(
            uniqueValues(items.flatMap(item => workingList(
                item,
                "researcher_codes",
                "ai_codes"
            ))).length
        );
        document.getElementById("analysisKeywordCount").textContent = String(
            uniqueValues(items.flatMap(item => workingList(
                item,
                "researcher_keywords",
                "ai_keywords"
            ))).length
        );
    }

    function themeIdentifier(item) {
        return themeRecords().find(theme => theme.item.id === item?.id)
            ?.identifier || "T—";
    }

    function codeIdentifier(item, code) {
        return codeRecords().find(record =>
            normalizedLabel(record.label) === normalizedLabel(code)
        )?.identifier || "C—";
    }

    function keywordColumnsForCode(item, code) {
        if (!item || !code) {
            return [];
        }
        const codeComponent = componentForValue(item, "code", code);
        const codeIds = new Set(codeComponent.messageIds || []);
        (item.evidence || []).filter(evidence =>
            (evidence.codes || []).some(value =>
                normalizedLabel(value) === normalizedLabel(code)
            )
        ).forEach(evidence => codeIds.add(evidence.messageId));
        return keywordRecords().filter(keyword =>
            keyword.occurrences.some(occurrence =>
                occurrence.item.id === item.id
                && (occurrence.component.messageIds || []).some(messageId =>
                    codeIds.has(messageId)
                )
            )
        ).map(keyword => {
            const caseCount = participantRecords().filter(participant =>
                keyword.occurrences.some(occurrence =>
                    occurrence.item.id === item.id
                    && occurrenceMessageIds(
                        occurrence,
                        participant,
                        "keyword",
                        keyword.label
                    ).some(messageId => codeIds.has(messageId))
                )
            ).length;
            return {
                ...keyword,
                detail: `${caseCount} case${caseCount === 1 ? "" : "s"}`
            };
        });
    }

    function discussionKey(item) {
        return `${item?.id || "none"}:${selectedCode || "theme"}`;
    }

    function currentDiscussionMessages(item) {
        const key = discussionKey(item);
        if (!discussionMessages.has(key)) {
            discussionMessages.set(key, []);
        }
        return discussionMessages.get(key);
    }

    function discussionIntro(item) {
        if (!item) {
            return "Select an analytical item to begin a discussion.";
        }
        const themeId = themeIdentifier(item);
        if (!selectedCode) {
            return `We are discussing ${themeId} · ${workingTheme(item)}. Tell me what you notice in its codes or keywords, and I will check the grouping against the stored evidence.`;
        }
        const columns = keywordColumnsForCode(item, selectedCode);
        const keywordText = columns.map(column =>
            `${column.identifier} ${column.label} (${column.detail})`
        ).join(", ");
        return `We are discussing ${codeIdentifier(item, selectedCode)} · ${selectedCode} under ${themeId} · ${workingTheme(item)}. Its current keywords are ${keywordText || "not yet identified"}. What would you like to question or revise?`;
    }

    function appendDiscussionMessage(container, message) {
        const article = document.createElement("article");
        article.className = "analysisChatMessage";
        article.dataset.speaker = message.role;
        const label = document.createElement("strong");
        label.textContent = message.role === "assistant"
            ? "AI analytical collaborator"
            : "Researcher";
        const content = document.createElement("p");
        content.textContent = message.content;
        article.append(label, content);
        container.appendChild(article);
    }

    function renderDiscussionProposal(item) {
        const panel = document.getElementById("analysisProposal");
        const content = document.getElementById("analysisProposalContent");
        const proposal = pendingDiscussionProposal;
        const appliesToCurrent = proposal
            && proposal.itemId === item?.id
            && proposal.code === selectedCode;
        panel.hidden = !appliesToCurrent;
        content.replaceChildren();
        if (!appliesToCurrent) {
            return;
        }
        appendTextBlock(content, "Theme", proposal.theme);
        appendTextBlock(content, "Codes", proposal.codes.join(", "));
        proposal.codeKeywordGroups.forEach(group => {
            appendTextBlock(
                content,
                `Keywords under ${group.code}`,
                group.keywords.join(", ") || "None proposed"
            );
        });
        appendTextBlock(content, "Reasoning", proposal.rationale);
    }

    function renderDiscussionPanel(item = selectedThemeItem()) {
        const container = document.getElementById("analysisConversation");
        const context = document.getElementById("analysisDiscussionContext");
        if (!container || !context) {
            return;
        }
        context.textContent = item
            ? `Current focus: ${themeIdentifier(item)} · ${workingTheme(item)}${selectedCode ? ` → ${codeIdentifier(item, selectedCode)} · ${selectedCode}` : ""}`
            : "No analytical item is selected.";
        const messages = currentDiscussionMessages(item);
        if (!messages.length) {
            messages.push({ role: "assistant", content: discussionIntro(item) });
        }
        container.replaceChildren();
        messages.forEach(message => appendDiscussionMessage(
            container,
            message
        ));
        container.scrollTop = container.scrollHeight;
        renderDiscussionProposal(item);
        document.getElementById("analysisDiscussionInput").disabled = !item;
        document.getElementById("analysisDiscussionSendButton").disabled = !item;
        document.getElementById("analysisAcceptCurrentButton").disabled = !item;
        document.getElementById("analysisRejectCurrentButton").disabled = !item;
    }

    async function sendDiscussionMessage(message) {
        const item = selectedThemeItem();
        if (!item || !message.trim()) {
            return;
        }
        const messages = currentDiscussionMessages(item);
        const priorConversation = messages.map(entry => ({ ...entry }));
        messages.push({ role: "researcher", content: message.trim() });
        renderDiscussionPanel(item);
        const sendButton = document.getElementById(
            "analysisDiscussionSendButton"
        );
        sendButton.disabled = true;
        setStatus("AI is reviewing the selected keywords and evidence…");

        try {
            const result = await authorizedRequest("/api/analysis", {
                method: "POST",
                body: JSON.stringify({
                    action: "discuss",
                    itemId: item.id,
                    focusCode: selectedCode,
                    message: message.trim(),
                    conversation: priorConversation
                })
            });
            messages.push({ role: "assistant", content: result.reply });
            pendingDiscussionProposal = result.proposal?.shouldApply
                ? {
                    ...result.proposal,
                    itemId: item.id,
                    code: selectedCode
                }
                : null;
            setStatus(result.proposal?.shouldApply
                ? "AI response ready. Review the proposed revision before applying it."
                : "AI response ready. No analytical revision was proposed."
            );
        } catch (error) {
            messages.push({
                role: "assistant",
                content: `I could not review that message: ${error.message}`
            });
            setStatus(error.message, true);
        } finally {
            sendButton.disabled = false;
            renderDiscussionPanel(item);
        }
    }

    async function applyDiscussionProposal() {
        const item = selectedThemeItem();
        const proposal = pendingDiscussionProposal;
        if (!item || !proposal || proposal.itemId !== item.id) {
            return;
        }
        const saved = await postAction({
            action: "save_feedback",
            itemId: item.id,
            theme: proposal.theme,
            codes: proposal.codes.join(", "),
            codedPhrases: workingList(
                item,
                "researcher_coded_phrases",
                "ai_coded_phrases"
            ).join(", "),
            keywords: proposal.keywords.join(", "),
            note: item.researcher_note || proposal.rationale
        }, "Applying the proposed analytical revision…");
        if (saved) {
            await postAction({
                action: "collect_evidence",
                itemId: item.id
            }, "Refreshing evidence for the revised codes…");
            currentDiscussionMessages(item).push({
                role: "assistant",
                content: "The proposed revision has been applied and its evidence refreshed. It remains provisional until you accept the current theme and codes."
            });
            pendingDiscussionProposal = null;
            renderDiscussionPanel(selectedThemeItem());
        }
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
            option.textContent = `${new Date(run.created_at).toLocaleString()} — ${run.model} — ${run.status}`;
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
        generateButton.disabled = !(workspace.corpusMessages || []).length;

        const metadata = document.getElementById("analysisRunMetadata");

        if (!workspace.run) {
            metadata.textContent =
                `${completionFilter.selectedOptions[0].textContent} · ${participantRecords().length} stored participants · No analysis run yet`;
            setStatus(
                "Real interview data loaded. Generate suggestions when you are ready to populate codes and keywords."
            );
        } else {
            if (!selectedThemeItemId || !workspace.items.some(item =>
                item.id === selectedThemeItemId
            )) {
                selectedThemeItemId = workspace.items[0]?.id || null;
                selectedCode = null;
            }

            metadata.textContent = [
                completionFilter.selectedOptions[0].textContent,
                `Model ${workspace.run.model}`,
                `${workspace.run.messages_analyzed} participant messages analysed`,
                `${workspace.run.sessions_analyzed} sessions`,
                `${workspace.run.batches_used} batches`,
                `${workspace.run.skipped_records} skipped records`,
                `${workspace.run.invalid_evidence_ids} rejected evidence IDs`
            ].join(" · ");
        }
        workspace.items.forEach(item => body.appendChild(renderItem(item)));
        renderAnalysisOverview();
        renderHierarchyView();

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
            setStatus(workspace.run
                ? "Stored analysis loaded. No AI generation was performed."
                : "Real interview data loaded. Generate suggestions when you are ready to populate codes and keywords."
            );
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

    document.querySelectorAll("[data-analysis-view]").forEach(button => {
        button.addEventListener("click", () => {
            switchAnalysisView(button.dataset.analysisView);
        });
    });

    document.querySelectorAll("[data-discussion-prompt]").forEach(button => {
        button.addEventListener("click", () => {
            const input = document.getElementById("analysisDiscussionInput");
            input.value = button.dataset.discussionPrompt;
            input.focus();
        });
    });

    document.getElementById("analysisDiscussionForm").addEventListener(
        "submit",
        event => {
            event.preventDefault();
            const input = document.getElementById("analysisDiscussionInput");
            const message = input.value;
            if (!message.trim()) {
                return;
            }
            input.value = "";
            sendDiscussionMessage(message);
        }
    );

    document.getElementById("analysisApplyProposalButton").addEventListener(
        "click",
        applyDiscussionProposal
    );

    document.getElementById("analysisDismissProposalButton").addEventListener(
        "click",
        () => {
            pendingDiscussionProposal = null;
            renderDiscussionPanel();
            document.getElementById("analysisDiscussionInput").focus();
        }
    );

    document.getElementById("analysisAcceptCurrentButton").addEventListener(
        "click",
        () => {
            const item = selectedThemeItem();
            if (!item) {
                return;
            }
            postAction({
                action: "confirm",
                itemId: item.id
            }, "Saving the confirmed analytical snapshot…");
        }
    );

    document.getElementById("analysisRejectCurrentButton").addEventListener(
        "click",
        () => {
            const item = selectedThemeItem();
            if (!item) {
                return;
            }
            postAction({
                action: "archive",
                itemId: item.id
            }, "Rejecting and archiving the current theme…");
        }
    );

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
                model: analysisModel.value.trim(),
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
