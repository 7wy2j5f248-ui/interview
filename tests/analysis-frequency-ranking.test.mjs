import test from "node:test";
import assert from "node:assert/strict";
import {
    groupedValidatedKeywords,
    rankAnalysisCase
} from "../server/analysisFrequencyRanking.js";

function highlight(id, codeId, exactText) {
    return {
        id,
        code_id: codeId,
        exact_text: exactText
    };
}

test("validated keyword grouping normalizes case and whitespace deterministically", () => {
    const values = [
        highlight("h1", "c1", "  Bedtime "),
        highlight("h2", "c1", "bedtime"),
        highlight("h3", "c1", "BEDTIME"),
        highlight("h4", "c1", "Alpha"),
        highlight("h5", "c1", "zeta")
    ];
    const ranked = groupedValidatedKeywords(values);
    const reversed = groupedValidatedKeywords([...values].reverse());

    assert.deepEqual(ranked, reversed);
    assert.equal(ranked[0].normalizedText, "bedtime");
    assert.equal(ranked[0].count, 3);
    assert.deepEqual(
        ranked.slice(1).map(keyword => keyword.normalizedText),
        ["alpha", "zeta"]
    );
});

test("equal keyword frequencies share one dense rank group", () => {
    const highlights = [
        ...Array.from({ length: 5 }, (_, index) =>
            highlight(`b${index}`, "c1", "bedtime")
        ),
        ...Array.from({ length: 5 }, (_, index) =>
            highlight(`s${index}`, "c1", "sleep time")
        ),
        highlight("w1", "c1", "work"),
        highlight("a1", "c1", "alarm")
    ];
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [{ id: "c1", code_number: 1, code_label: "Sleep" }],
        themes: [],
        themeCodes: [],
        highlights
    });
    const reversed = rankAnalysisCase({
        hasReport: true,
        codes: [{ id: "c1", code_number: 1, code_label: "Sleep" }],
        themes: [],
        themeCodes: [],
        highlights: [...highlights].reverse()
    });

    assert.deepEqual(ranked.rankedKeywordGroups, reversed.rankedKeywordGroups);
    assert.equal(ranked.rankedKeywordGroups.length, 2);
    assert.equal(ranked.rankedKeywordGroups[0].mentionCount, 5);
    assert.deepEqual(
        ranked.rankedKeywordGroups[0].items.map(item => item.text),
        ["bedtime", "sleep time"]
    );
    assert.equal(ranked.rankedKeywordGroups[1].mentionCount, 1);
    assert.deepEqual(
        ranked.rankedKeywordGroups[1].items.map(item => item.text),
        ["alarm", "work"]
    );
});

test("stored English is primary while original keyword evidence stays traceable", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [{ id: "c1", code_number: 1, code_label: "Sleep" }],
        themes: [],
        themeCodes: [],
        highlights: [{
            id: "h1",
            code_id: "c1",
            message_id: "message-zh-1",
            exact_text: "晚睡",
            source_language: "zh",
            english_translation: "I usually go to bed late."
        }]
    });

    assert.equal(
        ranked.keywordFrequency[0].text,
        "I usually go to bed late."
    );
    assert.equal(ranked.keywordFrequency[0].originalText, "晚睡");
    assert.deepEqual(
        ranked.keywordFrequency[0].items[0].sourceMessageIds,
        ["message-zh-1"]
    );
});

test("codes prioritize total validated mentions over distinct keyword count", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [
            { id: "distinct", code_number: 1, code_label: "Many distinct" },
            { id: "mentions", code_number: 2, code_label: "Many mentions" }
        ],
        themes: [],
        themeCodes: [],
        highlights: [
            highlight("d1", "distinct", "alpha"),
            highlight("d2", "distinct", "beta"),
            highlight("d3", "distinct", "gamma"),
            ...Array.from({ length: 5 }, (_, index) =>
                highlight(`m${index}`, "mentions", "repeat")
            )
        ]
    });

    assert.equal(ranked.rankedCodes[0].id, "mentions");
    assert.equal(ranked.rankedCodes[0].occurrenceCount, 5);
    assert.equal(ranked.rankedCodes[0].keywordCount, 1);
    assert.equal(ranked.rankedCodes[1].keywordCount, 3);
    assert.equal(ranked.codes[0].code_number, 1);
    assert.equal(ranked.codes[0].original_code_number, 2);
});

test("code mention ties share one rank and ignore distinct keyword count", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [
            { id: "z", code_number: 1, code_label: "Zulu varied" },
            { id: "a", code_number: 2, code_label: "Alpha repeated" }
        ],
        themes: [],
        themeCodes: [],
        highlights: [
            highlight("z1", "z", "one"),
            highlight("z2", "z", "two"),
            highlight("z3", "z", "three"),
            ...Array.from({ length: 3 }, (_, index) =>
                highlight(`a${index}`, "a", "repeat")
            )
        ]
    });

    assert.equal(ranked.rankedCodeGroups.length, 1);
    assert.equal(ranked.rankedCodeGroups[0].mentionCount, 3);
    assert.deepEqual(
        ranked.rankedCodeGroups[0].items.map(code => code.code_label),
        ["Alpha repeated", "Zulu varied"]
    );
    assert.deepEqual(ranked.rankedCodes.map(code => code.rank), [1, 1]);
    assert.deepEqual(ranked.codes.map(code => code.code_number), [1, 1]);
});

test("themes prioritize mentions before supporting codes and distinct keywords", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [
            { id: "c1", code_number: 1, code_label: "First" },
            { id: "c2", code_number: 2, code_label: "Second" },
            { id: "c3", code_number: 3, code_label: "Third" }
        ],
        themes: [
            { id: "many-codes", theme_number: 1, theme_label: "Many codes" },
            { id: "many-mentions", theme_number: 2, theme_label: "Many mentions" },
            { id: "shared", theme_number: 3, theme_label: "Shared evidence" }
        ],
        themeCodes: [
            { theme_id: "many-codes", code_id: "c1" },
            { theme_id: "many-codes", code_id: "c2" },
            { theme_id: "many-mentions", code_id: "c3" },
            { theme_id: "shared", code_id: "c3" }
        ],
        highlights: [
            highlight("a1", "c1", "alpha"),
            highlight("a2", "c1", "beta"),
            highlight("b1", "c2", "gamma"),
            ...Array.from({ length: 5 }, (_, index) =>
                highlight(`c${index}`, "c3", "repeat")
            )
        ]
    });

    assert.equal(ranked.rankedThemes[0].id, "many-mentions");
    assert.equal(ranked.rankedThemes[0].occurrenceCount, 5);
    assert.equal(ranked.rankedThemes[0].codeCount, 1);
    assert.equal(ranked.rankedThemes[1].id, "shared");
    assert.equal(ranked.rankedThemes[2].id, "many-codes");
    assert.equal(ranked.rankedThemes[2].codeCount, 2);
    assert.equal(ranked.themes[0].theme_number, 1);
    assert.equal(ranked.themes[0].original_theme_number, 2);
});

test("theme mention ties share one rank and ignore supporting-code count", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [
            { id: "a", code_number: 1, code_label: "Alpha code" },
            { id: "z1", code_number: 2, code_label: "Zulu first" },
            { id: "z2", code_number: 3, code_label: "Zulu second" }
        ],
        themes: [
            { id: "z", theme_number: 1, theme_label: "Zulu theme" },
            { id: "a-theme", theme_number: 2, theme_label: "Alpha theme" }
        ],
        themeCodes: [
            { theme_id: "a-theme", code_id: "a" },
            { theme_id: "z", code_id: "z1" },
            { theme_id: "z", code_id: "z2" }
        ],
        highlights: [
            ...Array.from({ length: 4 }, (_, index) =>
                highlight(`a${index}`, "a", "repeat")
            ),
            highlight("z1", "z1", "one"),
            highlight("z2", "z1", "two"),
            highlight("z3", "z2", "three"),
            highlight("z4", "z2", "four")
        ]
    });

    assert.equal(ranked.rankedThemeGroups.length, 1);
    assert.equal(ranked.rankedThemeGroups[0].mentionCount, 4);
    assert.deepEqual(
        ranked.rankedThemeGroups[0].items.map(theme => theme.theme_label),
        ["Alpha theme", "Zulu theme"]
    );
    assert.deepEqual(ranked.rankedThemes.map(theme => theme.rank), [1, 1]);
    assert.deepEqual(ranked.themes.map(theme => theme.theme_number), [1, 1]);
});

test("zero evidence and missing mappings receive deterministic zero-valued ranks", () => {
    const ranked = rankAnalysisCase({
        hasReport: true,
        codes: [
            { id: "z", code_number: 1, code_label: "Zulu" },
            { id: "a", code_number: 2, code_label: "Alpha" }
        ],
        themes: [
            { id: "t-z", theme_number: 1, theme_label: "Zulu" },
            { id: "t-a", theme_number: 2, theme_label: "Alpha" }
        ],
        highlights: [],
        themeCodes: [{ theme_id: "missing", code_id: "a" }]
    });

    assert.deepEqual(ranked.rankedCodes.map(code => code.id), ["a", "z"]);
    assert.deepEqual(ranked.rankedThemes.map(theme => theme.id), ["t-a", "t-z"]);
    assert.ok(ranked.rankedCodes.every(code => code.occurrenceCount === 0));
    assert.ok(ranked.rankedThemes.every(theme => theme.codeCount === 0));
    assert.deepEqual(ranked.rankedKeywords, []);
});
