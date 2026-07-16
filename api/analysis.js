import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    buildAnalysisBatches,
    collectEvidenceForBatch,
    commaSeparatedList,
    DEFAULT_ANALYSIS_BATCH_SIZE,
    generateSuggestionsForBatch,
    prepareParticipantMessages,
    QUALITATIVE_ANALYSIS_MODEL,
    QUALITATIVE_ANALYSIS_VERSION,
    workingAnalysisFields
} from "../server/analysisCore.js";
import { calculateItemStatistics } from "../server/analysisStatistics.js";
import { filterCorpusRows, normalizeCorpusPeriod } from "../server/corpus.js";
import { authorizeResearcher } from "../server/researcherAuth.js";

const AI_ACTIONS = new Set(["generate", "collect_evidence"]);
const KNOWN_ACTIONS = new Set([
    "list",
    "confirmed",
    "generate",
    "save_feedback",
    "create_item",
    "collect_evidence",
    "set_evidence",
    "confirm",
    "archive",
    "reopen"
]);
const ANALYSIS_TABLES = Object.freeze({
    runs: "qualitative_analysis_runs",
    runMessages: "qualitative_analysis_run_messages",
    items: "qualitative_analysis_items",
    evidence: "qualitative_analysis_evidence"
});

class AnalysisError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function safeId(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new AnalysisError(400, `${label} is required.`);
    }

    return value.trim();
}

function analysisPeriod(start, end) {
    try {
        return normalizeCorpusPeriod(start, end);
    } catch (error) {
        throw new AnalysisError(400, error.message);
    }
}

function operationalStatus(error) {
    return Number.isInteger(error?.status) ? error.status : 500;
}

function safeActionName(req) {
    const value = req.body?.action || req.query?.action || "list";
    return KNOWN_ACTIONS.has(value) ? value : "unknown";
}

function logOperationalFailure(stage, details, error) {
    console.error("Qualitative analysis operation failed:", {
        stage,
        ...details,
        status: operationalStatus(error)
    });
}

async function loadAllInterviewMessages(supabaseClient, pageSize = 1000) {
    const rows = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Participant, Session, Language, Speaker, Message, Timestamp, EnglishTranslation")
            .order("id", { ascending: true })
            .range(from, from + pageSize - 1);

        if (error) {
            throw new AnalysisError(500, "The analysis corpus could not be loaded.");
        }

        const page = data || [];
        rows.push(...page);

        if (page.length < pageSize) {
            return rows;
        }

        from += pageSize;
    }
}

async function loadMessagesByIds(supabaseClient, messageIds) {
    const uniqueIds = [...new Set(messageIds)];
    const messages = [];

    for (let index = 0; index < uniqueIds.length; index += 100) {
        const chunk = uniqueIds.slice(index, index + 100);

        if (!chunk.length) {
            continue;
        }

        const { data, error } = await supabaseClient
            .from("interview_messages")
            .select("id, Participant, Session, Language, Speaker, Message, Timestamp, EnglishTranslation")
            .in("id", chunk);

        if (error) {
            throw new AnalysisError(500, "Analysis evidence messages could not be loaded.");
        }

        messages.push(...(data || []));
    }

    return messages;
}

async function loadRun(supabaseClient, runId) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .select("*")
        .eq("id", runId)
        .maybeSingle();

    if (error || !data) {
        throw new AnalysisError(404, "Analysis run was not found.");
    }

    return data;
}

async function loadItem(supabaseClient, itemId) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .select("*")
        .eq("id", itemId)
        .maybeSingle();

    if (error || !data) {
        throw new AnalysisError(404, "Analysis item was not found.");
    }

    return data;
}

async function runMessages(supabaseClient, runId) {
    const { data: links, error } = await supabaseClient
        .from(ANALYSIS_TABLES.runMessages)
        .select("message_id, batch_number")
        .eq("analysis_run_id", runId)
        .order("batch_number", { ascending: true });

    if (error) {
        throw new AnalysisError(500, "The stored analysis corpus could not be loaded.");
    }

    const messages = await loadMessagesByIds(
        supabaseClient,
        (links || []).map(link => link.message_id)
    );
    const messageById = new Map(messages.map(message => [message.id, message]));

    return (links || [])
        .map(link => ({
            ...messageById.get(link.message_id),
            batchNumber: link.batch_number
        }))
        .filter(message => message.id);
}

function periodMatches(run, period) {
    const runStart = run.period_start
        ? new Date(run.period_start).toISOString()
        : null;
    const runEnd = run.period_end
        ? new Date(run.period_end).toISOString()
        : null;

    return runStart === period.start && runEnd === period.end;
}

async function loadRunsForPeriod(supabaseClient, period) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

    if (error) {
        throw new AnalysisError(500, "Stored analysis runs could not be loaded.");
    }

    return (data || []).filter(run => periodMatches(run, period));
}

function evidenceMessage(message, link) {
    return {
        evidenceId: link.id,
        messageId: message.id,
        session: message.Session || null,
        participant: message.Participant || null,
        language: message.Language || null,
        timestamp: message.Timestamp || null,
        originalText: message.Message,
        englishTranslation: message.EnglishTranslation || null,
        source: link.source,
        round: link.evidence_round,
        included: link.included === true,
        codes: Array.isArray(link.code_attributions)
            ? link.code_attributions
            : []
    };
}

function validatedAttributionCodes(value, item) {
    const requested = commaSeparatedList(value);
    const allowed = workingAnalysisFields(item).codes;
    const allowedByKey = new Map(
        allowed.map(code => [code.toLowerCase(), code])
    );
    const validated = requested
        .map(code => allowedByKey.get(code.toLowerCase()))
        .filter(Boolean);

    if (validated.length !== requested.length) {
        throw new AnalysisError(
            400,
            "Evidence can be attributed only to current working codes."
        );
    }

    return validated;
}

async function loadWorkspace(supabaseClient, period, requestedRunId = null) {
    const runs = await loadRunsForPeriod(supabaseClient, period);
    const run = requestedRunId
        ? runs.find(item => item.id === requestedRunId)
        : runs[0];

    if (!run) {
        return { period, runs, run: null, items: [], corpusMessages: [] };
    }

    const [{ data: items, error: itemError }, corpusRows] = await Promise.all([
        supabaseClient
            .from(ANALYSIS_TABLES.items)
            .select("*")
            .eq("analysis_run_id", run.id)
            .order("created_at", { ascending: true }),
        runMessages(supabaseClient, run.id)
    ]);

    if (itemError) {
        throw new AnalysisError(500, "Stored analysis items could not be loaded.");
    }

    const itemIds = (items || []).map(item => item.id);
    let evidence = [];

    if (itemIds.length) {
        const evidenceResult = await supabaseClient
            .from(ANALYSIS_TABLES.evidence)
            .select("*")
            .in("analysis_item_id", itemIds)
            .order("created_at", { ascending: true });

        if (evidenceResult.error) {
            throw new AnalysisError(500, "Stored analysis evidence could not be loaded.");
        }

        evidence = evidenceResult.data || [];
    }

    const corpusById = new Map(corpusRows.map(message => [message.id, message]));
    const itemPayloads = (items || []).map(item => {
        const itemEvidence = evidence.filter(
            link => link.analysis_item_id === item.id
        );

        return {
            ...item,
            descriptiveStatistics: calculateItemStatistics({
                analysisRunId: run.id,
                workingCodes: workingAnalysisFields(item).codes,
                evidenceLinks: itemEvidence,
                corpusMessages: corpusRows
            }),
            evidence: itemEvidence
            .map(link => {
                const message = corpusById.get(link.message_id);
                return message ? evidenceMessage(message, link) : null;
            })
            .filter(Boolean)
        };
    });

    return {
        period,
        runs,
        run,
        items: itemPayloads,
        corpusMessages: corpusRows.map(message => ({
            messageId: message.id,
            session: message.Session || null,
            participant: message.Participant || null,
            language: message.Language || null,
            timestamp: message.Timestamp || null,
            originalText: message.Message,
            englishTranslation: message.EnglishTranslation || null
        }))
    };
}

async function insertRunMessageLinks(supabaseClient, runId, batches) {
    const links = batches.flatMap((batch, batchIndex) =>
        batch.map(message => ({
            analysis_run_id: runId,
            message_id: message.id,
            batch_number: batchIndex + 1
        }))
    );

    for (let index = 0; index < links.length; index += 500) {
        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.runMessages)
            .insert(links.slice(index, index + 500));

        if (error) {
            throw new AnalysisError(500, "The analysis corpus could not be stored.");
        }
    }
}

async function persistSuggestedItem(supabaseClient, runId, item) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .insert({
            analysis_run_id: runId,
            origin: "ai",
            ai_theme: item.theme,
            ai_codes: item.codes,
            ai_keywords: item.keywords,
            ai_rationale: item.rationale,
            status: "ai_suggested"
        })
        .select("id")
        .single();

    if (error || !data) {
        throw new AnalysisError(500, "An AI suggestion could not be stored.");
    }

    const evidenceRecords = Array.isArray(item.evidence)
        ? item.evidence
        : item.evidenceIds.map(messageId => ({ messageId, codes: [] }));
    const { error: evidenceError } = await supabaseClient
        .from(ANALYSIS_TABLES.evidence)
        .insert(evidenceRecords.map(evidence => ({
            analysis_item_id: data.id,
            message_id: evidence.messageId,
            evidence_round: 0,
            source: "initial_ai",
            included: true,
            code_attributions: evidence.codes
        })));

    if (evidenceError) {
        await supabaseClient
            .from(ANALYSIS_TABLES.items)
            .update({ status: "evidence_error", updated_at: new Date().toISOString() })
            .eq("id", data.id);
        throw new AnalysisError(500, "AI suggestion evidence could not be stored.");
    }
}

async function generateAnalysis(
    req,
    supabaseClient,
    openaiClient,
    { batchSize, now }
) {
    if (!openaiClient) {
        throw new AnalysisError(500, "Server configuration is incomplete.");
    }

    const period = analysisPeriod(req.body?.start, req.body?.end);
    const rows = filterCorpusRows(
        await loadAllInterviewMessages(supabaseClient),
        period
    );
    const prepared = prepareParticipantMessages(rows);

    if (!prepared.messages.length) {
        throw new AnalysisError(400, "No participant messages are available in this period.");
    }

    const batches = buildAnalysisBatches(prepared.messages, batchSize);
    const representedLanguages = [...new Set(
        prepared.messages.map(message => message.language).filter(Boolean)
    )].sort();
    const sessions = new Set(
        prepared.messages.map(message => message.sessionId).filter(Boolean)
    );
    const { data: run, error: runError } = await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .insert({
            period_start: period.start,
            period_end: period.end,
            represented_languages: representedLanguages,
            status: "generating",
            model: QUALITATIVE_ANALYSIS_MODEL,
            analysis_version: QUALITATIVE_ANALYSIS_VERSION,
            messages_analyzed: prepared.messages.length,
            sessions_analyzed: sessions.size,
            batches_used: batches.length,
            skipped_records: prepared.skippedRecords
        })
        .select("*")
        .single();

    if (runError || !run) {
        throw new AnalysisError(500, "The analysis run could not be created.");
    }

    try {
        await insertRunMessageLinks(supabaseClient, run.id, batches);
    } catch (error) {
        await supabaseClient
            .from(ANALYSIS_TABLES.runs)
            .update({ status: "failed", completed_at: now() })
            .eq("id", run.id);
        throw error;
    }

    let batchFailures = 0;
    let invalidEvidenceIds = 0;
    let skippedItems = 0;
    let storedItems = 0;

    for (let index = 0; index < batches.length; index += 1) {
        try {
            const result = await generateSuggestionsForBatch(
                openaiClient,
                batches[index]
            );
            invalidEvidenceIds += result.invalidEvidenceIds;
            skippedItems += result.skippedItems;

            for (const item of result.items) {
                try {
                    await persistSuggestedItem(supabaseClient, run.id, item);
                    storedItems += 1;
                } catch (error) {
                    skippedItems += 1;
                    logOperationalFailure("suggestion_persistence", {
                        runId: run.id,
                        batchNumber: index + 1
                    }, error);
                }
            }
        } catch (error) {
            batchFailures += 1;
            logOperationalFailure("suggestion_generation", {
                runId: run.id,
                batchNumber: index + 1
            }, error);
        }
    }

    const status = storedItems === 0
        ? "failed"
        : batchFailures || skippedItems
            ? "completed_with_errors"
            : "completed";
    const { error: updateError } = await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .update({
            status,
            completed_at: now(),
            skipped_records: prepared.skippedRecords + skippedItems,
            invalid_evidence_ids: invalidEvidenceIds
        })
        .eq("id", run.id);

    if (updateError) {
        throw new AnalysisError(500, "The analysis run status could not be saved.");
    }

    if (storedItems === 0) {
        throw new AnalysisError(502, "AI suggestions could not be generated for this corpus.");
    }

    return loadWorkspace(supabaseClient, period, run.id);
}

async function saveFeedback(req, supabaseClient, now) {
    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {
        throw new AnalysisError(409, "Archived analysis items cannot be edited.");
    }

    const { error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .update({
            researcher_theme: typeof req.body?.theme === "string"
                ? req.body.theme.trim() || null
                : null,
            researcher_codes: commaSeparatedList(req.body?.codes),
            researcher_keywords: commaSeparatedList(req.body?.keywords),
            researcher_note: typeof req.body?.note === "string"
                ? req.body.note.trim() || null
                : null,
            status: "feedback_saved",
            working_revision: item.working_revision + 1,
            changed_since_confirmation: Boolean(item.confirmed_at),
            updated_at: now()
        })
        .eq("id", itemId);

    if (error) {
        throw new AnalysisError(500, "Researcher feedback could not be saved.");
    }

    if (item.confirmed_at) {
        await updateRunConfirmation(
            supabaseClient,
            item.analysis_run_id,
            now
        );
    }

    return item.analysis_run_id;
}

async function createResearcherItem(req, supabaseClient, now) {
    const runId = safeId(req.body?.runId, "Analysis run");
    const run = await loadRun(supabaseClient, runId);
    const theme = typeof req.body?.theme === "string"
        ? req.body.theme.trim()
        : "";

    if (run.status === "archived") {
        throw new AnalysisError(409, "Archived analysis runs cannot be edited.");
    }

    if (!theme) {
        throw new AnalysisError(400, "A researcher theme is required.");
    }

    const { error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .insert({
            analysis_run_id: runId,
            origin: "researcher",
            researcher_theme: theme,
            researcher_codes: commaSeparatedList(req.body?.codes),
            researcher_keywords: commaSeparatedList(req.body?.keywords),
            researcher_note: typeof req.body?.note === "string"
                ? req.body.note.trim() || null
                : null,
            status: "feedback_saved",
            working_revision: 1,
            updated_at: now()
        });

    if (error) {
        throw new AnalysisError(500, "The researcher analysis item could not be created.");
    }

    await updateRunConfirmation(supabaseClient, runId, now);

    return runId;
}

function batchesFromStoredRun(messages) {
    const byBatch = new Map();

    messages.forEach(message => {
        if (!byBatch.has(message.batchNumber)) {
            byBatch.set(message.batchNumber, []);
        }

        byBatch.get(message.batchNumber).push(message);
    });

    return [...byBatch.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, batch]) => prepareParticipantMessages(batch).messages);
}

async function collectEvidence(
    req,
    supabaseClient,
    openaiClient,
    now
) {
    if (!openaiClient) {
        throw new AnalysisError(500, "Server configuration is incomplete.");
    }

    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {
        throw new AnalysisError(409, "Archived analysis items cannot collect evidence.");
    }

    const instruction = workingAnalysisFields(item);

    if (!instruction.theme) {
        throw new AnalysisError(400, "A working theme is required before collecting evidence.");
    }

    const batches = batchesFromStoredRun(
        await runMessages(supabaseClient, item.analysis_run_id)
    );
    const collectedEvidence = new Map();
    let invalidEvidenceIds = 0;
    let failures = 0;

    for (let index = 0; index < batches.length; index += 1) {
        try {
            const result = await collectEvidenceForBatch(
                openaiClient,
                batches[index],
                instruction
            );
            invalidEvidenceIds += result.invalidEvidenceIds;
            result.evidence.forEach(evidence => {
                if (!collectedEvidence.has(evidence.messageId)) {
                    collectedEvidence.set(evidence.messageId, new Set());
                }

                evidence.codes.forEach(code => {
                    collectedEvidence.get(evidence.messageId).add(code);
                });
            });
        } catch (error) {
            failures += 1;
            logOperationalFailure("evidence_collection", {
                runId: item.analysis_run_id,
                itemId,
                batchNumber: index + 1
            }, error);
        }
    }

    if (!collectedEvidence.size) {
        throw new AnalysisError(
            failures ? 502 : 422,
            "No valid supporting participant messages were collected."
        );
    }

    const evidenceRound = item.evidence_round + 1;
    const { error: evidenceError } = await supabaseClient
        .from(ANALYSIS_TABLES.evidence)
        .insert([...collectedEvidence].map(([messageId, codes]) => ({
            analysis_item_id: itemId,
            message_id: messageId,
            evidence_round: evidenceRound,
            source: "feedback_ai",
            included: true,
            code_attributions: [...codes]
        })));

    if (evidenceError) {
        throw new AnalysisError(500, "Collected evidence could not be saved.");
    }

    const { error: itemError } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .update({
            evidence_round: evidenceRound,
            status: "evidence_collected",
            changed_since_confirmation: Boolean(item.confirmed_at),
            updated_at: now()
        })
        .eq("id", itemId);

    if (itemError) {
        throw new AnalysisError(500, "Evidence collection state could not be saved.");
    }

    if (item.confirmed_at) {
        await updateRunConfirmation(
            supabaseClient,
            item.analysis_run_id,
            now
        );
    }

    const run = await loadRun(supabaseClient, item.analysis_run_id);
    await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .update({
            invalid_evidence_ids:
                (run.invalid_evidence_ids || 0) + invalidEvidenceIds
        })
        .eq("id", run.id);

    return item.analysis_run_id;
}

async function messageBelongsToRun(supabaseClient, runId, messageId) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.runMessages)
        .select("message_id")
        .eq("analysis_run_id", runId)
        .eq("message_id", messageId)
        .maybeSingle();

    return !error && Boolean(data);
}

async function setEvidence(req, supabaseClient, now) {
    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {
        throw new AnalysisError(409, "Archived analysis items cannot be edited.");
    }

    const hasIncluded = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "included"
    );
    const hasCodes = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "codes"
    );
    const evidenceId = typeof req.body?.evidenceId === "string"
        ? req.body.evidenceId.trim()
        : "";

    if (evidenceId) {
        const { data: evidence, error: evidenceLookupError } = await supabaseClient
            .from(ANALYSIS_TABLES.evidence)
            .select("id, analysis_item_id")
            .eq("id", evidenceId)
            .maybeSingle();

        if (evidenceLookupError || evidence?.analysis_item_id !== itemId) {
            throw new AnalysisError(404, "Evidence link was not found.");
        }

        if (!hasIncluded && !hasCodes) {
            throw new AnalysisError(400, "No evidence change was supplied.");
        }

        const updates = { updated_at: now() };

        if (hasIncluded) {
            updates.included = req.body.included === true;
        }

        if (hasCodes) {
            updates.code_attributions = validatedAttributionCodes(
                req.body.codes,
                item
            );
        }

        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.evidence)
            .update(updates)
            .eq("id", evidenceId);

        if (error) {
            throw new AnalysisError(500, "Evidence selection could not be saved.");
        }
    } else {
        const messageId = safeId(req.body?.messageId, "Participant message");

        if (!await messageBelongsToRun(
            supabaseClient,
            item.analysis_run_id,
            messageId
        )) {
            throw new AnalysisError(400, "The participant message is outside this analysis corpus.");
        }

        const participantRows = prepareParticipantMessages(
            await loadMessagesByIds(supabaseClient, [messageId])
        ).messages;

        if (participantRows.length !== 1) {
            throw new AnalysisError(400, "Only participant messages can be added as evidence.");
        }

        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.evidence)
            .insert({
                analysis_item_id: itemId,
                message_id: messageId,
                evidence_round: item.evidence_round,
                source: "researcher_manual",
                included: true,
                code_attributions: validatedAttributionCodes(
                    req.body?.codes,
                    item
                )
            });

        if (error) {
            throw new AnalysisError(409, "That participant message is already linked in this evidence round.");
        }
    }

    if (item.confirmed_at) {
        await supabaseClient
            .from(ANALYSIS_TABLES.items)
            .update({ changed_since_confirmation: true, updated_at: now() })
            .eq("id", itemId);
        await updateRunConfirmation(
            supabaseClient,
            item.analysis_run_id,
            now
        );
    }

    return item.analysis_run_id;
}

async function updateRunConfirmation(supabaseClient, runId, now) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .select("status, confirmed_at, changed_since_confirmation")
        .eq("analysis_run_id", runId);

    if (error) {
        return;
    }

    const activeItems = (data || []).filter(item => item.status !== "archived");
    const fullyConfirmed = activeItems.length > 0 && activeItems.every(item =>
        item.confirmed_at && !item.changed_since_confirmation
    );

    await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .update({ confirmed_at: fullyConfirmed ? now() : null })
        .eq("id", runId);
}

async function confirmItem(req, supabaseClient, now) {
    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {
        throw new AnalysisError(409, "Archived analysis items cannot be confirmed.");
    }

    const confirmed = workingAnalysisFields(item);

    if (!confirmed.theme) {
        throw new AnalysisError(400, "A working theme is required before confirmation.");
    }

    const { data: evidence, error: evidenceError } = await supabaseClient
        .from(ANALYSIS_TABLES.evidence)
        .select("message_id, evidence_round, source, included, code_attributions")
        .eq("analysis_item_id", itemId)
        .eq("included", true);

    if (evidenceError) {
        throw new AnalysisError(500, "Supporting evidence could not be loaded.");
    }

    const evidenceIds = [...new Set(
        (evidence || []).map(link => link.message_id)
    )];

    if (!evidenceIds.length) {
        throw new AnalysisError(400, "At least one supporting participant message is required before confirmation.");
    }

    const confirmedAt = now();
    const confirmedStatistics = calculateItemStatistics({
        analysisRunId: item.analysis_run_id,
        workingCodes: confirmed.codes,
        evidenceLinks: evidence || [],
        corpusMessages: await runMessages(
            supabaseClient,
            item.analysis_run_id
        ),
        calculatedAt: confirmedAt
    });
    const { error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .update({
            confirmed_theme: confirmed.theme,
            confirmed_codes: confirmed.codes,
            confirmed_keywords: confirmed.keywords,
            confirmed_evidence_message_ids: evidenceIds,
            confirmed_note: confirmed.note,
            confirmed_statistics: confirmedStatistics,
            confirmed_statistics_calculated_at: confirmedAt,
            confirmed_working_revision: item.working_revision,
            confirmed_at: confirmedAt,
            changed_since_confirmation: false,
            status: "confirmed",
            updated_at: confirmedAt
        })
        .eq("id", itemId);

    if (error) {
        throw new AnalysisError(500, "The confirmed analytical snapshot could not be saved.");
    }

    await updateRunConfirmation(
        supabaseClient,
        item.analysis_run_id,
        now
    );
    return item.analysis_run_id;
}

async function archiveItem(req, supabaseClient, now) {
    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);
    const { error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .update({ status: "archived", updated_at: now() })
        .eq("id", itemId);

    if (error) {
        throw new AnalysisError(500, "The analysis item could not be archived.");
    }

    await updateRunConfirmation(
        supabaseClient,
        item.analysis_run_id,
        now
    );
    return item.analysis_run_id;
}

async function reopenItem(req, supabaseClient, now) {
    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status !== "archived") {
        throw new AnalysisError(409, "Only archived analysis items can be reopened.");
    }

    const status = item.confirmed_at && !item.changed_since_confirmation
        ? "confirmed"
        : item.evidence_round > 0
            ? "evidence_collected"
            : item.working_revision > 0
                ? "feedback_saved"
                : "ai_suggested";
    const { error } = await supabaseClient
        .from(ANALYSIS_TABLES.items)
        .update({ status, updated_at: now() })
        .eq("id", itemId);

    if (error) {
        throw new AnalysisError(500, "The analysis item could not be reopened.");
    }

    await updateRunConfirmation(
        supabaseClient,
        item.analysis_run_id,
        now
    );
    return item.analysis_run_id;
}

export async function loadConfirmedAnalysis(
    supabaseClient,
    { runId = null } = {}
) {
    let query = supabaseClient
        .from(ANALYSIS_TABLES.items)
        .select("id, analysis_run_id, status, confirmed_theme, confirmed_codes, confirmed_keywords, confirmed_evidence_message_ids, confirmed_note, confirmed_statistics, confirmed_statistics_calculated_at, confirmed_working_revision, confirmed_at, changed_since_confirmation")
        .order("confirmed_at", { ascending: true });

    if (runId) {
        query = query.eq("analysis_run_id", runId);
    }

    const { data, error } = await query;

    if (error) {
        throw new AnalysisError(500, "Confirmed analysis could not be loaded.");
    }

    return (data || [])
        .filter(item => item.confirmed_at && item.status !== "archived")
        .map(item => ({
            analysisItemId: item.id,
            analysisRunId: item.analysis_run_id,
            theme: item.confirmed_theme,
            codes: item.confirmed_codes,
            keywords: item.confirmed_keywords,
            supportingMessageIds: item.confirmed_evidence_message_ids,
            researcherNote: item.confirmed_note,
            descriptiveStatistics: item.confirmed_statistics,
            statisticsCalculatedAt:
                item.confirmed_statistics_calculated_at,
            workingRevision: item.confirmed_working_revision,
            confirmedAt: item.confirmed_at,
            requiresReconfirmation: item.changed_since_confirmation === true
        }));
}

export async function handleAnalysis(
    req,
    res,
    {
        supabaseClient,
        openaiClient = null,
        configuredToken,
        batchSize = DEFAULT_ANALYSIS_BATCH_SIZE,
        now = () => new Date().toISOString()
    }
) {
    const authorization = authorizeResearcher(req, configuredToken);

    if (!authorization.authorized) {
        return res.status(authorization.status).json({
            error: authorization.error
        });
    }

    try {
        if (req.method === "GET") {
            const action = req.query?.action || "list";

            if (action === "confirmed") {
                return res.status(200).json({
                    confirmedItems: await loadConfirmedAnalysis(
                        supabaseClient,
                        { runId: req.query?.runId || null }
                    )
                });
            }

            if (action !== "list") {
                throw new AnalysisError(400, "Unknown analysis action.");
            }

            const period = analysisPeriod(
                req.query?.start,
                req.query?.end
            );
            return res.status(200).json(await loadWorkspace(
                supabaseClient,
                period,
                req.query?.runId || null
            ));
        }

        if (req.method !== "POST") {
            res.setHeader("Allow", "GET, POST");
            return res.status(405).json({ error: "Method not allowed." });
        }

        const action = req.body?.action;
        let runId;

        if (action === "generate") {
            return res.status(200).json(await generateAnalysis(
                req,
                supabaseClient,
                openaiClient,
                { batchSize, now }
            ));
        }

        if (action === "save_feedback") {
            runId = await saveFeedback(req, supabaseClient, now);
        } else if (action === "create_item") {
            runId = await createResearcherItem(req, supabaseClient, now);
        } else if (action === "collect_evidence") {
            runId = await collectEvidence(
                req,
                supabaseClient,
                openaiClient,
                now
            );
        } else if (action === "set_evidence") {
            runId = await setEvidence(req, supabaseClient, now);
        } else if (action === "confirm") {
            runId = await confirmItem(req, supabaseClient, now);
        } else if (action === "archive") {
            runId = await archiveItem(req, supabaseClient, now);
        } else if (action === "reopen") {
            runId = await reopenItem(req, supabaseClient, now);
        } else {
            throw new AnalysisError(400, "Unknown analysis action.");
        }

        const run = await loadRun(supabaseClient, runId);
        const period = analysisPeriod(run.period_start, run.period_end);
        return res.status(200).json(await loadWorkspace(
            supabaseClient,
            period,
            runId
        ));
    } catch (error) {
        const status = error instanceof AnalysisError
            ? error.status
            : 500;
        const message = error instanceof AnalysisError
            ? error.message
            : "Unable to complete the qualitative-analysis request.";

        logOperationalFailure("request", {
            action: safeActionName(req)
        }, error);

        return res.status(status).json({ error: message });
    }
}

function configuredBatchSize(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 100
        ? parsed
        : DEFAULT_ANALYSIS_BATCH_SIZE;
}

export default async function handler(req, res) {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const configuredToken = process.env.RESEARCHER_DASHBOARD_TOKEN;

    if (!secretKey || !configuredToken) {
        return res.status(500).json({
            error: "Server configuration is incomplete."
        });
    }

    const action = req.body?.action;
    const requiresOpenAI = req.method === "POST" && AI_ACTIONS.has(action);

    if (requiresOpenAI && !process.env.OPENAI_API_KEY) {
        return res.status(500).json({
            error: "Server configuration is incomplete."
        });
    }

    const supabaseClient = createClient(
        process.env.SUPABASE_URL,
        secretKey,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        }
    );
    const openaiClient = requiresOpenAI
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;

    return handleAnalysis(req, res, {
        supabaseClient,
        openaiClient,
        configuredToken,
        batchSize: configuredBatchSize(
            process.env.QUALITATIVE_ANALYSIS_BATCH_SIZE
        )
    });
}
