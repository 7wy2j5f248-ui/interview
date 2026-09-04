import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../contract-and-governance.html", import.meta.url);
const pdfUrl = new URL("../governance-contract/Researcher-Designated-AI-Direct-Analytical-Work-Contract.pdf", import.meta.url);
const docxUrl = new URL("../governance-contract/Researcher-Designated-AI-Direct-Analytical-Work-Contract.docx", import.meta.url);

test("Contract and Governance publishes the compiled direct-work contract", async () => {
    const html = await readFile(pageUrl, "utf8");

    assert.match(html, /<title>Contract and Governance \| intervu\.quest<\/title>/);
    assert.match(html, /<h1>Governance Contract<\/h1>/);
    assert.match(html, /GDAI-1\.0\.0/g);
    assert.match(html, /Researcher–Designated AI Direct Analytical Work Contract/);
    assert.match(html, /Researcher → Frozen contract and source → Designated AI → Exact response → Researcher/);
    assert.match(html, /R1 Authoritative Case Evidence Contract/);
    assert.match(html, /R2\.7 Provider Return Handling/);
    assert.match(html, /Stage 2A Cross-Case Code Harmonization Contract/);
    assert.match(html, /The analytical parties are the researcher and the designated AI only/);
    assert.match(html, /may not evaluate,[\s\S]*approve,[\s\S]*reject,[\s\S]*repair,[\s\S]*rewrite,[\s\S]*replace/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<form\b/i);
});

test("both finished contract formats are published", async () => {
    await access(pdfUrl);
    await access(docxUrl);

    const html = await readFile(pageUrl, "utf8");
    assert.match(html, /Researcher-Designated-AI-Direct-Analytical-Work-Contract\.pdf/);
    assert.match(html, /Researcher-Designated-AI-Direct-Analytical-Work-Contract\.docx/);
});

test("governance and researcher pages link to Contract and Governance", async () => {
    const pages = await Promise.all([
        new URL("../research-governance.html", import.meta.url),
        new URL("../staged-analysis.html", import.meta.url)
    ].map((url) => readFile(url, "utf8")));

    for (const html of pages) {
        assert.match(html, /contract-and-governance\.html/);
    }
});
