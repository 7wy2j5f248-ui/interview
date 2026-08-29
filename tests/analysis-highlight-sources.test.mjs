import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    enrichAnalysisHighlightSources
} from "../server/analysisHighlightSources.js";

test("stored message translations enrich highlights without changing evidence", async () => {
    const sourceMessages = [
        {
            id: "message-1",
            Language: "zh",
            EnglishTranslation: "I usually go to bed late."
        },
        {
            id: "message-2",
            Language: "en",
            EnglishTranslation: null
        }
    ];
    const selectedIds = [];
    const supabase = {
        from(table) {
            assert.equal(table, "interview_messages");
            const query = {
                select(columns) {
                    assert.equal(columns, "id, Language, EnglishTranslation");
                    return query;
                },
                in(column, ids) {
                    assert.equal(column, "id");
                    selectedIds.push(...ids);
                    return query;
                },
                order() {
                    return query;
                },
                async range() {
                    return {
                        data: sourceMessages.filter(message =>
                            selectedIds.includes(message.id)
                        ),
                        error: null
                    };
                }
            };
            return query;
        }
    };
    const highlights = [
        {
            id: "highlight-1",
            message_id: "message-1",
            exact_text: "晚睡"
        },
        {
            id: "highlight-2",
            message_id: "message-2",
            exact_text: "early mornings"
        }
    ];

    const enriched = await enrichAnalysisHighlightSources(
        supabase,
        highlights
    );

    assert.deepEqual(enriched, [
        {
            ...highlights[0],
            source_language: "zh",
            english_translation: "I usually go to bed late."
        },
        {
            ...highlights[1],
            source_language: "en",
            english_translation: null
        }
    ]);
    assert.deepEqual(selectedIds.sort(), ["message-1", "message-2"]);
});

test("highlight enrichment is stored-data only and shared by dashboard and export", async () => {
    const helper = await readFile(
        new URL("../server/analysisHighlightSources.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const workbookExport = await readFile(
        new URL("../api/automatic-analysis-ranked-export.js", import.meta.url),
        "utf8"
    );

    assert.match(helper, /select\("id, Language, EnglishTranslation"\)/);
    assert.doesNotMatch(helper, /OpenAI|OPENAI_API_KEY|fetch\(/);
    assert.match(dashboard, /enrichAnalysisHighlightSources/);
    assert.match(workbookExport, /enrichAnalysisHighlightSources/);
});
