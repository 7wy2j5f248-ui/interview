import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../research-governance.html", import.meta.url);

test("independent governance page states every mandatory platform rule", async () => {
    const html = await readFile(pageUrl, "utf8");

    assert.match(html, /Global Research Governance \/ Participant Privacy Rules/);
    assert.match(html, /Participants remain anonymous at all times/i);
    assert.match(html, /must not be introduced merely to satisfy database or Row Level Security architecture/i);
    assert.match(html, /Access protection must preserve anonymity/i);
    assert.match(html, /Researcher-only, explicit AI control/i);
    assert.match(html, /select the provider and exact model/i);
    assert.match(html, /confirm a visible execution plan/i);
    assert.match(html, /No hidden paid processing/i);
    assert.match(html, /original source material, not prior AI analysis/i);
    assert.match(html, /Cross-case work is a separate stage/i);
    assert.match(html, /Researcher-visible provenance/i);
    assert.match(html, /Active operations can be stopped/i);
    assert.match(html, /Historical states remain distinguishable/i);
    assert.match(html, /Governance changes are traceable/i);
});

test("governance page is read-only, versioned, and explicit about the RLS boundary", async () => {
    const html = await readFile(pageUrl, "utf8");

    assert.match(html, /GRG-PPR-1\.0\.0/g);
    assert.match(html, /Append-only change record/i);
    assert.match(html, /does not enable Row Level Security/i);
    assert.match(html, /does not enable Row Level Security,[\s\S]*create participant accounts,[\s\S]*introduce participant authentication/i);
    assert.match(html, /page has no[\s\S]*authentication, or database action/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<form\b/i);
    assert.doesNotMatch(html, /fetch\s*\(/i);
});

test("researcher-facing and rule pages link to the independent governance page", async () => {
    const pages = await Promise.all([
        "../staged-analysis.html",
        "../researcher.html",
        "../global-analysis-rules.html",
        "../project-analysis-rules.html",
        "../design.html"
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

    for (const html of pages) {
        assert.match(html, /research-governance\.html/);
    }
});
