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

    function meaningUnitReportContent(unit) {
        const host = make("div", "report-mu-content");
        const english = unit?.englishText
            || "English source evidence unavailable.";
        host.appendChild(make("div",
            unit?.englishTextAvailable === false ? "warning" : "report-mu-english",
            english));
        const sources = unit?.englishTextSources || [];
        host.appendChild(make("small", "muted",
            sources.includes("stored_source_message_translation")
                ? "English presentation: stored translation of this MU's source message."
                : sources.includes("exact_gpt56_english_mu")
                    ? "English presentation: exact English MU text returned by GPT-5.6."
                    : "No separate stored English source was available."));
        if (unit?.originalEvidenceText
            && unit.originalEvidenceText !== english) {
            const original = make("details", "report-mu-original");
            original.appendChild(make("summary", "",
                "Exact original-language GPT-5.6 MU evidence"));
            original.appendChild(make("div", "", unit.originalEvidenceText));
            host.appendChild(original);
        }
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
                    const item = document.createElement("li");
                    item.appendChild(make("strong", "", `${id}: `));
                    item.appendChild(meaningUnitReportContent(unit));
                    list.appendChild(item);
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
                parts.push(codes.map(code => {
                    const mappedPosition = code.meaningUnitIds.indexOf(unit.id) + 1;
                    const mappedTotal = code.meaningUnitIds.length;
                    const reportTotal = code.mentionCount;
                    const mention = mappedTotal === reportTotal
                        ? `MU mention ${mappedPosition} of ${reportTotal}`
                        : `mapped MU mention ${mappedPosition} of ${mappedTotal}; report count ${reportTotal}`;
                    return `${code.id} · ${code.label} · ${mention}`;
                }).join("; "));
            } else {
                parts.push("No linked CO → MU mention");
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

    function inlineMeaningUnitIds(transcriptNode) {
        const ids = new Set();
        transcriptNode.querySelectorAll("mark[data-meaning-units]")
            .forEach(mark => String(mark.dataset.meaningUnits || "")
                .split(",").filter(Boolean).forEach(id => ids.add(id)));
        return ids;
    }

    function muMentionReconciliation(report, inlineIds) {
        return reportTable([
            { label: "Preliminary Code", value: code => `${code.id} · ${code.label}` },
            { label: "Report MU mentions", value: code => code.mentionCount },
            { label: "Mapped MU IDs", value: code => code.meaningUnitIds.length },
            { label: "Inline MU markers", value: code =>
                code.meaningUnitIds.filter(id => inlineIds.has(id)).length },
            { label: "Direct check", value: code => {
                const mapped = code.meaningUnitIds.length;
                const inline = code.meaningUnitIds.filter(id =>
                    inlineIds.has(id)).length;
                if (code.mentionCount === mapped && mapped === inline) {
                    return `${inline} inline = ${mapped} mapped = ${code.mentionCount} reported`;
                }
                return `${inline} inline; ${mapped} mapped; ${code.mentionCount} reported — difference shown without altering the provider report`;
            } },
            { label: "Meaning Units", value: code => {
                const host = make("div", "chip-list");
                appendChips(host, code.meaningUnitIds.map(id =>
                    `${id}${inlineIds.has(id) ? " · inline" : " · not located"}`), "mu");
                return host;
            } }
        ], report.codes);
    }

    function muMentionText(code, unitId, position) {
        const mappedTotal = code.meaningUnitIds.length;
        return mappedTotal === code.mentionCount
            ? `MU mention ${position} of ${code.mentionCount}`
            : `mapped MU mention ${position} of ${mappedTotal}; report count ${code.mentionCount}`;
    }

    function stage1AnalyticalReport(report) {
        const host = make("div", "stage1-analytical-report");
        const unitById = new Map(report.meaningUnits.map(unit =>
            [unit.id, unit]));
        const codeById = new Map(report.codes.map(code => [code.id, code]));
        const categoryById = new Map(report.categories.map(category =>
            [category.id, category]));
        const representedCategories = new Set();
        const representedCodes = new Set();
        const representedUnits = new Set();

        function codeBlock(code) {
            const block = make("section", "stage1-code-block");
            block.appendChild(make("h6", "",
                `${code.id} · ${code.label} · ${code.mentionCount} reported MU mention${code.mentionCount === 1 ? "" : "s"}`));
            const list = document.createElement("ol");
            list.className = "stage1-mu-list";
            code.meaningUnitIds.forEach((unitId, index) => {
                const unit = unitById.get(unitId);
                const item = document.createElement("li");
                item.appendChild(make("strong", "",
                    `${unitId} · ${muMentionText(code, unitId, index + 1)}: `));
                item.appendChild(unit
                    ? meaningUnitReportContent(unit)
                    : make("span", "warning",
                        "Referenced MU is not present in the stored report."));
                list.appendChild(item);
                representedUnits.add(unitId);
            });
            if (!code.meaningUnitIds.length) {
                list.appendChild(make("li", "warning",
                    "No Meaning Unit IDs are mapped to this Code in the stored report."));
            }
            block.appendChild(list);
            representedCodes.add(code.id);
            return block;
        }

        function categoryBlock(category) {
            const block = make("section", "stage1-category-block");
            block.appendChild(make("h5", "",
                `${category.id} · ${category.label} · ${category.mentionCount} MU mention${category.mentionCount === 1 ? "" : "s"}`));
            category.codeIds.forEach(codeId => {
                const code = codeById.get(codeId);
                block.appendChild(code
                    ? codeBlock(code)
                    : make("p", "warning",
                        `${codeId} is referenced but absent from the stored Code array.`));
            });
            if (!category.codeIds.length) {
                block.appendChild(make("p", "warning",
                    "No Codes are linked to this Category in the stored report."));
            }
            representedCategories.add(category.id);
            return block;
        }

        report.themes.forEach(theme => {
            const block = make("article", "stage1-theme-block");
            block.appendChild(make("h4", "",
                `${theme.id} · ${theme.statement} · ${theme.mentionCount} MU mention${theme.mentionCount === 1 ? "" : "s"}`));
            theme.categoryIds.forEach(categoryId => {
                const category = categoryById.get(categoryId);
                block.appendChild(category
                    ? categoryBlock(category)
                    : make("p", "warning",
                        `${categoryId} is referenced but absent from the stored Category array.`));
            });
            if (!theme.categoryIds.length) {
                block.appendChild(make("p", "warning",
                    "No Categories are linked to this Theme in the stored report."));
            }
            host.appendChild(block);
        });

        const unthemed = report.categories.filter(category =>
            !representedCategories.has(category.id));
        if (unthemed.length) {
            const block = make("article", "stage1-theme-block ungrouped");
            block.appendChild(make("h4", "", "Categories without a Theme link"));
            unthemed.forEach(category => block.appendChild(categoryBlock(category)));
            host.appendChild(block);
        }

        const uncategorized = report.codes.filter(code =>
            !representedCodes.has(code.id));
        if (uncategorized.length) {
            const block = make("article", "stage1-theme-block ungrouped");
            block.appendChild(make("h4", "", "Codes without a Category link"));
            uncategorized.forEach(code => block.appendChild(codeBlock(code)));
            host.appendChild(block);
        }

        const unlinked = report.meaningUnits.filter(unit =>
            !representedUnits.has(unit.id));
        if (unlinked.length) {
            const block = make("article", "stage1-theme-block ungrouped");
            block.appendChild(make("h4", "", "Meaning Units without a Code link"));
            const list = document.createElement("ul");
            unlinked.forEach(unit => {
                const item = document.createElement("li");
                item.appendChild(make("strong", "", `${unit.id}: `));
                item.appendChild(meaningUnitReportContent(unit));
                list.appendChild(item);
            });
            block.appendChild(list);
            host.appendChild(block);
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
        element("v2RecordTitle").textContent =
            `${inspection.caseNumber} · supporting annotated transcript`;

        const completion = make("div", "contract report-completion");
        completion.appendChild(make("strong", "",
            "Supporting evidence for the Stage 1 Excel workbook report"));
        completion.appendChild(make("p", "",
            "The Excel workbook is the Stage 1 report. This optional page shows its hierarchy, provenance, and inline-annotated transcript for source inspection. It is not a substitute for the workbook and viewing it never affects progression."));
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
            ["MUs presented in English", inspection.counts.englishMeaningUnits],
            ["MUs missing stored English", inspection.counts.englishUnavailableMeaningUnits],
            ["Preliminary Codes", inspection.counts.codes],
            ["Preliminary Categories", inspection.counts.categories],
            ["Tentative Themes", inspection.counts.themes],
            ["Linked MU mentions", inspection.counts.linkedMeaningUnitMentions]
        ].forEach(([label, value]) => metrics.appendChild(metric(label, value)));
        content.appendChild(metrics);

        const analyticalReport = make("section", "report-section");
        analyticalReport.appendChild(make("h3", "",
            "Workbook content preview · MU → CO → CA → TH"));
        analyticalReport.appendChild(make("p", "muted",
            "This restores the previous report structure while using only this attempt's GPT-5.6 analytical content. The report-facing language is English. Themes contain Categories, Categories contain Codes, and every Code lists its Meaning Units with explicit MU-mention numbering. Original-language excerpts remain available as evidence and in the annotated transcript; they are not substituted for the English report."));
        analyticalReport.appendChild(stage1AnalyticalReport(report));
        content.appendChild(analyticalReport);

        const transcriptSection = make("section", "report-section");
        transcriptSection.appendChild(make("h3", "", "Full transcript with inline MU highlights"));
        transcriptSection.appendChild(make("p", "muted",
            "Each GPT-5.6 Meaning Unit is highlighted directly inside its stored message. Its MU, linked Code, MU-mention position, and linked Category labels sit immediately above that passage. The original-language message is always shown; when the analysis used an English translation, that translation appears directly below the same original message with its own inline highlights."));
        const transcriptView = annotatedTranscript(inspection);
        transcriptSection.appendChild(transcriptView);
        content.appendChild(transcriptSection);

        const mentionSection = make("section", "report-section");
        mentionSection.appendChild(make("h3", "", "MU mention reconciliation"));
        mentionSection.appendChild(make("p", "muted",
            "For every Code, this mechanically compares the report's MU-mention number with its mapped MU IDs and the unique MU markers visible in the transcript above. A difference is disclosed but never approves, rejects, repairs, or changes the analysis."));
        mentionSection.appendChild(muMentionReconciliation(
            report, inlineMeaningUnitIds(transcriptView)
        ));
        content.appendChild(mentionSection);

        const hierarchy = make("section", "report-section");
        hierarchy.appendChild(make("h3", "", "Complete relationship tables"));
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

    async function downloadStage1Report(cohort, button) {
        button.disabled = true;
        status.textContent = `Preparing one complete Stage 1 workbook for every case in ${cohort.name}…`;
        status.className = "muted";
        try {
            const response = await fetch(
                `${API}&download=stage1-report-xlsx&cohortId=${encodeURIComponent(cohort.id)}&_=${Date.now()}`,
                {
                    headers: { Authorization: `Bearer ${token()}` },
                    cache: "no-store"
                }
            );
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error
                    || "The Stage 1 Excel workbook report could not be prepared.");
            }
            const disposition = response.headers.get("Content-Disposition") || "";
            const filename = disposition.match(/filename="([^"]+)"/u)?.[1]
                || "stage1-report.xlsx";
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            const cases = response.headers.get("X-Stage1-Report-Cases") || "—";
            status.textContent = `One complete Stage 1 Excel workbook report downloaded. All ${cases} cohort cases are together in that workbook. It uses only the frozen selected-model reports; no AI call, validator, reviewer, repair, or retry was used.`;
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
        head.innerHTML = "<tr><th>Case</th><th>Frozen source</th><th>Stage 1</th><th>Attempts</th><th>Supporting evidence</th></tr>";
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
            inspect.textContent = "View supporting annotated transcript";
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

    function renderStage1Reports() {
        const host = element("v2Stage1Reports");
        host.replaceChildren();
        const memberships = state.cohortMemberships || [];
        const completedCaseIds = new Set(state.cases
            .filter(item => item.stage1_status === "completed")
            .map(item => item.id));
        const ready = (state.cohorts || []).filter(cohort => {
            if (!cohort.closed_at) return false;
            const memberIds = memberships
                .filter(member => member.cohort_id === cohort.id)
                .map(member => member.case_id);
            return memberIds.length > 0
                && memberIds.every(caseId => completedCaseIds.has(caseId));
        });
        if (!ready.length) {
            host.appendChild(make("p", "muted",
                "The single cohort workbook becomes available when the cohort is closed and every member has completed Stage 1."));
            return;
        }
        ready.forEach(cohort => {
            const memberCount = memberships.filter(member =>
                member.cohort_id === cohort.id).length;
            const panel = make("div", "contract");
            panel.appendChild(make("p", "lineage-primary",
                `Stage 1 report: one workbook containing all ${memberCount} cases in ${cohort.name}`));
            const download = document.createElement("button");
            download.type = "button";
            download.textContent = `Download one complete Stage 1 workbook — all ${memberCount} cases`;
            download.addEventListener("click", () =>
                downloadStage1Report(cohort, download));
            panel.appendChild(download);
            host.appendChild(panel);
        });
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
        renderStage1Reports();
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
