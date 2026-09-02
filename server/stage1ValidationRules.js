export const STAGE1_VALIDATION_REGISTRY_VERSION =
    "stage1-processing-transparency-v4-exact-first-response";

export const STAGE1_PARTICIPANT_INCLUSION_POLICY = {
    id: "GOV-PART-001",
    title: "No participant transcript may be administratively excluded",
    rule: "No AI output, model judgment, parsing result, validation rule, numbering issue, relationship error, persistence failure, database state, or worker failure has authority to disqualify a participant, exclude a transcript, classify it as unusable, or permanently render it non-processible.",
    readinessBoundary: "Human rights and the participant's right to be heard take precedence over analytical and administrative convenience. Formal interview completion controls readiness for complete-case analysis; it does not determine whether a participant or transcript is legitimate. Incomplete sessions remain retained and reviewable as not ready yet, every transcript remains processible or reprocessable, and unresolved system failures must remain visible and escalatable to researchers or system experts.",
    authority: "researcher_directive",
    directedAt: "2026-09-01",
    enforcement: "researcher_governance_and_dashboard_runtime",
    responsibility: "system",
    participantConsequence: "none"
};

function rule({
    id,
    title,
    text,
    layer,
    object,
    origin,
    introduced,
    changed = null,
    effect,
    rationale,
    modelAssociation = "Model-independent; applies after any compatible Stage-1 generator model.",
    status = "active",
    authority = "system_derived_researcher_review_required",
    decisionRecord = null,
    responsibility = "system"
}) {
    return {
        id,
        title,
        rule: text,
        stage: "Stage 1",
        layer,
        object,
        origin,
        introduced,
        changed,
        status,
        authority,
        decisionRecord: decisionRecord || (
            authority === "researcher_directive"
                ? "Researcher directive recorded on 2026-09-01; this is not a claim of independent ethics-board approval."
                : authority === "withdrawn_system_derived"
                ? "Introduced through repository implementation with no recorded researcher approval; withdrawn by researcher directive GOV-PART-001."
                : "No researcher approval record was found. The rule became operative through repository code or a database migration."
        ),
        modelAssociation,
        failureEffect: effect,
        rationale,
        responsibility,
        participantConsequence: "None. The system bears the failure; it must not exclude the participant or transcript or render either non-processible."
    };
}

const ADVANCED_SOURCE = "server/advancedPreliminaryAnalysis.js";
const TRANSCRIPT_SOURCE = "server/stagedTranscript.js";
const DASHBOARD_SOURCE = "server/advancedPreliminaryDashboard.js";
const INITIAL_MIGRATION =
    "supabase/migrations/20260831235500_add_advanced_preliminary_analysis.sql";
const COMPLETE_MIGRATION =
    "supabase/migrations/20260901122121_complete_preliminary_case_reports.sql";
const OVERLAP_MIGRATION =
    "supabase/migrations/20260901010000_allow_overlapping_preliminary_categories.sql";
const CONTRACT_MIGRATION =
    "supabase/migrations/20260901160500_restore_researcher_execution_contract.sql";
const DURABLE_MIGRATION =
    "supabase/migrations/20260901223500_make_stage1_responses_durable.sql";
const STALE_MIGRATION =
    "supabase/migrations/20260902004107_handle_stale_stage1_responses.sql";
const NON_EXCLUSION_MIGRATION =
    "supabase/migrations/20260902013000_prohibit_participant_transcript_exclusion.sql";
const VALIDATOR_WITHDRAWAL_MIGRATION =
    "supabase/migrations/20260902020000_withdraw_stage1_validator.sql";
const NON_BLOCKING_PROJECTION_MIGRATION =
    "supabase/migrations/20260902140632_make_stage1_projection_non_blocking.sql";
const EXACT_OUTPUT_MIGRATION =
    "supabase/migrations/20260902150000_remove_stage1_gatekeepers.sql";

const STAGE1_RULE_HISTORY = [
    rule({
        id: "READY-001", title: "Formal completion is a readiness gate, not a participant judgment",
        text: "The complete-case Stage-1 queue waits until completed is true and completed_at is present. This waiting state does not disqualify the participant, exclude the transcript, or authorize an AI or system to decide that the contribution is unusable.",
        layer: "source readiness", object: "interview session",
        origin: `${CONTRACT_MIGRATION}:96-105 and ${ADVANCED_SOURCE}:554-587`,
        introduced: "2026-09-01 · commit 4ce0761",
        effect: "An incomplete session waits outside the complete-case queue as not ready yet; the transcript remains retained and processible later.",
        rationale: "Keep readiness for complete-case analysis separate from participant or transcript legitimacy.",
        authority: "researcher_directive"
    }),
    rule({
        id: "GOV-NOVAL-001", title: "Stage 1 has no analytical validator",
        text: "The exact first provider response is the authoritative Stage 1 output. No Meaning Unit, Code, Category, Theme, relationship, count, case summary, parser, normalizer, projection, scorer, reviewer, repairer, or retry mechanism accepts, rejects, cleans, or replaces it.",
        layer: "researcher governance", object: "model output and participant case",
        origin: `${ADVANCED_SOURCE}, ${VALIDATOR_WITHDRAWAL_MIGRATION}, ${NON_BLOCKING_PROJECTION_MIGRATION}, and ${EXACT_OUTPUT_MIGRATION}`,
        introduced: "2026-09-01 · researcher directive",
        changed: `2026-09-02 · relational projection, model probe, stale-response cancellation, and automatic retry removed by ${EXACT_OUTPUT_MIGRATION}`,
        effect: "The exact first response is retained and displayed without an analytical gate. Provider or system failure remains visible and belongs to the system, never the participant.",
        rationale: "Analytical judgment belongs to the researcher; software problems belong to the system.",
        authority: "researcher_directive",
        modelAssociation: "Model-independent researcher directive; no current or future Stage-1 model is governed by an analytical validator."
    }),
    rule({
        id: "SRC-001", title: "The claimed session is rechecked for formal completion",
        text: "Before a model response is used, the worker requires a source session with completed=true and a non-null completed_at.",
        layer: "application source gate", object: "interview session",
        origin: `${ADVANCED_SOURCE}:554-577`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report blocked and recorded as a system/source-state failure.",
        rationale: "Prevent analysis of a session that is not formally complete."
    }),
    rule({
        id: "SRC-002", title: "Original transcript must load",
        text: "A transcript-query error blocks Stage 1 for that job.",
        layer: "application source gate", object: "transcript",
        origin: `${ADVANCED_SOURCE}:562-580`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report blocked; participant/session remains included.",
        rationale: "A report cannot be grounded without its preserved transcript."
    }),
    rule({
        id: "SRC-003", title: "Only participant/user rows are analysis evidence",
        text: "Prepared evidence includes only rows whose Speaker normalizes to user or participant.",
        layer: "application transformation", object: "transcript message",
        origin: `${TRANSCRIPT_SOURCE}:40-66`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Other speaker rows are omitted from the model evidence set.",
        rationale: "Separate participant evidence from interviewer text."
    }),
    rule({
        id: "SRC-004", title: "Participant rows require an ID and nonblank message",
        text: "Rows without a message ID or nonblank original Message are skipped.",
        layer: "application transformation", object: "transcript message",
        origin: `${TRANSCRIPT_SOURCE}:40-66`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Row omitted from prepared model evidence; if no prepared rows remain, the whole report is blocked while the transcript remains included.",
        rationale: "Evidence must be addressable and contain source text."
    }),
    rule({
        id: "SRC-005", title: "At least one prepared participant message is required",
        text: "A formally completed transcript with zero prepared participant messages cannot proceed to generation.",
        layer: "application source gate", object: "transcript",
        origin: `${ADVANCED_SOURCE}:584-588`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report blocked as a system/source-data issue.",
        rationale: "The model requires participant evidence."
    }),
    rule({
        id: "RESP-001", title: "Provider response status must be completed",
        text: "Queued or in-progress responses are polled; any terminal status other than completed is not accepted as a report.",
        layer: "provider response gate", object: "model response",
        origin: `${ADVANCED_SOURCE}:668-704`, introduced: "2026-09-01 · commit 560b392",
        changed: "2026-09-01 · commit fba2f31 added stale-response recovery",
        effect: "Whole report blocked or left in progress.",
        rationale: "Do not treat incomplete provider work as final output.",
        modelAssociation: "Applies to the exact provider/model recorded on the Stage-1 run."
    }),
    rule({
        id: "RESP-002", title: "Response text must be nonblank",
        text: "No nonblank output_text or output content text means the response is empty.",
        layer: "response parser", object: "model response",
        origin: `${ADVANCED_SOURCE}:117-130`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report rejected.", rationale: "There is no report to validate."
    }),
    rule({
        id: "RESP-003", title: "Response text must parse as JSON",
        text: "JSON.parse must succeed.", layer: "response parser", object: "model response",
        origin: `${ADVANCED_SOURCE}:128-136`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report rejected.", rationale: "The persistence contract requires structured data."
    }),
    rule({
        id: "SCHEMA-001", title: "Top-level Stage-1 shape is fixed",
        text: "The response must contain meaning_units, codes, categories, tentative_themes, and case_summary with the declared array/string types.",
        layer: "strict provider JSON schema", object: "complete report",
        origin: `${ADVANCED_SOURCE}:23-104`, introduced: "2026-08-31 · commit 97ec3a5",
        changed: "2026-09-01 · commit 10f99d6 added Codes, Categories, Themes, and summary",
        effect: "The provider cannot return a conforming completed report when the shape is wrong.",
        rationale: "Provide a predictable one-pass report contract.",
        modelAssociation: "Sent to the selected generator model as strict JSON Schema."
    }),
    rule({
        id: "SCHEMA-002", title: "Meaning Unit schema is exact",
        text: "Each Meaning Unit requires string message_id, string exact_source_text, integer occurrence_index, and string context_note; extra properties are prohibited.",
        layer: "strict provider JSON schema", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:26-43`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Nonconforming provider output cannot complete under the schema.",
        rationale: "Require source-addressable evidence.",
        modelAssociation: "Sent to the selected generator model as strict JSON Schema."
    }),
    rule({
        id: "SCHEMA-003", title: "Code schema is exact",
        text: "Each Code requires label, definition, rationale, and an integer meaning_unit_numbers array; extra properties are prohibited.",
        layer: "strict provider JSON schema", object: "Code",
        origin: `${ADVANCED_SOURCE}:45-62`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Nonconforming provider output cannot complete under the schema.",
        rationale: "Require explicit Code-to-evidence traceability.",
        modelAssociation: "Sent to the selected generator model as strict JSON Schema."
    }),
    rule({
        id: "SCHEMA-004", title: "Category schema is exact",
        text: "Each Category requires label, definition, rationale, and an integer code_numbers array; extra properties are prohibited.",
        layer: "strict provider JSON schema", object: "Category",
        origin: `${ADVANCED_SOURCE}:64-79`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Nonconforming provider output cannot complete under the schema.",
        rationale: "Require explicit Category-to-Code traceability.",
        modelAssociation: "Sent to the selected generator model as strict JSON Schema."
    }),
    rule({
        id: "SCHEMA-005", title: "Tentative Theme schema is exact",
        text: "Each Tentative Theme requires label, rationale, and an integer category_numbers array; extra properties are prohibited.",
        layer: "strict provider JSON schema", object: "Tentative Theme",
        origin: `${ADVANCED_SOURCE}:81-95`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Nonconforming provider output cannot complete under the schema.",
        rationale: "Require explicit Theme-to-Category traceability.",
        modelAssociation: "Sent to the selected generator model as strict JSON Schema."
    }),
    rule({
        id: "MU-001", title: "Meaning Unit message must belong to the prepared session evidence",
        text: "The trimmed message_id must resolve in the prepared participant-message map.",
        layer: "application validator", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:162-186`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Meaning Unit rejected and current implementation rejects the whole report.",
        rationale: "Prevent evidence from another or unknown message."
    }),
    rule({
        id: "MU-002", title: "Meaning Unit text must occur in the original message",
        text: "After trimming, exact_source_text is located case-insensitively within that message's originalText; the stored slice comes from the original transcript.",
        layer: "application validator", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:138-186`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Meaning Unit rejected and current implementation rejects the whole report.",
        rationale: "Prevent rewritten or invented evidence."
    }),
    rule({
        id: "MU-003", title: "Requested repeated occurrence must exist",
        text: "The selected occurrence_index must address an actual case-insensitive occurrence. A nonpositive or non-integer value is silently normalized to 1.",
        layer: "application validator and normalization", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:175-186`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Missing occurrence rejects the MU; invalid occurrence input is silently changed to 1.",
        rationale: "Address repeated phrases while exposing the current silent fallback."
    }),
    rule({
        id: "MU-004", title: "Exact courtesy-only spans are rejected",
        text: "After Unicode normalization, lowercasing, punctuation removal, and whitespace collapse, a whole span equal to a fixed multilingual courtesy phrase is rejected.",
        layer: "application validator", object: "Meaning Unit",
        origin: `${TRANSCRIPT_SOURCE}:1-38 and ${ADVANCED_SOURCE}:182-186`,
        introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Meaning Unit rejected and current implementation rejects the whole report.",
        rationale: "Exclude greeting/thanks/farewell-only spans from substantive evidence."
    }),
    rule({
        id: "MU-005", title: "Exact duplicate spans are rejected",
        text: "The same message/start/end span cannot appear twice in one output.",
        layer: "application validator", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:189-193`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Later duplicate MU rejected and current implementation rejects the whole report.",
        rationale: "Avoid duplicate evidence records."
    }),
    rule({
        id: "MU-006", title: "Overlapping spans in one message are rejected",
        text: "A proposed MU cannot intersect the offsets of an earlier accepted MU in the same message.",
        layer: "application validator", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:194-204`, introduced: "2026-08-31 · commit 6239f8a",
        effect: "Later overlapping MU rejected and current implementation rejects the whole report.",
        rationale: "Force non-overlapping segmentation. This is an analytical policy requiring researcher review."
    }),
    rule({
        id: "MU-007", title: "Blank context note is silently replaced",
        text: "A blank context_note becomes 'Exact case-grounded meaning unit.' rather than causing rejection.",
        layer: "application normalization", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:206-215`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Field transformed; report is not rejected for this reason.",
        rationale: "Supply a display fallback while disclosing the transformation."
    }),
    rule({
        id: "REF-001", title: "Relationship numbers are range-filtered",
        text: "MU, Code, and Category references survive only when they are integers greater than zero and no greater than the current accepted parent-array length.",
        layer: "application validator and normalization", object: "relationship reference",
        origin: `${ADVANCED_SOURCE}:218-272`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Invalid references are removed; an item is rejected only when no valid reference remains.",
        rationale: "Prevent links to nonexistent positional parents."
    }),
    rule({
        id: "REF-002", title: "Duplicate relationship numbers are silently deduplicated",
        text: "Repeated references are collapsed with a Set.",
        layer: "application normalization", object: "relationship reference",
        origin: `${ADVANCED_SOURCE}:218-222`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "References transformed; no rejection if at least one valid link remains.",
        rationale: "Avoid duplicate link rows while disclosing the transformation."
    }),
    rule({
        id: "REF-003", title: "Mixed valid and invalid references are partially accepted",
        text: "When a relationship array contains at least one valid number, out-of-range or invalid numbers are silently removed and the item remains accepted.",
        layer: "application normalization", object: "relationship reference",
        origin: `${ADVANCED_SOURCE}:218-272`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Partial transformation rather than whole-item rejection.",
        rationale: "Current implementation behavior; presented for researcher judgment."
    }),
    rule({
        id: "CO-001", title: "Code needs text and at least one valid MU link",
        text: "A Code requires nonblank label, definition, rationale, and at least one surviving Meaning Unit number.",
        layer: "application validator", object: "Code",
        origin: `${ADVANCED_SOURCE}:223-239`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Code rejected and current implementation rejects the whole report.",
        rationale: "Define a minimally documented evidence-linked Code."
    }),
    rule({
        id: "CA-001", title: "Category needs text and at least one valid Code link",
        text: "A Category requires nonblank label, definition, rationale, and at least one surviving Code number.",
        layer: "application validator", object: "Category",
        origin: `${ADVANCED_SOURCE}:241-255`, introduced: "2026-09-01 · commit 10f99d6",
        changed: "2026-09-01 migration lowered the database minimum from two Codes to one",
        effect: "Category rejected and current implementation rejects the whole report.",
        rationale: "Define a minimally documented Code-linked Category."
    }),
    rule({
        id: "TH-001", title: "Theme needs text and at least one valid Category link",
        text: "A Tentative Theme requires nonblank label, rationale, and at least one surviving Category number.",
        layer: "application validator", object: "Tentative Theme",
        origin: `${ADVANCED_SOURCE}:257-273`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Theme rejected and current implementation rejects the whole report.",
        rationale: "Define a minimally documented Category-linked Theme."
    }),
    rule({
        id: "COMP-001", title: "At least one accepted Meaning Unit is required",
        text: "The report cannot be complete when the accepted Meaning Unit array is empty.",
        layer: "application completion policy", object: "complete report",
        origin: `${ADVANCED_SOURCE}:285-300`, introduced: "2026-09-01 · current formula in commit 10f99d6",
        effect: "Whole report rejected.", rationale: "System-derived minimum; researcher review required."
    }),
    rule({
        id: "COMP-002", title: "At least one accepted Code is required",
        text: "The report cannot be complete when the accepted Code array is empty.",
        layer: "application completion policy", object: "complete report",
        origin: `${ADVANCED_SOURCE}:285-300`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Whole report rejected.", rationale: "System-derived analytical minimum; researcher review required."
    }),
    rule({
        id: "COMP-003", title: "Case summary must be nonblank",
        text: "After trimming, case_summary must contain text.",
        layer: "application completion policy", object: "complete report",
        origin: `${ADVANCED_SOURCE}:285-300`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Whole report rejected.", rationale: "System-derived analytical minimum; researcher review required."
    }),
    rule({
        id: "COMP-004", title: "Any invalid item rejects the whole report",
        text: "Any MU, Code, Category, or Theme invalidReasons entry makes complete=false; the worker throws instead of storing a partial report.",
        layer: "application completion policy", object: "complete report",
        origin: `${ADVANCED_SOURCE}:285-300 and 367-376`,
        introduced: "2026-09-01 · current exception in commit 560b392",
        effect: "Whole report rejected; participant/session must remain included.",
        rationale: "Atomic integrity choice; this is not a participant qualification rule and requires researcher review."
    }),
    rule({
        id: "COMP-005", title: "Categories and Themes may be empty",
        text: "Completion requires Meaning Units, Codes, and summary, but not a Category or Tentative Theme.",
        layer: "application completion policy", object: "complete report",
        origin: `${ADVANCED_SOURCE}:275-300`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "No rejection solely because either higher layer is empty.",
        rationale: "Permit unsynthesized lower-level findings."
    }),
    rule({
        id: "COMP-006", title: "Unassigned Codes and Categories are accepted and recorded",
        text: "Codes not linked to Categories and Categories not linked to Themes are stored as unassigned positional numbers.",
        layer: "application completion policy", object: "hierarchy coverage",
        origin: `${ADVANCED_SOURCE}:275-300`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "No rejection; the gap remains visible in report provenance.",
        rationale: "Avoid inventing unsupported higher-level synthesis."
    }),
    rule({
        id: "NUM-001", title: "MU, CO, CA, and TH numbers are positional",
        text: "Numbers are assigned from one-based array order; they are not supplied as stable semantic identifiers by the model.",
        layer: "application/database transformation", object: "all hierarchy objects",
        origin: `${COMPLETE_MIGRATION}:227-304`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Stored position is determined by array ordinality.",
        rationale: "Create deterministic local display positions, not participant qualification."
    }),
    rule({
        id: "NUM-002", title: "Invalid-item removal changes later reference ranges",
        text: "MUs are filtered before Codes, Codes before Categories, and Categories before Themes. Later references are checked against shortened accepted arrays.",
        layer: "application validation order", object: "hierarchy numbering",
        origin: `${ADVANCED_SOURCE}:162-273`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "A child failure can be secondary to an earlier rejected parent; whole report is currently rejected.",
        rationale: "Current cascade behavior is disclosed as a system responsibility and researcher-review issue."
    }),
    rule({
        id: "DB-001", title: "Persistence requires a processing job",
        text: "The completion database function refuses a missing job or a job whose status is not processing.",
        layer: "database function", object: "analysis job",
        origin: `${COMPLETE_MIGRATION}:195-203`, introduced: "2026-08-31 · commit 97ec3a5",
        changed: "2026-09-01 · completion function replaced in commit 10f99d6",
        effect: "Whole report transaction rejected.",
        rationale: "Prevent late, duplicate, cancelled, or unclaimed output from being committed."
    }),
    rule({
        id: "DB-002", title: "One report per job and per run/session",
        text: "The case-report table enforces unique job_id and unique run_id/session_id.",
        layer: "database uniqueness constraint", object: "case report",
        origin: `${INITIAL_MIGRATION}:93-121`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Duplicate report transaction rejected.",
        rationale: "Prevent duplicate accepted reports for one job/version."
    }),
    rule({
        id: "DB-003", title: "Report lineage and required metadata must resolve",
        text: "Required report fields are NOT NULL and run, job, session, project/framework/source references must satisfy their foreign keys when present.",
        layer: "database NOT NULL and foreign-key constraints", object: "case report",
        origin: `${INITIAL_MIGRATION}:93-121`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report transaction rejected.",
        rationale: "Preserve report identity and lineage."
    }),
    rule({
        id: "DB-004", title: "Stored Meaning Unit constraints",
        text: "MU number must be positive and unique per report; message must exist; text and offsets are required; start>=0; end>start; occurrence>0; identical report/message/start/end spans are unique.",
        layer: "database constraints", object: "Meaning Unit",
        origin: `${INITIAL_MIGRATION}:138-153`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report transaction rejected.",
        rationale: "Protect addressable source-span records."
    }),
    rule({
        id: "DB-005", title: "Stored Code constraints",
        text: "Code number must be positive and unique per report; label, definition, rationale are required; recorded MU and occurrence counts must be greater than zero.",
        layer: "database constraints", object: "Code",
        origin: `${INITIAL_MIGRATION}:161-173`, introduced: "2026-08-31 · commit 97ec3a5",
        effect: "Whole report transaction rejected.", rationale: "Protect minimally complete Code records."
    }),
    rule({
        id: "DB-006", title: "Relationship link rows require existing parents and are unique",
        text: "Code-MU, Category-Code, and Theme-Category links use foreign keys and composite primary keys to prevent missing or duplicate linked IDs.",
        layer: "database constraints", object: "relationship link",
        origin: `${INITIAL_MIGRATION}:175-190,205-218 and ${COMPLETE_MIGRATION}:37-49`,
        introduced: "2026-08-31 · commit 97ec3a5",
        changed: "2026-09-01 · commit 10f99d6 added Theme links",
        effect: "Whole report transaction rejected.", rationale: "Protect stored link identity."
    }),
    rule({
        id: "DB-007", title: "Stored Category requires at least one recorded Code",
        text: "category_number is positive and unique; text fields are required; code_count must be at least one.",
        layer: "database constraints", object: "Category",
        origin: `${INITIAL_MIGRATION}:192-203 and ${COMPLETE_MIGRATION}:15-20`,
        introduced: "2026-08-31 · initial minimum two",
        changed: "2026-09-01 · commit 10f99d6 lowered minimum to one",
        effect: "Whole report transaction rejected.",
        rationale: "System-derived analytical minimum; researcher review required."
    }),
    rule({
        id: "DB-008", title: "A Code may support multiple Categories",
        text: "The former unique report_id/code_id constraint was removed; Category-Code links are many-to-many.",
        layer: "database relationship policy", object: "Category-Code link",
        origin: `${OVERLAP_MIGRATION}:1-8`, introduced: "2026-08-31 · commit 9fc5d18",
        effect: "No rejection for cross-Category reuse of one Code.",
        rationale: "Permit overlapping analytically justified categories."
    }),
    rule({
        id: "DB-009", title: "Stored Theme requires at least one recorded Category",
        text: "Theme number is positive and unique; label and rationale are nonblank; category_count must be at least one.",
        layer: "database constraints", object: "Tentative Theme",
        origin: `${COMPLETE_MIGRATION}:25-35`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "Whole report transaction rejected.",
        rationale: "System-derived analytical minimum; researcher review required."
    }),
    rule({
        id: "DB-010", title: "Report persistence is atomic",
        text: "Report, hierarchy objects, links, and job completion are written by one database function; any error aborts the function invocation.",
        layer: "database transaction", object: "complete report",
        origin: `${COMPLETE_MIGRATION}:172-313`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "No partial report is accepted.",
        rationale: "Avoid a stored hierarchy that appears complete after a partial write."
    }),
    rule({
        id: "DB-011", title: "Database prohibits participant or transcript exclusion dispositions",
        text: "The only permitted current job disposition is active. The former disposition-setting function always raises a GOV-PART-001 error, and any historical non-active value is restored to an included pending or completed state.",
        layer: "database governance constraint", object: "participant transcript and analysis job",
        origin: `${NON_EXCLUSION_MIGRATION}:1-91`, introduced: "2026-09-01 · researcher directive GOV-PART-001",
        effect: "An attempt to assign an exclusion disposition is rejected; the participant and transcript remain included and processible.",
        rationale: "A computational or administrative result has no authority to disqualify a human contribution.",
        authority: "researcher_directive"
    }),
    rule({
        id: "HIST-001", title: "Former administrative exclusion mechanism is withdrawn and prohibited",
        text: "Earlier migrations permitted the legacy_unusable disposition and converted a case to failed after a researcher-dashboard action. That mechanism is no longer an operative rule.",
        layer: "withdrawn historical database rule", object: "participant transcript and analysis job",
        origin: `supabase/migrations/20260901061000_add_advanced_case_dispositions.sql and supabase/migrations/20260901064000_automate_legacy_source_disposition.sql; withdrawn by ${NON_EXCLUSION_MIGRATION}`,
        introduced: "2026-09-01 · commits 560beb9 and 9d2af74",
        changed: "2026-09-01 · withdrawn and prohibited by researcher directive GOV-PART-001",
        effect: "No current exclusion effect. Prior values are retained only in append-only audit history and restored to active processing states.",
        rationale: "Disclose who and what introduced the former rule without allowing it to govern any participant or transcript.",
        modelAssociation: "Model-independent. The former mechanism was an application/database decision, not a model requirement.",
        status: "withdrawn_prohibited",
        authority: "withdrawn_system_derived"
    }),
    rule({
        id: "OP-001", title: "Only one Stage-1 run may be active",
        text: "Run creation refuses to start while another preliminary run is queued or processing.",
        layer: "database workflow gate", object: "analysis run",
        origin: `${CONTRACT_MIGRATION}:191-199`, introduced: "2026-09-01 · commit 4ce0761",
        effect: "New run blocked.", rationale: "Prevent competing dataset-wide runs."
    }),
    rule({
        id: "OP-002", title: "Researcher-confirmed execution-plan hash must match",
        text: "The start request must repeat the SHA-256 hash of the current preflight plan.",
        layer: "dashboard workflow gate", object: "analysis run",
        origin: `${DASHBOARD_SOURCE}:286-354,687-694`, introduced: "2026-09-01 · commit 4ce0761",
        effect: "Run creation blocked.", rationale: "Prevent execution of a plan different from the one displayed."
    }),
    rule({
        id: "OP-003", title: "Exact provider/model must pass a capability probe",
        text: "The configured provider and exact researcher-entered model must return ready=true under strict structured output and reasoning settings.",
        layer: "dashboard workflow gate", object: "provider/model",
        origin: `${ADVANCED_SOURCE}:396-425 and ${DASHBOARD_SOURCE}:695-713`,
        introduced: "2026-09-01 · commit 4ce0761",
        effect: "Run creation blocked.", rationale: "Do not silently substitute an unavailable model.",
        modelAssociation: "Directly tests the exact provider/model proposed for the run."
    }),
    rule({
        id: "OP-004", title: "Spending guard may stop new case claims",
        text: "When configured incremental spend plus the next-call reserve exceeds the researcher-authorized limit, the run moves to spending_limit_reached.",
        layer: "database workflow gate", object: "analysis run",
        origin: `${DURABLE_MIGRATION}:198-256`, introduced: "2026-09-01 · commits 5ead957 and 560b392",
        effect: "No next model call is made.", rationale: "Respect the researcher-authorized spending ceiling."
    }),
    rule({
        id: "OP-005", title: "A stale provider response is cancelled after 45 minutes",
        text: "A queued/in-progress background response at least 45 minutes old is cancelled, preserved in attempt history, and retried at most once.",
        layer: "provider workflow recovery", object: "model response",
        origin: `${ADVANCED_SOURCE}:467-521 and ${STALE_MIGRATION}:78-178`,
        introduced: "2026-09-01 · commit fba2f31",
        effect: "Report remains unavailable; one retry may be scheduled before terminal system failure.",
        rationale: "Recover stalled provider work without unlimited paid retries."
    }),
    rule({
        id: "OP-006", title: "Non-retryable failures have an inconsistent claim predicate",
        text: "The application records validation/persistence failures with retryable=false and next_retry_at=null, but the current claim query can still select a failed job below three attempts by treating null as negative infinity while the run remains active.",
        layer: "known workflow inconsistency", object: "analysis job",
        origin: `${ADVANCED_SOURCE}:726-727, ${INITIAL_MIGRATION}:614-649, and ${DURABLE_MIGRATION}:259-274`,
        introduced: "2026-08-31 to 2026-09-01 cumulative behavior",
        effect: "A supposedly non-retryable failed case may be retried depending on remaining run state.",
        rationale: "Disclosed defect requiring researcher-visible review and engineering correction.",
        status: "active_known_inconsistency"
    }),
    rule({
        id: "GUIDE-001", title: "Full-transcript coverage is prompt guidance only",
        text: "The prompt requires full coverage, later/low-frequency evidence, and contradictions, but no deterministic coverage calculation enforces it.",
        layer: "prompt-only instruction", object: "complete report",
        origin: `${ADVANCED_SOURCE}:319-336`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "No deterministic rejection for omitted transcript material.",
        rationale: "Disclose the gap between written instruction and enforced validation.",
        modelAssociation: "Instruction supplied to the selected generator model."
    }),
    rule({
        id: "GUIDE-002", title: "Smallest coherent MU boundary is prompt guidance only",
        text: "The prompt asks for the smallest sufficient coherent original-language span. The platform does not validate that judgment; it preserves the output and attempts a source-linked display projection.",
        layer: "prompt-only instruction", object: "Meaning Unit",
        origin: `${ADVANCED_SOURCE}:319-336`, introduced: "2026-09-01 · current prompt v4",
        effect: "No deterministic rejection for a semantically overbroad or underspecified occurring span.",
        rationale: "Disclose unenforced qualitative guidance.",
        modelAssociation: "Instruction supplied to the selected generator model."
    }),
    rule({
        id: "GUIDE-003", title: "English and one-to-three-word Code labels are prompt guidance only",
        text: "The prompt requests English analytical text and normally one-to-three-word Code labels; no local word-count or language validator enforces this.",
        layer: "prompt-only instruction", object: "Code and analytical text",
        origin: `${ADVANCED_SOURCE}:319-336`, introduced: "2026-09-01 · current prompt v4",
        effect: "No deterministic rejection solely for language or label length.",
        rationale: "Disclose unenforced formatting/analytical guidance.",
        modelAssociation: "Instruction supplied to the selected generator model."
    }),
    rule({
        id: "GUIDE-004", title: "Semantic support and research relevance are not independently audited",
        text: "The prompt requires evidence support and project relevance, but the current one-pass path has no second AI judge or deterministic semantic validator.",
        layer: "prompt-only instruction", object: "evidence hierarchy",
        origin: `${ADVANCED_SOURCE}:319-336`, introduced: "2026-09-01 · commits 5086bc3 and 10f99d6",
        effect: "No deterministic semantic rejection. The exact model output is preserved for researcher inspection.",
        rationale: "Disclose that structural validity is not qualitative validity.",
        modelAssociation: "Instruction supplied to the selected generator model; no validation model is used."
    }),
    rule({
        id: "GUIDE-005", title: "Category and Theme coherence is prompt guidance only",
        text: "The prompt describes Categories as broader descriptive groupings and Themes as patterned meaning. No analytical validator accepts or rejects their coherence or positional links.",
        layer: "prompt-only instruction", object: "Category and Tentative Theme",
        origin: `${ADVANCED_SOURCE}:319-336`, introduced: "2026-09-01 · commit 10f99d6",
        effect: "No deterministic rejection for weak conceptual coherence.",
        rationale: "Disclose unenforced qualitative guidance.",
        modelAssociation: "Instruction supplied to the selected generator model."
    })
];

const WITHDRAWN_VALIDATOR_RULE_IDS = new Set([
    "RESP-002", "RESP-003",
    "SCHEMA-001", "SCHEMA-002", "SCHEMA-003", "SCHEMA-004", "SCHEMA-005",
    "MU-001", "MU-002", "MU-003", "MU-004", "MU-005", "MU-006", "MU-007",
    "REF-001", "REF-002", "REF-003", "CO-001", "CA-001", "TH-001",
    "COMP-001", "COMP-002", "COMP-003", "COMP-004",
    "NUM-002", "DB-004", "DB-005", "DB-006", "DB-007", "DB-009",
    "DB-010", "OP-003", "OP-005", "OP-006",
    "GUIDE-001", "GUIDE-002", "GUIDE-003", "GUIDE-004", "GUIDE-005"
]);

export const STAGE1_VALIDATION_RULES = STAGE1_RULE_HISTORY.map(item => {
    if (!WITHDRAWN_VALIDATOR_RULE_IDS.has(item.id)) return item;
    return {
        ...item,
        status: "withdrawn_no_validator",
        authority: "withdrawn_system_derived",
        decisionRecord: "Introduced through repository implementation with no recorded researcher authorization. Withdrawn by the researcher's 2026-09-01 no-validator directive.",
        changed: `2026-09-02 · withdrawn by ${EXACT_OUTPUT_MIGRATION}`,
        failureEffect: `No current rejection effect. Historical effect disclosed for audit: ${item.failureEffect}`,
        participantConsequence: "None. The former rule cannot reject a report, participant, or transcript."
    };
});

export function stage1ValidationRegistrySummary(rules = STAGE1_VALIDATION_RULES) {
    const byLayer = {};
    const wholeReportBlockers = [];
    const withdrawnWholeReportBlockers = [];
    const researcherReviewRequired = [];
    rules.forEach(item => {
        byLayer[item.layer] = (byLayer[item.layer] || 0) + 1;
        if (/whole report|transaction rejected|report rejected/iu.test(item.failureEffect)) {
            if (item.status.startsWith("withdrawn")) {
                withdrawnWholeReportBlockers.push(item.id);
            } else {
                wholeReportBlockers.push(item.id);
            }
        }
        if (item.authority === "system_derived_researcher_review_required") {
            researcherReviewRequired.push(item.id);
        }
    });
    return {
        total: rules.length,
        byLayer,
        wholeReportBlockers,
        withdrawnWholeReportBlockers,
        researcherReviewRequired
    };
}
