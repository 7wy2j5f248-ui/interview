import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    STAGE1_PARTICIPANT_INCLUSION_POLICY,
    STAGE1_VALIDATION_RULES,
    stage1ValidationRegistrySummary
} from "../server/stage1ValidationRules.js";
import { RECENT_PLATFORM_CONTROLS } from "../server/recentPlatformControlInventory.js";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("the Stage 1 registry discloses every rule with provenance and participant protection", () => {
    assert.ok(STAGE1_VALIDATION_RULES.length >= 45);
    assert.equal(
        new Set(STAGE1_VALIDATION_RULES.map(item => item.id)).size,
        STAGE1_VALIDATION_RULES.length
    );
    for (const item of STAGE1_VALIDATION_RULES) {
        for (const field of [
            "id", "title", "rule", "layer", "object", "origin", "introduced",
            "failureEffect", "rationale", "modelAssociation", "status", "authority",
            "decisionRecord", "responsibility", "participantConsequence"
        ]) {
            assert.ok(String(item[field] || "").trim(), `${item.id} is missing ${field}`);
        }
        assert.ok(Object.hasOwn(item, "changed"));
        assert.match(item.participantConsequence, /none|must not exclude/i);
        assert.equal(item.responsibility, "system");
    }
    assert.match(STAGE1_PARTICIPANT_INCLUSION_POLICY.rule, /No AI output/);
    assert.match(STAGE1_PARTICIPANT_INCLUSION_POLICY.rule, /non-processible/);
    assert.match(STAGE1_PARTICIPANT_INCLUSION_POLICY.readinessBoundary, /readiness/);
    assert.match(STAGE1_PARTICIPANT_INCLUSION_POLICY.readinessBoundary, /not ready yet/);

    const summary = stage1ValidationRegistrySummary();
    assert.equal(summary.total, STAGE1_VALIDATION_RULES.length);
    assert.ok(summary.wholeReportBlockers.length > 0);
    assert.ok(summary.withdrawnWholeReportBlockers.length > 0);
    assert.ok(summary.researcherReviewRequired.length > 0);
    assert.ok(STAGE1_VALIDATION_RULES.some(item => item.id === "DB-011"));
    assert.ok(STAGE1_VALIDATION_RULES.some(item =>
        item.id === "HIST-001" && item.status === "withdrawn_prohibited"
    ));
});

test("the dedicated researcher page exposes authority, provenance, models, and failure effects", async () => {
    const [html, script, endpoint] = await Promise.all([
        source("validation-rules.html"),
        source("researcher-validation-rules.js"),
        source("server/stage1ValidationRulesDashboard.js")
    ]);

    assert.match(html, /Stage 1 Processing Transparency/);
    assert.match(html, /Participant protection boundary/);
    assert.match(html, /No current analytical validator/);
    assert.match(html, /Withdrawn system-derived · prohibited/);
    assert.match(html, /Current model and frozen researcher-rule context/);
    assert.match(html, /Recent repository control inventory/);
    assert.match(script, /Failure or transformation effect/);
    assert.match(script, /Who decided \/ approval record/);
    assert.match(script, /Exact implementation source/);
    assert.match(script, /Model association/);
    assert.match(script, /Analytical independence/);
    assert.match(script, /Execution concurrency/);
    assert.match(script, /Current technical capacity/);
    assert.match(endpoint, /authorizeResearcher/);
    assert.match(endpoint, /rules_snapshot/);
    assert.match(endpoint, /resolved_model/);
    assert.match(endpoint, /repository rule registry remains fully disclosed/);
    assert.match(endpoint, /private, no-store/);
    assert.match(endpoint, /recentPlatformControls/);
    assert.match(endpoint, /technical_configurable/);
    assert.match(endpoint, /configuredAdvancedPreliminaryWorkerConcurrency/);
    assert.match(endpoint, /No fixed concurrency ceiling/);
});

test("recent system-derived controls and their authorization boundary are disclosed", async () => {
    const sourceText = await source("server/recentPlatformControlInventory.js");
    assert.equal(RECENT_PLATFORM_CONTROLS.length, 17);
    assert.equal(new Set(RECENT_PLATFORM_CONTROLS.map(item => item.id)).size, 17);
    assert.match(sourceText, /RECENT-006/);
    assert.match(sourceText, /Stronger-model preliminary-analysis pipeline/);
    assert.match(sourceText, /RECENT-010/);
    assert.match(sourceText, /Legacy unusable case disposition/);
    assert.match(sourceText, /RECENT-016/);
    assert.match(sourceText, /Stage-1 execution concurrency/);
    assert.match(sourceText, /explicitly required removal of the system-derived fixed value of eight/);
    assert.match(sourceText, /RECENT-017/);
    assert.match(sourceText, /Remove relational projection as a Stage-1 report gate/);
    assert.match(sourceText, /Git author identity or commit title is not evidence of informed approval/);
    assert.match(sourceText, /No explicit researcher authorization record was found/);
    assert.equal(
        RECENT_PLATFORM_CONTROLS.filter(item =>
            item.classification === "explicit researcher directive").length,
        2
    );
});

test("the Stage 1 validator is withdrawn and every model output is preserved", async () => {
    const [worker, migration, nonBlockingProjection] = await Promise.all([
        source("server/advancedPreliminaryAnalysis.js"),
        source("supabase/migrations/20260902020000_withdraw_stage1_validator.sql"),
        source("supabase/migrations/20260902140632_make_stage1_projection_non_blocking.sql")
    ]);

    assert.doesNotMatch(worker, /validateAdvancedPreliminaryAnalysis/);
    assert.doesNotMatch(worker, /invalidReasons/);
    assert.doesNotMatch(worker, /const analysisSchema/);
    assert.match(worker, /rawModelOutputText/);
    assert.match(worker, /none_no_analytical_validator/);
    assert.match(worker, /save_advanced_preliminary_model_output/);
    assert.match(migration, /GOV-PART-002/);
    assert.match(migration, /raw_model_output_text/);
    assert.match(migration, /system_processing_notes/);
    assert.match(migration, /drop constraint if exists advanced_preliminary_codes_meaning_unit_count_check/);
    assert.match(migration, /non-rejecting/);
    assert.match(nonBlockingProjection, /exception when others/);
    assert.match(nonBlockingProjection, /RELATIONAL_PROJECTION_STORAGE_UNAVAILABLE/);
    assert.match(nonBlockingProjection, /status = 'completed'/);
    assert.match(nonBlockingProjection, /case remains completed/);
    assert.doesNotMatch(nonBlockingProjection, /delete from public\./i);
    assert.doesNotMatch(nonBlockingProjection, /update public\.interview_(sessions|messages)/i);
});

test("the exclusion path is removed and the database migration restores processibility", async () => {
    const [html, script, dashboard, endpoint, migration] = await Promise.all([
        source("staged-analysis.html"),
        source("researcher-advanced-preliminary.js"),
        source("server/advancedPreliminaryDashboard.js"),
        source("api/automatic-analysis.js"),
        source("supabase/migrations/20260902013000_prohibit_participant_transcript_exclusion.sql")
    ]);

    for (const runtimeSource of [html, script, dashboard, endpoint]) {
        assert.doesNotMatch(runtimeSource, /mark-legacy/);
        assert.doesNotMatch(runtimeSource, /Move to Legacy cases/);
        assert.doesNotMatch(runtimeSource, /Legacy unusable/);
    }
    assert.match(script, /Inspect transcript/);
    assert.match(script, /participant and transcript remain included and processible/);
    assert.match(migration, /GOV-PART-001/);
    assert.match(migration, /disposition_history/);
    assert.match(migration, /disposition = 'active'/);
    assert.match(migration, /status = case when exists/);
    assert.match(migration, /Participant or transcript exclusion is prohibited/);
    assert.match(migration, /uuid, text, text, text\n\) to service_role/);
    assert.match(migration, /insert into public\.global_analysis_rules/);
    assert.doesNotMatch(migration, /delete\s+from/iu);
});

test("a preserved validator failure returns to Stage 1 without another model call", async () => {
    const migration = await source(
        "supabase/migrations/20260902034000_requeue_preserved_validation_failure.sql"
    );
    assert.match(migration, /status = 'pending'/);
    assert.match(migration, /provider_response_status = 'completed'/);
    assert.match(migration, /provider_response_id is not null/);
    assert.match(migration, /not exists/);
    assert.doesNotMatch(migration, /provider_response_id = null/);
    assert.doesNotMatch(migration, /delete from public\./i);
});
