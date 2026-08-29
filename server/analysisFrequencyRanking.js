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

function cleanText(value) {
    return typeof value === "string"
        ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
}

function normalizedLanguage(value) {
    return typeof value === "string"
        ? value.trim().toLocaleLowerCase("en-US")
        : "";
}

export function normalizedKeyword(value) {
    return typeof value === "string"
        ? value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
        : "";
}

function displayKeyword(value) {
    return cleanText(value);
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
            englishSourceTexts: new Set(),
            sourceMessageIds: new Set(),
            count: 0
        };
        if (text) current.variants.add(text);
        const language = normalizedLanguage(highlight?.source_language);
        const englishSourceText = cleanText(highlight?.english_translation);
        if (language && language !== "en" && englishSourceText) {
            current.englishSourceTexts.add(englishSourceText);
        }
        if (highlight?.message_id !== null
            && highlight?.message_id !== undefined) {
            current.sourceMessageIds.add(String(highlight.message_id));
        }
        current.count += 1;
        groups.set(key, current);
    });

    return [...groups.values()]
        .map(group => ({
            normalizedText: group.normalizedText,
            text: [...group.variants].sort(deterministicTextCompare)[0]
                || group.normalizedText,
            englishSourceTexts: [...group.englishSourceTexts]
                .sort(deterministicTextCompare),
            sourceMessageIds: [...group.sourceMessageIds]
                .sort(deterministicTextCompare),
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

export function groupEqualMentionRanks(items, countKey) {
    const groups = [];

    (items || []).forEach(item => {
        const mentionCount = Number(item?.[countKey]) || 0;
        const current = groups.at(-1);
        if (!current || current.mentionCount !== mentionCount) {
            groups.push({
                rank: groups.length + 1,
                mentionCount,
                items: [item]
            });
            return;
        }
        current.items.push(item);
    });

    return groups;
}

function keywordComparisonText(keyword) {
    return keyword.englishSourceTexts?.length
        ? keyword.englishSourceTexts.join(" / ")
        : keyword.text;
}

function keywordFrequencyGroups(keywords) {
    return groupEqualMentionRanks(keywords, "count").map(group => ({
        ...group,
        count: group.mentionCount,
        text: [...new Set(group.items.map(keywordComparisonText).filter(Boolean))]
            .sort(deterministicTextCompare)
            .join("; "),
        originalText: group.items.map(item => item.text)
            .sort(deterministicTextCompare)
            .join("; ")
    }));
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
                rankedKeywords: [],
                rankedCodeGroups: [],
                rankedThemeGroups: [],
                rankedKeywordGroups: []
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
            || deterministicRecordCompare(left, right, "code_label")
        );
    const rankedCodeGroups = groupEqualMentionRanks(
        rankedCodes,
        "occurrenceCount"
    );
    rankedCodeGroups.forEach(group => {
        group.items = group.items.map(code => ({ ...code, rank: group.rank }));
    });
    const rankedCodeItems = rankedCodeGroups.flatMap(group => group.items);

    const validCodeIds = new Set(rankedCodeItems.map(code => code.id));
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
            || deterministicRecordCompare(left, right, "theme_label")
        );
    const rankedThemeGroups = groupEqualMentionRanks(
        rankedThemes,
        "occurrenceCount"
    );
    rankedThemeGroups.forEach(group => {
        group.items = group.items.map(theme => ({ ...theme, rank: group.rank }));
    });
    const rankedThemeItems = rankedThemeGroups.flatMap(group => group.items);

    const displayCodes = rankedCodeItems.map(code => ({
        ...code,
        original_code_label: code.code_label,
        code_number: code.rank,
        frequencyStats: {
            keywordCount: code.keywordCount,
            occurrenceCount: code.occurrenceCount
        },
        code_label: codeDisplayLabel(code)
    }));
    const displayThemes = rankedThemeItems.map(theme => ({
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
    const rankedKeywordGroups = keywordFrequencyGroups(rankedKeywords);

    const rankedCase = {
        ...caseRecord,
        codes: displayCodes,
        themes: displayThemes,
        keywordFrequency: rankedKeywordGroups
    };
    return includeRankedCollections
        ? {
            ...rankedCase,
            rankedCodes: rankedCodeItems,
            rankedThemes: rankedThemeItems,
            rankedKeywords,
            rankedCodeGroups,
            rankedThemeGroups,
            rankedKeywordGroups
        }
        : rankedCase;
}
