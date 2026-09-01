import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    createTranslationClient,
    TRANSLATION_API_BASE_URL,
    TRANSLATION_PROVIDER
} from "../server/translationProvider.js";

test("translation is pinned directly to the existing OpenAI API account", () => {
    let options = null;
    class FakeOpenAI {
        constructor(value) {
            options = value;
        }
    }

    const client = createTranslationClient(
        { OPENAI_API_KEY: "existing-test-key" },
        FakeOpenAI
    );

    assert.ok(client instanceof FakeOpenAI);
    assert.equal(TRANSLATION_PROVIDER, "openai-api");
    assert.equal(TRANSLATION_API_BASE_URL, "https://api.openai.com/v1");
    assert.deepEqual(options, {
        apiKey: "existing-test-key",
        baseURL: "https://api.openai.com/v1"
    });
});

test("translation cannot silently fall back when the existing key is absent", () => {
    assert.throws(
        () => createTranslationClient({}, class FakeOpenAI {}),
        /existing OpenAI API key is not configured/
    );
});

test("transcript viewing never creates a paid translation call", async () => {
    const endpoint = await readFile(
        new URL("../api/messages.js", import.meta.url),
        "utf8"
    );

    assert.doesNotMatch(endpoint, /createTranslationClient/);
    assert.doesNotMatch(endpoint, /ensureEnglishTranslations/);
    assert.doesNotMatch(endpoint, /OPENAI_API_KEY/);
});

test("automatic translation sends only one API request at a time", async () => {
    const worker = await readFile(
        new URL("../server/transcriptTranslationQueue.js", import.meta.url),
        "utf8"
    );

    assert.match(worker, /concurrency: 1/);
    assert.doesNotMatch(worker, /concurrency: [2-9]/);
});
