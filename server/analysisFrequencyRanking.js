const COLLATOR_OPTIONS = Object.freeze({
    numeric: true,
    sensitivity: "base"
});

function deterministicTextCompare(left, right) {
    const leftText = String(left || "");
    const rightText = String(right || "");
    return leftText.localeCompare(rightText, "en", COLLATOR_OPTIONS)
        || leftText.localeCompare(rightText, "en");
}

function deterministicRecordCompare(left, right, labelKey) {
    return deterministicTextCompare(left?.[labelKey], right?.[labelKey])
        || deterministicTextCompare(left?.id, right?.id);
}

export function normalizedKeyword(value) {
    return typeof value === "string"
        ? value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
        : "";
}

function displayKeyword(value) {
    return typeof value === "string"
        ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
}

export function groupedValidatedKeywords(highlights) {
    const groups = new Map();

    (highlights || []).forEach(highlight => {
        const key = normalizedKeyword(highlight?.exact_text);
        if (!key) return;
        const text = displayKeyword(highlight.exact_text);
        const current = groups.get(key) || {
            normalizedText: key,
            variants: new Set(),
            count: 0
        };
        if (text) current.variants.add(text);
        current.count += 1;
        groups.set(key, current);
    });

    return [...groups.values()]
        .map(group => ({
            normalizedText: group.normalizedText,
            text: [...group.variants].sort(deterministicTextCompare)[0]
                || group.normalizedText,
            count: group.count
        }))
        .sort((left, right) =>
            right.count - left.count
            || deterministicTextCompare(
                left.normalizedText,
                right.normalizedText
            )
        );
}

function codeDisplayLabel(code) {
    return `${code.code_label} · ${code.keywordCount} keyword${
        code.keywordCount === 1 ? "" : "s"
    } · ${code.occurrenceCount} mention${
        code.occurrenceCount === 1 ? "" : "s"
    }`;
}

function themeDisplayLabel(theme) {
    return `${theme.theme_label} · ${theme.codeCount} code${
        theme.codeCount === 1 ? "" : "s"
    } · ${theme.keywordCount} keyword${
        theme.keywordCount === 1 ? "" : "s"
    } · ${theme.occurrenceCount} mention${
        theme.occurrenceCount === 1 ? "" : "s"
    }`;
}

export function rankAnalysisCase(
    caseRecord,
    { includeRankedCollections = true } = {}
) {
    if (!caseRecord?.hasReport) {
        const unranked = {
            ...caseRecord,
            codes: caseRecord?.codes || [],
            themes: caseRecord?.themes || [],
            keywordFrequency: []
        };
        return includeRankedCollections
            ? {
                ...unranked,
                rankedCodes: [],
                rankedThemes: [],
                rankedKeywords: []
            }
            : unranked;
    }

    const highlights = Array.isArray(caseRecord.highlights)
        ? caseRecord.highlights
        : [];
    const highlightsByCode = new Map();

    highlights.forEach(highlight => {
        if (!highlight?.code_id) return;
        const values = highlightsByCode.get(highlight.code_id) || [];
        values.push(highlight);
        highlightsByCode.set(highlight.code_id, values);
    });

    const rankedCodes = [...(caseRecord.codes || [])]
        .map(code => {
            const occurrences = highlightsByCode.get(code.id) || [];
            const keywords = groupedValidatedKeywords(occurrences);
            return {
                ...code,
                original_code_number: code.original_code_number
                    ?? code.code_number,
                keywordCount: keywords.length,
                occurrenceCount: occurrences.length
            };
        })
        .sort((left, right) =>
            right.occurrenceCount - left.occurrenceCount
            || right.keywordCount - left.keywordCount
            || deterministicRecordCompare(left, right, "code_label")
        )
        .map((code, index) => ({
            ...code,
            rank: index + 1
        }));

    const validCodeIds = new Set(rankedCodes.map(code => code.id));
    const mappings = Array.isArray(caseRecord.themeCodes)
        ? caseRecord.themeCodes
        : [];
    const rankedThemes = [...(caseRecord.themes || [])]
        .map(theme => {
            const codeIds = [...new Set(
                mappings
                    .filter(mapping => mapping.theme_id === theme.id)
                    .map(mapping => mapping.code_id)
                    .filter(codeId => validCodeIds.has(codeId))
            )];
            const supportingHighlights = codeIds.flatMap(codeId =>
                highlightsByCode.get(codeId) || []
            );
            return {
                ...theme,
                original_theme_number: theme.original_theme_number
                    ?? theme.theme_number,
                codeCount: codeIds.length,
                keywordCount: groupedValidatedKeywords(
                    supportingHighlights
                ).length,
                occurrenceCount: supportingHighlights.length
            };
        })
        .sort((left, right) =>
            right.occurrenceCount - left.occurrenceCount
            || right.codeCount - left.codeCount
            || right.keywordCount - left.keywordCount
            || deterministicRecordCompare(left, right, "theme_label")
        )
        .map((theme, index) => ({
            ...theme,
            rank: index + 1
        }));

    const displayCodes = rankedCodes.map(code => ({
        ...code,
        original_code_label: code.code_label,
        code_number: code.rank,
        frequencyStats: {
            keywordCount: code.keywordCount,
            occurrenceCount: code.occurrenceCount
        },
        code_label: codeDisplayLabel(code)
    }));
    const displayThemes = rankedThemes.map(theme => ({
        ...theme,
        original_theme_label: theme.theme_label,
        theme_number: theme.rank,
        supportStats: {
            codeCount: theme.codeCount,
            keywordCount: theme.keywordCount,
            occurrenceCount: theme.occurrenceCount
        },
        theme_label: themeDisplayLabel(theme)
    }));
    const rankedKeywords = groupedValidatedKeywords(highlights);

    const rankedCase = {
        ...caseRecord,
        codes: displayCodes,
        themes: displayThemes,
        keywordFrequency: rankedKeywords
    };
    return includeRankedCollections
        ? {
            ...rankedCase,
            rankedCodes,
            rankedThemes,
            rankedKeywords
        }
        : rankedCase;
}
