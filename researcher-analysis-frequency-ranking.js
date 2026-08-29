(function installAutomaticAnalysisFrequencyRanking() {
    "use strict";

    const originalFetch = window.fetch.bind(window);
    window.PLI_FREQUENCY_ANALYSIS = window.PLI_FREQUENCY_ANALYSIS || {
        casesByScope: new Map()
    };

    function normalizedKeyword(value) {
        return typeof value === "string"
            ? value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()
            : "";
    }

    function groupedKeywordStats(highlights) {
        const groups = new Map();
        (highlights || []).forEach(highlight => {
            const key = normalizedKeyword(highlight.exact_text);
            if (!key) return;
            const current = groups.get(key) || {
                text: highlight.exact_text,
                count: 0
            };
            current.count += 1;
            groups.set(key, current);
        });
        return [...groups.values()].sort((left, right) =>
            right.count - left.count
            || left.text.localeCompare(right.text, undefined, { sensitivity: "base" })
        );
    }

    function rankCase(caseRecord) {
        if (!caseRecord?.hasReport) return caseRecord;

        const highlights = Array.isArray(caseRecord.highlights)
            ? caseRecord.highlights
            : [];
        const codeStatsById = new Map();

        (caseRecord.codes || []).forEach(code => {
            const codeHighlights = highlights.filter(highlight =>
                highlight.code_id === code.id
            );
            const keywords = groupedKeywordStats(codeHighlights);
            codeStatsById.set(code.id, {
                keywordCount: keywords.length,
                occurrenceCount: codeHighlights.length,
                keywords
            });
        });

        const codes = [...(caseRecord.codes || [])]
            .sort((left, right) => {
                const leftStats = codeStatsById.get(left.id) || {};
                const rightStats = codeStatsById.get(right.id) || {};
                return (rightStats.occurrenceCount || 0)
                    - (leftStats.occurrenceCount || 0)
                    || (rightStats.keywordCount || 0)
                    - (leftStats.keywordCount || 0)
                    || String(left.code_label || "").localeCompare(
                        String(right.code_label || ""),
                        undefined,
                        { sensitivity: "base" }
                    );
            })
            .map((code, index) => {
                const stats = codeStatsById.get(code.id) || {
                    keywordCount: 0,
                    occurrenceCount: 0,
                    keywords: []
                };
                return {
                    ...code,
                    original_code_number: code.code_number,
                    code_number: index + 1,
                    frequencyStats: stats,
                    code_label: `${code.code_label} · ${stats.keywordCount} keyword${stats.keywordCount === 1 ? "" : "s"} · ${stats.occurrenceCount} mention${stats.occurrenceCount === 1 ? "" : "s"}`
                };
            });

        const codeRankById = new Map(codes.map(code => [
            code.id,
            code.code_number
        ]));
        const mappings = Array.isArray(caseRecord.themeCodes)
            ? caseRecord.themeCodes
            : [];

        const themes = [...(caseRecord.themes || [])]
            .map(theme => {
                const supportingCodeIds = [...new Set(
                    mappings
                        .filter(mapping => mapping.theme_id === theme.id)
                        .map(mapping => mapping.code_id)
                        .filter(codeId => codeRankById.has(codeId))
                )];
                const supportingHighlights = supportingCodeIds.flatMap(codeId =>
                    highlights.filter(highlight => highlight.code_id === codeId)
                );
                return {
                    ...theme,
                    supportStats: {
                        codeCount: supportingCodeIds.length,
                        keywordCount: groupedKeywordStats(supportingHighlights).length,
                        occurrenceCount: supportingHighlights.length
                    }
                };
            })
            .sort((left, right) =>
                right.supportStats.occurrenceCount - left.supportStats.occurrenceCount
                || right.supportStats.codeCount - left.supportStats.codeCount
                || right.supportStats.keywordCount - left.supportStats.keywordCount
                || String(left.theme_label || "").localeCompare(
                    String(right.theme_label || ""),
                    undefined,
                    { sensitivity: "base" }
                )
            )
            .map((theme, index) => ({
                ...theme,
                original_theme_number: theme.theme_number,
                theme_number: index + 1,
                theme_label: `${theme.theme_label} · ${theme.supportStats.codeCount} code${theme.supportStats.codeCount === 1 ? "" : "s"} · ${theme.supportStats.occurrenceCount} mention${theme.supportStats.occurrenceCount === 1 ? "" : "s"}`
            }));

        const keywordFrequency = groupedKeywordStats(highlights);

        return {
            ...caseRecord,
            codes,
            themes,
            keywordFrequency
        };
    }

    function isAutomaticAnalysisGet(input, init) {
        const method = String(init?.method || "GET").toUpperCase();
        if (method !== "GET") return false;
        const rawUrl = typeof input === "string" ? input : input?.url;
        if (!rawUrl) return false;
        const url = new URL(rawUrl, window.location.origin);
        return url.pathname === "/api/automatic-analysis";
    }

    function participantCode(caseRecord) {
        return caseRecord?.transcriptIdentity?.participantCode
            || String(caseRecord?.caseNumber || "").split("-S")[0]
            || "—";
    }

    function sessionNumber(caseRecord) {
        if (Number.isInteger(caseRecord?.sessionNumber)
            && caseRecord.sessionNumber > 0) {
            return String(caseRecord.sessionNumber);
        }
        const match = String(caseRecord?.caseNumber || "").match(/-S(\d+)$/i);
        return match ? String(Number.parseInt(match[1], 10)) : "—";
    }

    function currentScope() {
        const archived = document.querySelector(
            '[data-automatic-analysis-view="archive"][aria-pressed="true"]'
        );
        return archived ? "archived" : "active";
    }

    function decorateKeywordTable() {
        const casesTab = document.querySelector(
            '[data-automatic-analysis-view="cases"][aria-pressed="true"]'
        );
        if (!casesTab) return;

        const table = document.querySelector(
            "#automaticAnalysisTable table.automaticAnalysisTable"
        );
        if (!table || table.dataset.frequencyKeywords === "true") return;

        const caseMap = window.PLI_FREQUENCY_ANALYSIS.casesByScope.get(
            currentScope()
        );
        if (!caseMap?.size) return;

        const cases = [...caseMap.values()];
        const maximum = Math.max(
            0,
            ...cases.map(item => item.keywordFrequency?.length || 0)
        );
        if (!maximum) return;

        const byDisplayIdentity = new Map(cases.map(item => [
            `${participantCode(item)}\u0000${sessionNumber(item)}`,
            item
        ]));
        const headerRow = table.tHead?.rows?.[0];
        if (!headerRow) return;

        for (let index = 0; index < maximum; index += 1) {
            const header = document.createElement("th");
            header.scope = "col";
            header.textContent = `K${index + 1} · frequency`;
            headerRow.appendChild(header);
        }

        [...(table.tBodies?.[0]?.rows || [])].forEach(row => {
            const key = `${row.cells[0]?.textContent || ""}\u0000${row.cells[1]?.textContent || ""}`;
            const caseRecord = byDisplayIdentity.get(key);
            for (let index = 0; index < maximum; index += 1) {
                const keyword = caseRecord?.keywordFrequency?.[index];
                const cell = document.createElement("td");
                if (keyword) {
                    cell.textContent = `${keyword.text} (${keyword.count})`;
                    cell.title = `${keyword.count} validated occurrence${keyword.count === 1 ? "" : "s"}`;
                } else {
                    cell.textContent = "—";
                    cell.className = "analysisEmptyCell";
                }
                row.appendChild(cell);
            }
        });

        table.dataset.frequencyKeywords = "true";
    }

    window.fetch = async function rankedAutomaticAnalysisFetch(input, init) {
        const response = await originalFetch(input, init);
        if (!response.ok || !isAutomaticAnalysisGet(input, init)) {
            return response;
        }

        try {
            const data = await response.clone().json();
            if (!Array.isArray(data?.cases)) return response;
            const rankedCases = data.cases.map(rankCase);
            const scope = data.scope || "active";
            const page = Number(data.page) || 1;
            const existing = window.PLI_FREQUENCY_ANALYSIS.casesByScope.get(scope) || new Map();
            rankedCases.forEach(item => {
                const key = item.transcriptIdentity?.sessionId || item.caseNumber;
                if (key) existing.set(key, item);
            });
            window.PLI_FREQUENCY_ANALYSIS.casesByScope.set(scope, existing);
            window.dispatchEvent(new CustomEvent("plifrequencyanalysisupdate", {
                detail: { scope, page }
            }));
            const headers = new Headers(response.headers);
            headers.set("Content-Type", "application/json; charset=utf-8");
            return new Response(JSON.stringify({
                ...data,
                cases: rankedCases
            }), {
                status: response.status,
                statusText: response.statusText,
                headers
            });
        } catch {
            return response;
        }
    };

    const tableHost = document.getElementById("automaticAnalysisTable");
    if (tableHost) {
        const observer = new MutationObserver(() => decorateKeywordTable());
        observer.observe(tableHost, { childList: true, subtree: true });
    }
    window.addEventListener("plifrequencyanalysisupdate", () => {
        queueMicrotask(decorateKeywordTable);
    });
    document.querySelectorAll("[data-automatic-analysis-view]").forEach(button => {
        button.addEventListener("click", () => queueMicrotask(decorateKeywordTable));
    });
}());
