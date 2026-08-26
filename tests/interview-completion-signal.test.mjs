import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the API exposes the canonical completion decision", async () => {
    const chat = await readFile(
        new URL("../api/chat.js", import.meta.url),
        "utf8"
    );

    assert.match(chat, /completed: finalQuestionAnswered/);
});

test("the interview page exposes a visible formal completion signal", async () => {
    const interview = await readFile(
        new URL("../interview.html", import.meta.url),
        "utf8"
    );

    assert.match(interview, /data-interview-status="active"/);
    assert.match(interview, /data-completion-signal="INTERVIEW_COMPLETE"/);
    assert.match(interview, /data\.completed === true/);
    assert.match(
        interview,
        /document\.body\.dataset\.interviewStatus = "completed"/
    );
    assert.match(interview, /completionStatus\.hidden = false/);
});
