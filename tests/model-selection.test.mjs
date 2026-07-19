import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    DEFAULT_OPENAI_MODEL,
    isValidOpenAIModelId,
    normalizeOpenAIModel
} from "../server/modelConfiguration.js";
import { isUsableResearchDesign } from "../server/researchDesign.js";

test("normalizes configurable OpenAI model identifiers", () => {
    assert.equal(DEFAULT_OPENAI_MODEL, "gpt-5.1");
    assert.equal(normalizeOpenAIModel(" gpt-5.1-mini "), "gpt-5.1-mini");
    assert.equal(normalizeOpenAIModel(""), DEFAULT_OPENAI_MODEL);
    assert.equal(isValidOpenAIModelId("provider:model-v2.1"), true);
    assert.equal(isValidOpenAIModelId("bad model"), false);
    assert.throws(() => normalizeOpenAIModel("bad/model"), /model ID/);
});

test("legacy and configured research designs remain usable", () => {
    const base = {
        research_goal: "Understand participant experience.",
        ai_role: "Ask neutral questions.",
        ending_message: "Thank the participant.",
        interview_questions: "1. What happened?",
        interview_question_count: 1,
        maximum_interviewer_questions: 3
    };

    assert.equal(isUsableResearchDesign(base), true);
    assert.equal(isUsableResearchDesign({
        ...base,
        interview_model: "gpt-5.1-mini"
    }), true);
    assert.equal(isUsableResearchDesign({
        ...base,
        interview_model: "bad model"
    }), false);
});

test("researcher interfaces select separate interview and analysis models", async () => {
    const [designHtml, designJs, researcherHtml, researcherAnalysis] =
        await Promise.all([
            readFile(new URL("../design.html", import.meta.url), "utf8"),
            readFile(new URL("../design.js", import.meta.url), "utf8"),
            readFile(new URL("../researcher.html", import.meta.url), "utf8"),
            readFile(new URL("../researcher-analysis.js", import.meta.url), "utf8")
        ]);

    assert.match(designHtml, /id="interviewModel"/);
    assert.match(designJs, /interviewModel:/);
    assert.match(researcherHtml, /id="analysisModel"/);
    assert.match(researcherAnalysis, /model: analysisModel\.value\.trim\(\)/);
    assert.match(researcherAnalysis, /Model \$\{workspace\.run\.model\}/);
});

test("runtime model choices are persisted and no longer hard-coded at call sites", async () => {
    const [chat, analysis, core, migration] = await Promise.all([
        readFile(new URL("../api/chat.js", import.meta.url), "utf8"),
        readFile(new URL("../api/analysis.js", import.meta.url), "utf8"),
        readFile(new URL("../server/analysisCore.js", import.meta.url), "utf8"),
        readFile(new URL(
            "../supabase/migrations/20260719030000_add_researcher_model_selection.sql",
            import.meta.url
        ), "utf8")
    ]);

    assert.match(chat, /model: preparedSession\.interviewModel/);
    assert.doesNotMatch(chat, /model: "gpt-5\.1"/);
    assert.match(analysis, /const model = analysisModel\(req\.body\?\.model\)/);
    assert.match(analysis, /generateSuggestionsForBatch[\s\S]*\{ model \}/);
    assert.match(analysis, /collectEvidenceForBatch[\s\S]*model: analysisModel\(run\.model\)/);
    assert.match(core, /DEFAULT_OPENAI_MODEL/);
    assert.match(migration, /research_designs[\s\S]*interview_model/);
    assert.match(migration, /interview_sessions[\s\S]*interview_model/);
    assert.match(migration, /prepare_interview_session_with_model/);
    assert.match(migration, /existing_session\.interview_model/);
});
