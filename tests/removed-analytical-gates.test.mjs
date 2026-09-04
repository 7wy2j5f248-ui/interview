import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("legacy analytical reviewers and platform AI decisions are unreachable", async () => {
    const [reviewApi, analysisApi, automaticApi, loader, html] =
        await Promise.all([
            readFile(new URL("../api/automatic-analysis-review.js", import.meta.url), "utf8"),
            readFile(new URL("../api/analysis.js", import.meta.url), "utf8"),
            readFile(new URL("../api/automatic-analysis.js", import.meta.url), "utf8"),
            readFile(new URL("../researcher-automatic-analysis.js", import.meta.url), "utf8"),
            readFile(new URL("../researcher.html", import.meta.url), "utf8")
        ]);

    assert.match(reviewApi, /status\(410\)/);
    assert.doesNotMatch(reviewApi, /scheduleAutomaticCaseAnalysis/);
    assert.match(analysisApi, /REMOVED_PLATFORM_ANALYSIS_ACTIONS/);
    assert.match(analysisApi, /status\(410\)/);
    assert.doesNotMatch(analysisApi, /broad one- or two-word concept/);
    assert.doesNotMatch(automaticApi, /"stage2a-preflight", "stage2a-start"/);
    assert.doesNotMatch(loader, /researcher-automatic-review\.js/);
    assert.doesNotMatch(html, /id="automaticAnalysisReview"/);
});
