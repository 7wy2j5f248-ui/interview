(function initializeAutomaticAnalysisReview() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const MAX_SELECTIONS = 8;
    const bridge = window.automaticAnalysisReviewBridge;
    if (!bridge) return;

    let workspace = {
        workbookImports: [],
        threads: [],
        messages: [],
        reanalysis: {
            requests: [], proposals: [], reviews: [], events: [],
            projects: [], frameworks: [], activeFrameworks: [], batches: [],
            projectWideCaseStatuses: [], projectWideSourceCases: [],
            sourceReports: [], sourceCodes: [], sourceCategories: [],
            sourceThemes: [], sourceMeaningUnits: [],
            sourceCodeMeaningUnits: [], sourceCategoryCodes: [],
            sourceThemeCategories: [], sourceHighlights: [], sourceThemeCodes: []
        }
    };
    let activeThreadId = null;
    let activeWorkbookId = null;
    let loadingPromise = null;
    let discussionInFlight = false;
    const selection = new Map();

    const selectionList = document.getElementById("automaticReviewSelectionList");
    const conversation = document.getElementById("automaticReviewConversation");
    const workbookStatus = document.getElementById("automaticReviewWorkbookStatus");
    const threadSelect = document.getElementById("automaticReviewThreadSelect");
    const input = document.getElementById("automaticReviewDiscussionInput");
    const sendButton = document.getElementById(
        "automaticReviewDiscussionSendButton"
    );
    const selectionSummary = document.getElementById(
        "automaticReviewSelectionSummary"
    );
    const discussionStatus = document.getElementById(
        "automaticReviewDiscussionStatus"
    );
    const reanalysisButton = document.getElementById(
        "automaticReanalysisRequestButton"
    );
    const reanalysisStatus = document.getElementById(
        "automaticReanalysisStatus"
    );
    const reanalysisHistory = document.getElementById(
        "automaticReanalysisHistory"
    );
    const projectWideProject = document.getElementById(
        "projectWideReanalysisProject"
    );
    const projectWideFramework = document.getElementById(
        "projectWideReanalysisFramework"
    );
    const projectWidePreviewButton = document.getElementById(
        "projectWideReanalysisPreviewButton"
    );
    const projectWideRequestButton = document.getElementById(
        "projectWideReanalysisRequestButton"
    );
    const projectWidePreviewText = document.getElementById(
        "projectWideReanalysisPreview"
    );
    const projectWideStatus = document.getElementById(
        "projectWideReanalysisStatus"
    );
    const projectWideHistory = document.getElementById(
        "projectWideReanalysisHistory"
    );
    let projectWidePreview = null;

    function token() {
        return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }

    function sourceKey(source) {
        return `${source.sessionId}:${source.kind}:${source.position || "CASE"}`;
    }

    function sourceLabel(source) {
        const position = source.position || "CASE";
        return `${source.caseNumber} ${position}${
            source.label ? ` · ${source.label}` : ""
        }`;
    }

    function sourceContextText(sources) {
        return (sources || []).map(sourceLabel).join("; ");
    }

    function immutableSelectionSnapshot() {
        return [...selection.values()].map(source => Object.freeze({
            kind: source.kind,
            sessionId: source.sessionId,
            caseNumber: source.caseNumber,
            participantCode: source.participantCode,
            position: source.position,
            recordId: source.recordId || null,
            label: source.label || null
        }));
    }

    function currentCase(source) {
        return bridge.cases().find(caseRecord =>
            caseRecord.transcriptIdentity?.sessionId === source?.sessionId
        ) || null;
    }

    function selectedSessionId() {
        const sessionIds = [...new Set(
            [...selection.values()].map(source => source.sessionId)
        )];
        return sessionIds.length === 1 ? sessionIds[0] : null;
    }

    function renderSelection() {
        selectionList.replaceChildren();
        const sources = [...selection.values()];
        if (!sources.length) {
            const empty = document.createElement("span");
            empty.className = "muted";
            empty.textContent = "Select a case, THn theme, CAn category, or COn code above.";
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
                remove.disabled = discussionInFlight;
                remove.addEventListener("click", () => {
                    if (discussionInFlight) return;
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
            !sources.length || discussionInFlight;
        sendButton.disabled = !sources.length || discussionInFlight;
        selectionSummary.textContent = sources.length
            ? `Exact analytical scope ready to send (${sources.length}): ${
                sourceContextText(sources)
            }`
            : "No analytical scope selected.";
        if (!discussionInFlight) {
            discussionStatus.textContent = sources.length
                ? `Ready to discuss exact analytical scope: ${
                    sourceContextText(sources)
                }`
                : "Select source records before discussing them with AI.";
        }
        const reanalysisSessionId = selectedSessionId();
        reanalysisButton.disabled = !reanalysisSessionId;
        document.getElementById("automaticReanalysisSelectedCase").textContent =
            reanalysisSessionId
                ? `Selected case: ${sources[0].caseNumber}. Only this case will be re-analysed.`
                : "Select one case, theme, category, or code from a single case.";
        renderReanalysisHistory();
    }

    function appendHierarchy(container, report, source = false) {
        const themes = source
            ? workspace.reanalysis.sourceThemes.filter(
                item => item.report_id === report.id
            ).map(item => ({
                label: item.theme_label,
                rationale: item.rationale,
                categoryNumbers: workspace.reanalysis.sourceThemeCategories
                    .filter(link => link.theme_id === item.id)
                    .map(link => workspace.reanalysis.sourceCategories.find(
                        category => category.id === link.category_id
                            && category.report_id === report.id
                    )?.category_number)
                    .filter(number => number > 0),
                codeNumbers: workspace.reanalysis.sourceThemeCodes
                    .filter(link => link.theme_id === item.id)
                    .map(link => workspace.reanalysis.sourceCodes.find(
                        code => code.id === link.code_id
                            && code.report_id === report.id
                    )?.code_number)
                    .filter(number => number > 0)
            }))
            : report?.themes || [];
        const codes = source
            ? workspace.reanalysis.sourceCodes.filter(
                item => item.report_id === report.id
            ).map(item => ({
                label: item.code_label,
                rationale: item.rationale,
                meaningUnits: workspace.reanalysis.sourceCodeMeaningUnits
                    .filter(link => link.code_id === item.id)
                    .map(link => workspace.reanalysis.sourceMeaningUnits.find(
                        unit => unit.id === link.meaning_unit_id
                    )).filter(Boolean)
                    .map(unit => ({ exactText: unit.exact_text })),
                highlights: workspace.reanalysis.sourceHighlights.filter(
                    highlight => highlight.code_id === item.id
                ).map(highlight => ({ exactText: highlight.exact_text }))
            }))
            : report?.codes || [];
        const categories = source
            ? workspace.reanalysis.sourceCategories.filter(
                item => item.report_id === report.id
            ).map(item => ({
                label: item.category_label,
                rationale: item.rationale,
                codeNumbers: workspace.reanalysis.sourceCategoryCodes
                    .filter(link => link.category_id === item.id)
                    .map(link => workspace.reanalysis.sourceCodes.find(
                        code => code.id === link.code_id
                            && code.report_id === report.id
                    )?.code_number)
                    .filter(number => number > 0)
            }))
            : report?.categories || [];
        const themeHeading = document.createElement("strong");
        themeHeading.textContent = "Themes";
        const themeList = document.createElement("ul");
        themes.forEach((theme, index) => {
            const item = document.createElement("li");
            const supportingCategories = (theme.categoryNumbers || [])
                .map(number => `CA${number}`)
                .join(", ");
            const legacyCodes = (theme.codeNumbers || [])
                .map(number => `CO${number}`)
                .join(", ");
            item.textContent = `TH${index + 1} ${theme.label} ← ${
                supportingCategories || legacyCodes || "no defensible higher-level group"
            } — ${theme.rationale}`;
            themeList.appendChild(item);
        });
        const categoryHeading = document.createElement("strong");
        categoryHeading.textContent = "Categories";
        const categoryList = document.createElement("ul");
        categories.forEach((category, index) => {
            const item = document.createElement("li");
            const supportingCodes = (category.codeNumbers || [])
                .map(number => `CO${number}`)
                .join(", ");
            item.textContent = `CA${index + 1} ${category.label} ← ${supportingCodes} — ${category.rationale}`;
            categoryList.appendChild(item);
        });
        const codeHeading = document.createElement("strong");
        codeHeading.textContent = "Codes and meaning units";
        const codeList = document.createElement("ul");
        codes.forEach((code, index) => {
            const item = document.createElement("li");
            const evidenceItems = (code.meaningUnits || []).length
                ? code.meaningUnits
                : code.highlights || [];
            const evidence = evidenceItems.map(
                highlight => `“${highlight.exactText}”`
            ).join("; ");
            item.textContent = `CO${index + 1} ${code.label} — ${evidence}`;
            codeList.appendChild(item);
        });
        container.append(
            themeHeading,
            themeList,
            categoryHeading,
            categoryList,
            codeHeading,
            codeList
        );
        const assignedCodeNumbers = new Set(categories.flatMap(
            category => category.codeNumbers || []
        ));
        const ungrouped = codes.map((code, index) => ({
            number: index + 1,
            label: code.label
        })).filter(code => !assignedCodeNumbers.has(code.number));
        if (ungrouped.length) {
            const ungroupedHeading = document.createElement("strong");
            ungroupedHeading.textContent =
                "Codes retained without a defensible category";
            const ungroupedList = document.createElement("ul");
            ungrouped.forEach(code => {
                const item = document.createElement("li");
                item.textContent = `CO${code.number} ${code.label} · The completed analysis did not force an unsupported category.`;
                ungroupedList.appendChild(item);
            });
            container.append(ungroupedHeading, ungroupedList);
        }
    }

    function reasonLabel(value) {
        return ({
            keywords_unrelated_to_theme: "Meaning units unrelated to the analytical hierarchy",
            evidence_theme_mismatch: "Evidence-to-theme mismatch",
            analysis_framework_changed: "Project-wide Analysis Framework self-check",
            other: "Other analytical concern"
        })[value] || value;
    }

    function renderReanalysisHistory() {
        if (!reanalysisHistory) return;
        reanalysisHistory.replaceChildren();
        const sessionId = selectedSessionId();
        if (!sessionId) return;
        const layer = workspace.reanalysis || {};
        const requests = (layer.requests || []).filter(
            item => item.session_id === sessionId
        );
        if (!requests.length) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = "No re-analysis request has been made for this case.";
            reanalysisHistory.appendChild(empty);
            return;
        }
        requests.forEach(request => {
            const record = document.createElement("article");
            record.className = "automaticReanalysisRecord";
            const heading = document.createElement("h5");
            const requestCase = currentCase({ sessionId: request.session_id });
            heading.textContent = `Re-analysis request ${request.request_number} · ${
                requestCase?.caseNumber || request.session_id
            } · ${String(
                request.status
            ).replaceAll("_", " ")}`;
            const requestInfo = document.createElement("p");
            requestInfo.textContent = `${reasonLabel(request.reason_code)} — ${
                request.researcher_notes
            } · Requested ${new Date(request.requested_at).toLocaleString()}`;
            record.append(heading, requestInfo);
            const project = (layer.projects || []).find(
                item => item.id === request.project_id
            );
            const framework = (layer.frameworks || []).find(
                item => item.id === request.analysis_framework_id
            );
            const lineage = document.createElement("p");
            lineage.className = "muted";
            lineage.textContent = project && framework
                ? `Global project rule: ${project.project_name} · Topic: ${project.research_topic} · Analysis Framework v${framework.version_number}. This case has its own completed version and audit; researcher feedback begins another version.`
                : "Legacy lineage: refresh after the project-bound framework migration is available.";
            record.appendChild(lineage);
            if (request.last_error) {
                const error = document.createElement("p");
                error.className = "automaticReanalysisWarning";
                error.textContent = `Stopped without changing the current report: ${request.last_error}`;
                record.appendChild(error);
            }
            const proposal = (layer.proposals || []).find(
                item => item.request_id === request.id
            );
            const sourceReport = (layer.sourceReports || []).find(
                item => item.id === request.source_report_id
            );
            if (proposal && sourceReport) {
                const comparison = document.createElement("div");
                comparison.className = "automaticReanalysisComparison";
                const source = document.createElement("section");
                source.className = "automaticReanalysisVersion";
                const sourceHeading = document.createElement("h5");
                sourceHeading.textContent = `Preserved source · ${sourceReport.analysis_version}`;
                source.appendChild(sourceHeading);
                appendHierarchy(source, sourceReport, true);
                const proposed = document.createElement("section");
                proposed.className = "automaticReanalysisVersion";
                const proposedHeading = document.createElement("h5");
                proposedHeading.textContent = `Completed AI version · ${proposal.proposal_version}`;
                proposed.appendChild(proposedHeading);
                appendHierarchy(proposed, proposal.proposed_report, false);
                comparison.append(source, proposed);
                record.appendChild(comparison);

                const audit = document.createElement("p");
                const checks = proposal.relevance_audit?.checks || [];
                audit.textContent = `Project-framework relevance audit: ${checks.filter(
                    item => item.accepted
                ).length}/${checks.length} exact evidence items passed transcript grounding, code support, theme support, and the named project's research-scope checks. ${
                    proposal.relevance_audit?.overallSummary || ""
                }`;
                record.appendChild(audit);
                const labelAudit = proposal.relevance_audit?.labelQualityAudit;
                if (labelAudit) {
                    const labelAuditSummary = document.createElement("div");
                    labelAuditSummary.className = labelAudit.complete
                        ? "automaticReanalysisAudit"
                        : "automaticReanalysisWarning";
                    const acceptedLabels = (labelAudit.checks || []).filter(
                        item => item.accepted
                    ).length;
                    const heading = document.createElement("strong");
                    heading.textContent = "Platform-wide semantic label audit";
                    const summary = document.createElement("p");
                    summary.textContent = `${acceptedLabels}/${
                        (labelAudit.checks || []).length
                    } CO/CA/TH labels passed natural-language coherence, evidence support, project-topic fit, conceptual distinctness, and cross-case comparison usefulness. Categories require related codes; themes require patterned meaning across related categories. ${
                        labelAudit.overallSummary || ""
                    }`;
                    labelAuditSummary.append(heading, summary);
                    const rejected = labelAudit.rejectedLabels || [];
                    if (rejected.length) {
                        const list = document.createElement("ul");
                        rejected.forEach(flag => {
                            const item = document.createElement("li");
                            item.textContent = `${flag.kind} ${flag.number} “${flag.label}”: ${flag.explanation}`;
                            list.appendChild(item);
                        });
                        labelAuditSummary.appendChild(list);
                    }
                    record.appendChild(labelAuditSummary);
                    const hierarchy = labelAudit.themeHierarchy;
                    if (hierarchy) {
                        const hierarchySummary = document.createElement("div");
                        hierarchySummary.className = hierarchy.complete
                            ? "automaticReanalysisAudit"
                            : "automaticReanalysisWarning";
                        const title = document.createElement("strong");
                        title.textContent = "MU → CO → CA → TH hierarchy provenance";
                        const detail = document.createElement("p");
                        detail.textContent = `${(hierarchy.checks || []).filter(
                            item => item.accepted
                        ).length}/${(hierarchy.checks || []).length} themes passed patterned-meaning and category-support checks. ${(hierarchy.unsynthesized || []).length} firm lower-level findings remain visibly unsynthesized; no category or theme was forced.`;
                        hierarchySummary.append(title, detail);
                        const ungrouped = hierarchy.ungroupedCodes || [];
                        if (ungrouped.length) {
                            const list = document.createElement("ul");
                            ungrouped.forEach(flag => {
                                const item = document.createElement("li");
                                item.textContent = `CO${flag.number || flag.codeNumber} “${flag.label}”: ${flag.reason}`;
                                list.appendChild(item);
                            });
                            hierarchySummary.appendChild(list);
                        }
                        record.appendChild(hierarchySummary);
                    }
                }
                const flags = proposal.source_quality_flags || [];
                if (flags.length) {
                    const warning = document.createElement("div");
                    warning.className = "automaticReanalysisWarning";
                    const title = document.createElement("strong");
                    title.textContent = "Historical interview-protocol issue";
                    const list = document.createElement("ul");
                    flags.forEach(flag => {
                        const item = document.createElement("li");
                        item.textContent = `${flag.explanation} Source turn: “${flag.exactText}”`;
                        list.appendChild(item);
                    });
                    warning.append(title, list);
                    record.appendChild(warning);
                }
                const review = (layer.reviews || []).find(
                    item => item.request_id === request.id
                );
                if (review) {
                    const decision = document.createElement("p");
                    decision.textContent = `Researcher decision: ${review.decision} · ${
                        new Date(review.reviewed_at).toLocaleString()
                    }${review.reviewer_notes ? ` — ${review.reviewer_notes}` : ""}`;
                    record.appendChild(decision);
                }
            }
            reanalysisHistory.appendChild(record);
        });
    }

    async function requestReanalysis() {
        const sessionId = selectedSessionId();
        if (!sessionId) return;
        const notes = document.getElementById("automaticReanalysisNotes")
            .value.trim();
        if (!notes) {
            throw new Error("Explain what should be checked in this case.");
        }
        reanalysisButton.disabled = true;
        reanalysisStatus.textContent =
            "Generating a completed version from the preserved transcript and checking every MU → CO → CA → TH link…";
        try {
            const response = await fetch("/api/automatic-analysis-review", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    action: "request_case_reanalysis",
                    sessionId,
                    reasonCode: document.getElementById(
                        "automaticReanalysisReason"
                    ).value,
                    researcherNotes: notes
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "The case could not be re-analysed.");
            }
            document.getElementById("automaticReanalysisNotes").value = "";
            await loadWorkspace(activeThreadId);
            if (bridge.refresh) await bridge.refresh();
            reanalysisStatus.textContent =
                "Completed. The new version is current and the earlier version remains available for audit.";
        } finally {
            reanalysisButton.disabled = !selectedSessionId();
        }
    }

    function invalidateProjectWidePreview() {
        projectWidePreview = null;
        projectWideRequestButton.disabled = true;
        projectWidePreviewText.textContent =
            "Preview the project, topic, framework version, and eligible case count before requesting.";
    }

    function populateProjectWideFrameworks() {
        const projectId = projectWideProject.value;
        const priorValue = projectWideFramework.value;
        const frameworks = (workspace.reanalysis.frameworks || []).filter(
            item => item.project_id === projectId
        );
        const activeId = (workspace.reanalysis.activeFrameworks || []).find(
            item => item.project_id === projectId
        )?.framework_id;
        projectWideFramework.replaceChildren();
        frameworks.forEach(framework => {
            const option = document.createElement("option");
            option.value = framework.id;
            option.textContent = `Analysis Framework v${framework.version_number}${
                framework.id === activeId ? " · active" : " · historical"
            }`;
            option.selected = framework.id === priorValue
                || (!priorValue && framework.id === activeId);
            projectWideFramework.appendChild(option);
        });
        projectWideFramework.disabled = !frameworks.length;
    }

    async function cancelProjectWideRun(batchId, cancellationReason) {
        const reason = cancellationReason.trim();
        if (!reason) {
            throw new Error("Explain why this project-wide run should stop.");
        }
        if (!window.confirm(
            "Stop this project-wide re-analysis? Queued and in-flight cases will be cancelled. Versions already completed remain current and fully auditable."
        )) return;
        projectWideStatus.textContent =
            "Stopping unfinished work and preserving completed versions and cancellation lineage…";
        const response = await fetch("/api/automatic-analysis-review", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "cancel_project_wide_reanalysis",
                batchId,
                cancellationReason: reason
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "The project-wide run could not be stopped.");
        }
        await loadWorkspace(activeThreadId);
        projectWideStatus.textContent = `${data.cancelledCaseCount} unfinished case requests were stopped. Already completed versions remain current; the cancellation reason remains available for audit.`;
    }

    function downloadFilename(response, fallback) {
        const disposition = response.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="([^"]+)"/i);
        return match?.[1] || fallback;
    }

    async function downloadProjectWideBatch(batch) {
        projectWideStatus.textContent =
            "Preparing the completed revised analysis with prior-versus-current evidence and provenance…";
        const response = await fetch(
            `/api/automatic-analysis-review?action=download_project_reanalysis_batch&batchId=${encodeURIComponent(batch.id)}`,
            { headers: { Authorization: `Bearer ${token()}` } }
        );
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "The complete batch review could not be downloaded.");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = downloadFilename(
            response,
            `PLI-complete-revised-analysis-${batch.id}.xlsx`
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        projectWideStatus.textContent =
            "Completed batch analysis downloaded with version lineage and evidence provenance.";
    }

    function renderProjectWideHistory() {
        projectWideHistory.replaceChildren();
        const layer = workspace.reanalysis || {};
        const batches = layer.batches || [];
        if (!batches.length) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = "No project-wide re-analysis has been requested.";
            projectWideHistory.appendChild(empty);
            return;
        }
        batches.forEach((batch, batchIndex) => {
            const record = document.createElement("article");
            record.className = "automaticReanalysisRecord";
            const project = (layer.projects || []).find(
                item => item.id === batch.project_id
            );
            const framework = (layer.frameworks || []).find(
                item => item.id === batch.analysis_framework_id
            );
            const heading = document.createElement("h5");
            heading.textContent = `${project?.project_name || "Research project"} · Analysis Framework v${
                framework?.version_number || "?"
            } · ${String(batch.status).replaceAll("_", " ")}`;
            const lineage = document.createElement("p");
            lineage.textContent = `Topic: ${
                project?.research_topic || batch.scope_snapshot?.researchTopic || "—"
            } · Requested ${new Date(batch.requested_at).toLocaleString()} · ${
                batch.researcher_notes
            }`;
            const counts = document.createElement("p");
            counts.className = "muted";
            counts.textContent = `Eligible ${batch.eligible_case_count}; queued ${
                batch.queued_case_count
            }; processing ${batch.processing_case_count}; completed versions ${
                batch.proposal_ready_case_count
            }; failed ${batch.failed_case_count}; cancelled ${
                batch.cancelled_case_count || 0
            }. PLI completes each version without an approval gate. Earlier versions remain preserved; the consolidated download is read-only.`;
            record.append(heading, lineage, counts);

            if (new Set(["completed", "completed_with_failures"]).has(
                batch.status
            ) && batch.queued_case_count === 0
                && batch.processing_case_count === 0) {
                const download = document.createElement("button");
                download.type = "button";
                download.textContent = "Download complete batch review";
                download.addEventListener("click", () => {
                    download.disabled = true;
                    downloadProjectWideBatch(batch)
                        .catch(error => {
                            projectWideStatus.textContent = error.message;
                            bridge.setStatus(error.message, true);
                        })
                        .finally(() => {
                            download.disabled = false;
                        });
                });
                record.appendChild(download);
            }

            if (batch.cancellation_reason) {
                const cancellation = document.createElement("p");
                cancellation.className = "automaticReanalysisWarning";
                cancellation.textContent = `Stopped by ${
                    batch.cancelled_by || "researcher"
                } · ${batch.cancellation_reason}`;
                record.appendChild(cancellation);
            }

            if (new Set([
                "queued", "processing", "awaiting_review",
                "completed_with_failures", "cancellation_requested"
            ]).has(batch.status)) {
                const stopReason = document.createElement("textarea");
                stopReason.placeholder =
                    "Why should this older project-wide instruction stop?";
                stopReason.setAttribute(
                    "aria-label",
                    "Project-wide re-analysis cancellation reason"
                );
                const stopButton = document.createElement("button");
                stopButton.type = "button";
                stopButton.textContent = "Stop this project-wide run";
                stopButton.addEventListener("click", () => {
                    stopButton.disabled = true;
                    cancelProjectWideRun(batch.id, stopReason.value)
                        .catch(error => {
                            projectWideStatus.textContent = error.message;
                            bridge.setStatus(error.message, true);
                        })
                        .finally(() => {
                            stopButton.disabled = false;
                        });
                });
                record.append(stopReason, stopButton);
            }

            if (batchIndex === 0) {
                const statuses = (layer.projectWideCaseStatuses || []).filter(
                    item => item.project_reanalysis_batch_id === batch.id
                );
                if (statuses.length) {
                    const details = document.createElement("details");
                    const summary = document.createElement("summary");
                    summary.textContent = `Show all ${statuses.length} individual case statuses`;
                    const list = document.createElement("ul");
                    statuses.forEach(status => {
                        const source = (layer.projectWideSourceCases || []).find(
                            item => item.id === status.source_report_id
                        );
                        const item = document.createElement("li");
                        item.textContent = `${source?.case_number || status.session_id} · ${
                            source?.participant_code || ""
                        } · ${String(status.status).replaceAll("_", " ")}${
                            status.last_error ? ` — ${status.last_error}` : ""
                        }`;
                        list.appendChild(item);
                    });
                    details.append(summary, list);
                    record.appendChild(details);
                }
            }
            projectWideHistory.appendChild(record);
        });
    }

    function renderProjectWideControls() {
        const priorProject = projectWideProject.value;
        projectWideProject.replaceChildren();
        (workspace.reanalysis.projects || []).forEach(project => {
            const option = document.createElement("option");
            option.value = project.id;
            option.textContent = `${project.project_name} · ${project.research_topic}`;
            option.selected = project.id === priorProject;
            projectWideProject.appendChild(option);
        });
        projectWideProject.disabled = !projectWideProject.options.length;
        populateProjectWideFrameworks();
        projectWidePreviewButton.disabled = projectWideProject.disabled
            || projectWideFramework.disabled;
        renderProjectWideHistory();
    }

    async function previewProjectWideScope() {
        projectWidePreviewButton.disabled = true;
        projectWideRequestButton.disabled = true;
        projectWideStatus.textContent = "Counting eligible completed cases in the selected project/topic…";
        try {
            const response = await fetch("/api/automatic-analysis-review", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    action: "preview_project_wide_reanalysis",
                    projectId: projectWideProject.value,
                    analysisFrameworkId: projectWideFramework.value
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "The project-wide scope could not be previewed.");
            }
            projectWidePreview = Object.freeze(data.preview);
            projectWidePreviewText.textContent = `${data.preview.projectName} · Topic: ${
                data.preview.researchTopic
            } · Analysis Framework v${data.preview.analysisFrameworkVersion} · ${
                data.preview.eligibleCaseCount
            } eligible completed cases. Excluded: ${
                data.preview.archivedCaseExcludedCount
            } archived and ${data.preview.openRequestExcludedCount} with an open run. The system completes one new version per case and preserves the earlier versions for audit.`;
            projectWideRequestButton.disabled = data.preview.eligibleCaseCount < 1;
            projectWideStatus.textContent = data.preview.eligibleCaseCount
                ? "Scope preview ready. Add a reason note, then confirm the project-wide request."
                : "No eligible completed cases are available for this scope.";
        } finally {
            projectWidePreviewButton.disabled = false;
        }
    }

    async function requestProjectWideReanalysis() {
        const notes = document.getElementById("projectWideReanalysisNotes")
            .value.trim();
        if (!notes) {
            throw new Error("Explain the project-wide analytical problem to check.");
        }
        if (!projectWidePreview
            || projectWidePreview.projectId !== projectWideProject.value
            || projectWidePreview.analysisFrameworkId
                !== projectWideFramework.value) {
            throw new Error("Preview this exact project and framework scope before confirming.");
        }
        const confirmation = `Request project-wide re-analysis for ${
            projectWidePreview.projectName
        } (${projectWidePreview.researchTopic}) using Analysis Framework v${
            projectWidePreview.analysisFrameworkVersion
        } across ${projectWidePreview.eligibleCaseCount} eligible completed cases? The system will complete and publish one new version per case without case-by-case approval, preserve earlier versions, and make one consolidated review download available.`;
        if (!window.confirm(confirmation)) return;

        projectWideRequestButton.disabled = true;
        projectWideStatus.textContent =
            "Creating the batch and one preserved, versioned request for every eligible case…";
        const response = await fetch("/api/automatic-analysis-review", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token()}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "request_project_wide_reanalysis",
                projectId: projectWidePreview.projectId,
                analysisFrameworkId: projectWidePreview.analysisFrameworkId,
                reasonCode: document.getElementById(
                    "projectWideReanalysisReason"
                ).value,
                researcherNotes: notes
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "The project-wide run could not be created.");
        }
        projectWidePreview = null;
        document.getElementById("projectWideReanalysisNotes").value = "";
        await loadWorkspace(activeThreadId);
        projectWideRequestButton.disabled = true;
        projectWideStatus.textContent = `${data.queuedCaseCount} individual cases were queued. Each new version will become current automatically when complete; earlier versions remain available for audit.`;
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
            line.textContent = `Exact analytical scope: ${sourceContextText(sources)}`;
            line.dataset.sourceContext = sourceContextText(sources);
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
            content.textContent = "Select a case or a THn/CAn/COn cell above. We can then inspect its meaning-unit evidence and analytical fit.";
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
        renderProjectWideControls();
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
        const submittedSelection = immutableSelectionSnapshot();
        const submittedContext = sourceContextText(submittedSelection);
        let outcomeStatus = null;
        discussionInFlight = true;
        renderSelection();
        discussionStatus.textContent =
            `Processing exact analytical scope: ${submittedContext}`;
        bridge.setStatus(
            `AI is checking: ${submittedContext}. The exact selection is locked until this response finishes.`
        );
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
                    selection: submittedSelection,
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
            outcomeStatus =
                `AI response ready for exact analytical scope: ${submittedContext}`;
            bridge.setStatus(
                `AI review ready for: ${submittedContext}. The discussion and its exact case/THn/CAn/COn provenance were saved.`
            );
        } catch (error) {
            outcomeStatus =
                `Discussion failed for exact analytical scope: ${submittedContext}`;
            throw error;
        } finally {
            discussionInFlight = false;
            renderSelection();
            if (outcomeStatus) discussionStatus.textContent = outcomeStatus;
        }
    }

    function startNewThread() {
        activeThreadId = null;
        workspace = { ...workspace, activeThreadId: null, messages: [] };
        renderWorkspace();
    }

    window.addEventListener("automatic-analysis-review-source", event => {
        if (discussionInFlight) {
            bridge.setStatus(
                "The current AI request has a locked analytical scope. Wait for its response before changing the selection."
            );
            return;
        }
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
        bridge.setStatus(
            "Analytical source selected for discussion. Your current form and scroll position were preserved."
        );
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
            if (discussionInFlight) return;
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
    reanalysisButton.addEventListener("click", () => {
        requestReanalysis().catch(error => {
            reanalysisStatus.textContent = error.message;
            bridge.setStatus(error.message, true);
        });
    });
    projectWideProject.addEventListener("change", () => {
        populateProjectWideFrameworks();
        invalidateProjectWidePreview();
    });
    projectWideFramework.addEventListener(
        "change",
        invalidateProjectWidePreview
    );
    projectWidePreviewButton.addEventListener("click", () => {
        previewProjectWideScope().catch(error => {
            projectWideStatus.textContent = error.message;
            bridge.setStatus(error.message, true);
        });
    });
    projectWideRequestButton.addEventListener("click", () => {
        requestProjectWideReanalysis().catch(error => {
            projectWideStatus.textContent = error.message;
            bridge.setStatus(error.message, true);
        });
    });

    renderWorkspace();
    loadWorkspace().catch(error => bridge.setStatus(error.message, true));
}());
