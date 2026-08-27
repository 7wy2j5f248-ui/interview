import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
    buildAnalysisBatches,
    collectEvidenceForBatch,
    commaSeparatedList,
    DEFAULT_ANALYSIS_BATCH_SIZE,
    discussAnalysisWithResearcher,
    generateSuggestionsForBatch,
    prepareParticipantMessages,
    QUALITATIVE_ANALYSIS_MODEL,
    QUALITATIVE_ANALYSIS_VERSION,
    workingAnalysisFields
} from "../server/analysisCore.js";
import { calculateItemStatistics } from "../server/analysisStatistics.js";
import {
    COMPLETION_FILTERS,
    filterCorpusRows,
    loadEligibleSessionRows,
    normalizeCompletionFilter,
    normalizeCorpusPeriod,
    storedIdentifier
} from "../server/corpus.js";
import { authorizeResearcher } from "../server/researcherAuth.js";
import { normalizeOpenAIModel } from "../server/modelConfiguration.js";
import { loadParticipantCodeMap } from "../server/participantCodes.js";

const AI_ACTIONS = new Set(["generate", "collect_evidence", "discuss"]);
const KNOWN_ACTIONS = new Set([
    "list",
    "confirmed",
    "generate",
    "save_feedback",
    "create_item",
    "collect_evidence",
    "discuss",
    "set_evidence",
    "confirm",
    "archive",
    "reopen"
]);
const ANALYSIS_TABLES = Object.freeze({
    runs: "qualitative_analysis_runs",
    runMessages: "qualitative_analysis_run_messages",
    items: "qualitative_analysis_items",
    evidence: "qualitative_analysis_evidence",
    batches: "qualitative_analysis_batches",
    batchSessions: "qualitative_analysis_batch_sessions",
    batchMessages: "qualitative_analysis_batch_messages",
    itemBatches: "qualitative_analysis_item_batches",
    suggestionSources: "qualitative_analysis_suggestion_sources",
    workbookImports: "qualitative_analysis_workbook_imports"
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

function analysisCompletionFilter(value) {
    try {
        return normalizeCompletionFilter(value);
    } catch (error) {
        throw new AnalysisError(400, error.message);
    }
}

function analysisModel(value) {
    try {
        return normalizeOpenAIModel(value);
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

async function loadInterviewMessagesForSessions(
    supabaseClient,
    sessionRows,
    pageSize = 1000
) {
    const sessionIds = [...new Set(
        (Array.isArray(sessionRows) ? sessionRows : [])
            .map(session => storedIdentifier(session?.session_id))
            .filter(Boolean)
    )];
    const rows = [];

    for (let index = 0; index < sessionIds.length; index += 100) {
        const chunk = sessionIds.slice(index, index + 100);
        let from = 0;

        while (true) {
            const { data, error } = await supabaseClient
                .from("interview_messages")
                .select("id, Participant, Session, Language, Speaker, Message, Timestamp, EnglishTranslation")
                .in("Session", chunk)
                .order("id", { ascending: true })
                .range(from, from + pageSize - 1);

            if (error) {
                throw new AnalysisError(
                    500,
                    "The analysis corpus could not be loaded."
                );
            }

            const page = data || [];
            rows.push(...page);

            if (page.length < pageSize) {
                break;
            }

            from += pageSize;
        }
    }

    return rows.sort((left, right) => String(left.id).localeCompare(
        String(right.id)
    ));
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

function runCompletionFilter(run) {
    if (run?.completion_filter) {
        return normalizeCompletionFilter(run.completion_filter);
    }

    return run?.completed_only === true
        ? COMPLETION_FILTERS.completed
        : COMPLETION_FILTERS.all;
}

async function loadRunsForScope(supabaseClient, period, completionFilter) {
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.runs)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

    if (error) {
        throw new AnalysisError(500, "Stored analysis runs could not be loaded.");
    }

    return (data || []).filter(run =>
        periodMatches(run, period)
        && runCompletionFilter(run) === completionFilter
    );
}

async function loadWorkbookImports(supabaseClient, runId) {
    if (!runId) {
        return [];
    }
    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.workbookImports)
        .select("id, analysis_run_id, stage, parent_import_id, source_filename, file_sha256, workbook_format_version, source_selection, row_order, grouping_data, imported_by, imported_at")
        .eq("analysis_run_id", runId)
        .order("imported_at", { ascending: false })
        .limit(100);
    if (error) {
        throw new AnalysisError(
            500,
            "Researcher workbook decision layers could not be loaded."
        );
    }
    return data || [];
}

function evidenceMessage(
    message,
    link,
    suggestionSources = [],
    participantCode = null
) {
    const sourceValues = type => [...new Set(
        suggestionSources
            .filter(source => source.suggestion_type === type)
            .map(source => source.suggestion_value)
    )];

    return {
        evidenceId: link.id,
        messageId: message.id,
        batchId: link.batch_id || null,
        session: message.Session || null,
        participant: message.Participant || null,
        participantCode,
        language: message.Language || null,
        speaker: message.Speaker || null,
        timestamp: message.Timestamp || null,
        originalText: message.Message,
        englishTranslation: message.EnglishTranslation || null,
        source: link.source,
        round: link.evidence_round,
        included: link.included === true,
        codes: Array.isArray(link.code_attributions)
            ? link.code_attributions
            : [],
        associatedSuggestions: {
            themes: sourceValues("theme"),
            codes: sourceValues("code"),
            codedPhrases: sourceValues("coded_phrase"),
            keywords: sourceValues("keyword")
        }
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

function sessionDescriptorPayload(
    session,
    descriptor,
    fallbackSessionId = null,
    participantCode = null
) {
    return {
        sessionId: session?.session_id
            || descriptor?.session_id
            || fallbackSessionId,
        participantId: session?.participant_id
            || descriptor?.participant_id
            || null,
        participantCode,
        language: session?.language || null,
        completed: session?.completed === true,
        completedAt: session?.completed_at || null,
        sessionStatus: session?.session_status || (
            session?.completed === true ? "completed" : "active"
        ),
        endReason: session?.end_reason || null,
        timedOutAt: session?.timed_out_at || null,
        descriptors: descriptor ? {
            currentCountry: descriptor.current_country,
            currentRegion: descriptor.current_region,
            countryOfOrigin: descriptor.country_of_origin,
            diasporaStatus: descriptor.diaspora_status,
            gender: descriptor.gender,
            age: descriptor.age,
            birthYear: descriptor.birth_year,
            birthCohort: descriptor.birth_cohort,
            youthStatus: descriptor.youth_status,
            educationLevel: descriptor.education_level,
            socialIdentity: descriptor.social_identity,
            additionalDescriptors: descriptor.additional_descriptors || {}
        } : null
    };
}

function workspaceMessagePayload(
    message,
    batchId = null,
    participantCode = null
) {
    return {
        messageId: message.id,
        batchId,
        session: message.Session || null,
        participant: message.Participant || null,
        participantCode,
        language: message.Language || null,
        speaker: message.Speaker || null,
        timestamp: message.Timestamp || null,
        originalText: message.Message,
        englishTranslation: message.EnglishTranslation || null
    };
}

function batchLanguageDistribution(messageLinks, corpusById) {
    const distribution = new Map();

    messageLinks.forEach(link => {
        const message = corpusById.get(link.message_id);
        const language = storedIdentifier(message?.Language)?.toLowerCase()
            || "unidentified";

        if (!distribution.has(language)) {
            distribution.set(language, {
                language,
                messageIds: new Set(),
                sessionIds: new Set()
            });
        }

        const entry = distribution.get(language);
        entry.messageIds.add(link.message_id);

        if (link.session_id) {
            entry.sessionIds.add(link.session_id);
        }
    });

    return [...distribution.values()]
        .map(entry => ({
            language: entry.language,
            messageCount: entry.messageIds.size,
            sessionCount: entry.sessionIds.size
        }))
        .sort((left, right) => left.language.localeCompare(right.language));
}

async function loadRunProvenance(
    supabaseClient,
    runId,
    itemIds,
    corpusRows
) {
    const { data: batchRows, error: batchError } = await supabaseClient
        .from(ANALYSIS_TABLES.batches)
        .select("*")
        .eq("analysis_run_id", runId)
        .order("batch_number", { ascending: true });

    if (batchError) {
        throw new AnalysisError(500, "Analysis batch provenance could not be loaded.");
    }

    const batchIds = (batchRows || []).map(batch => batch.id);
    let batchSessions = [];
    let batchMessages = [];

    if (batchIds.length) {
        const [sessionResult, messageResult] = await Promise.all([
            supabaseClient
                .from(ANALYSIS_TABLES.batchSessions)
                .select("batch_id, session_id")
                .in("batch_id", batchIds),
            supabaseClient
                .from(ANALYSIS_TABLES.batchMessages)
                .select("batch_id, message_id, session_id")
                .in("batch_id", batchIds)
        ]);

        if (sessionResult.error || messageResult.error) {
            throw new AnalysisError(500, "Frozen batch membership could not be loaded.");
        }

        batchSessions = sessionResult.data || [];
        batchMessages = messageResult.data || [];
    }

    let itemBatches = [];
    let suggestionSources = [];

    if (itemIds.length) {
        const [itemBatchResult, sourceResult] = await Promise.all([
            supabaseClient
                .from(ANALYSIS_TABLES.itemBatches)
                .select("analysis_item_id, batch_id, relationship_type")
                .in("analysis_item_id", itemIds),
            supabaseClient
                .from(ANALYSIS_TABLES.suggestionSources)
                .select("analysis_item_id, batch_id, suggestion_type, suggestion_value, message_id")
                .in("analysis_item_id", itemIds)
        ]);

        if (itemBatchResult.error || sourceResult.error) {
            throw new AnalysisError(500, "Item source provenance could not be loaded.");
        }

        itemBatches = itemBatchResult.data || [];
        suggestionSources = sourceResult.data || [];
    }

    const sessionIds = [...new Set([
        ...batchSessions.map(link => storedIdentifier(link.session_id)),
        ...corpusRows.map(message => storedIdentifier(message?.Session))
    ].filter(Boolean))];
    let sessionRows = [];
    let descriptorRows = [];

    if (sessionIds.length) {
        const [sessionResult, descriptorResult] = await Promise.all([
            supabaseClient
                .from("interview_sessions")
                .select("session_id, participant_id, language, completed, completed_at, session_status, end_reason, timed_out_at")
                .in("session_id", sessionIds),
            supabaseClient
                .from("participant_descriptors")
                .select("session_id, participant_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors")
                .in("session_id", sessionIds)
        ]);

        if (sessionResult.error || descriptorResult.error) {
            throw new AnalysisError(500, "Batch session metadata could not be loaded.");
        }

        sessionRows = sessionResult.data || [];
        descriptorRows = descriptorResult.data || [];
    }

    const sessionById = new Map(sessionRows.map(session => [
        session.session_id,
        session
    ]));
    const descriptorBySession = new Map(descriptorRows.map(descriptor => [
        descriptor.session_id,
        descriptor
    ]));
    const participantCodeById = await loadParticipantCodeMap(
        supabaseClient,
        [
            ...sessionRows.map(session => session.participant_id),
            ...corpusRows.map(message => message.Participant)
        ]
    );
    const corpusById = new Map(corpusRows.map(message => [message.id, message]));
    const batchPayloads = (batchRows || []).map(batch => {
        const membership = batchMessages.filter(link =>
            link.batch_id === batch.id
        );
        const sessions = batchSessions
            .filter(link => link.batch_id === batch.id)
            .map(link => sessionDescriptorPayload(
                sessionById.get(link.session_id),
                descriptorBySession.get(link.session_id),
                link.session_id,
                participantCodeById.get(
                    sessionById.get(link.session_id)?.participant_id
                    || descriptorBySession.get(link.session_id)?.participant_id
                ) || null
            ));

        return {
            id: batch.id,
            analysisRunId: batch.analysis_run_id,
            batchNumber: batch.batch_number,
            totalBatches: batch.total_batches,
            sessionCount: batch.session_count,
            messageCount: batch.message_count,
            inputTokenCount: batch.input_token_count,
            groupingCriteria: batch.grouping_criteria || {},
            createdAt: batch.created_at,
            legacy: batch.grouping_criteria?.legacy === true,
            sessions,
            messageIds: membership.map(link => link.message_id),
            messageMembership: membership.map(link => ({
                messageId: link.message_id,
                sessionId: link.session_id || null
            })),
            languageDistribution: batchLanguageDistribution(
                membership,
                corpusById
            )
        };
    });

    return {
        batches: batchPayloads,
        batchById: new Map(batchPayloads.map(batch => [batch.id, batch])),
        batchIdByMessageId: new Map(batchMessages.map(link => [
            link.message_id,
            link.batch_id
        ])),
        sessionIdByMessageId: new Map(batchMessages.map(link => [
            link.message_id,
            link.session_id || null
        ])),
        sessionById: new Map(sessionIds.map(sessionId => [
            sessionId,
            sessionDescriptorPayload(
                sessionById.get(sessionId),
                descriptorBySession.get(sessionId),
                sessionId,
                participantCodeById.get(
                    sessionById.get(sessionId)?.participant_id
                    || descriptorBySession.get(sessionId)?.participant_id
                ) || null
            )
        ])),
        participantCodeById,
        itemBatches,
        suggestionSources
    };
}

function analysisItemComponents(item, suggestionSources) {
    const definitions = [
        { type: "theme", values: item.ai_theme ? [item.ai_theme] : [] },
        { type: "code", values: item.ai_codes || [] },
        { type: "coded_phrase", values: item.ai_coded_phrases || [] },
        { type: "keyword", values: item.ai_keywords || [] }
    ];

    return definitions.flatMap(definition =>
        definition.values.map(value => {
            const sources = suggestionSources.filter(source =>
                source.suggestion_type === definition.type
                && source.suggestion_value === value
            );

            return {
                type: definition.type,
                value,
                available: sources.length > 0,
                batchIds: [...new Set(sources.map(source => source.batch_id))],
                messageIds: [...new Set(sources.map(source => source.message_id))]
            };
        })
    );
}

function itemProvenancePayload(item, itemEvidence, provenance) {
    const itemBatchLinks = provenance.itemBatches.filter(link =>
        link.analysis_item_id === item.id
    );
    const itemSources = provenance.suggestionSources.filter(source =>
        source.analysis_item_id === item.id
    );
    const includedEvidence = itemEvidence.filter(link => link.included === true);
    const supportingBySession = new Map();

    includedEvidence.forEach(link => {
        const sessionId = provenance.sessionIdByMessageId.get(link.message_id);

        if (!sessionId) {
            return;
        }

        if (!supportingBySession.has(sessionId)) {
            supportingBySession.set(sessionId, {
                ...(provenance.sessionById.get(sessionId) || {
                    sessionId,
                    participantId: null,
                    participantCode: null,
                    language: null,
                    completed: false,
                    completedAt: null,
                    descriptors: null
                }),
                linkedEvidenceMessageIds: new Set()
            });
        }

        supportingBySession.get(sessionId).linkedEvidenceMessageIds.add(
            link.message_id
        );
    });

    const batches = itemBatchLinks
        .map(link => {
            const batch = provenance.batchById.get(link.batch_id);

            if (!batch) {
                return null;
            }

            const supportingLinks = includedEvidence.filter(evidence =>
                (evidence.batch_id
                    || provenance.batchIdByMessageId.get(evidence.message_id))
                    === batch.id
            );
            const supportingSessions = new Set(
                supportingLinks.map(link => {
                    return provenance.sessionIdByMessageId.get(
                        link.message_id
                    );
                }).filter(Boolean)
            );

            return {
                ...batch,
                relationshipType: link.relationship_type,
                supportingMessageCount: new Set(
                    supportingLinks.map(link => link.message_id)
                ).size,
                supportingSessionCount: supportingSessions.size
            };
        })
        .filter(Boolean);
    const status = !batches.length
        ? "unavailable"
        : batches.some(batch => batch.legacy)
            ? "legacy_reconstructed"
            : "available";

    return {
        status,
        batches,
        supportingSessions: [...supportingBySession.values()].map(session => ({
            sessionId: session.sessionId,
            participantId: session.participantId,
            participantCode: session.participantCode,
            language: session.language,
            completed: session.completed,
            completedAt: session.completedAt,
            sessionStatus: session.sessionStatus,
            endReason: session.endReason,
            timedOutAt: session.timedOutAt,
            descriptors: session.descriptors,
            linkedEvidenceMessageCount:
                session.linkedEvidenceMessageIds.size
        })),
        components: analysisItemComponents(item, itemSources)
    };
}

async function loadWorkspace(
    supabaseClient,
    period,
    completionFilter,
    requestedRunId = null
) {
    const runs = await loadRunsForScope(
        supabaseClient,
        period,
        completionFilter
    );
    const run = requestedRunId
        ? runs.find(item => item.id === requestedRunId)
        : runs[0];

    if (!run) {
        const eligibleSessions = await loadEligibleSessionRows(
            supabaseClient,
            completionFilter
        );
        const corpusRows = filterCorpusRows(
            await loadInterviewMessagesForSessions(
                supabaseClient,
                eligibleSessions
            ),
            period
        );
        const includedSessionIds = new Set(corpusRows.map(message =>
            storedIdentifier(message?.Session)
        ).filter(Boolean));
        const scopedSessions = eligibleSessions.filter(session =>
            includedSessionIds.has(storedIdentifier(session?.session_id))
        );
        const scopedSessionIds = scopedSessions.map(session =>
            session.session_id
        );
        let descriptorRows = [];

        if (scopedSessionIds.length) {
            const { data, error } = await supabaseClient
                .from("participant_descriptors")
                .select("session_id, participant_id, current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors")
                .in("session_id", scopedSessionIds);

            if (error) {
                throw new AnalysisError(
                    500,
                    "Participant metadata could not be loaded."
                );
            }
            descriptorRows = data || [];
        }

        const descriptorBySession = new Map(descriptorRows.map(descriptor => [
            descriptor.session_id,
            descriptor
        ]));
        const participantCodeById = await loadParticipantCodeMap(
            supabaseClient,
            [
                ...scopedSessions.map(session => session.participant_id),
                ...corpusRows.map(message => message.Participant)
            ]
        );

        return {
            period,
            completionFilter,
            runs,
            run: null,
            items: [],
            batches: [],
            workbookImports: [],
            participants: scopedSessions.map(session =>
                sessionDescriptorPayload(
                    session,
                    descriptorBySession.get(session.session_id),
                    session.session_id,
                    participantCodeById.get(session.participant_id) || null
                )
            ),
            corpusMessages: corpusRows.map(message =>
                workspaceMessagePayload(
                    message,
                    null,
                    participantCodeById.get(message.Participant) || null
                )
            )
        };
    }

    const [
        { data: items, error: itemError },
        corpusRows,
        workbookImports
    ] = await Promise.all([
        supabaseClient
            .from(ANALYSIS_TABLES.items)
            .select("*")
            .eq("analysis_run_id", run.id)
            .order("created_at", { ascending: true }),
        runMessages(supabaseClient, run.id),
        loadWorkbookImports(supabaseClient, run.id)
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

    const provenance = await loadRunProvenance(
        supabaseClient,
        run.id,
        itemIds,
        corpusRows
    );
    const corpusById = new Map(corpusRows.map(message => [message.id, message]));
    const itemPayloads = (items || []).map(item => {
        const itemEvidence = evidence.filter(
            link => link.analysis_item_id === item.id
        );
        const itemSources = provenance.suggestionSources.filter(source =>
            source.analysis_item_id === item.id
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
                return message ? evidenceMessage(
                    message,
                    link,
                    itemSources.filter(source =>
                        source.message_id === link.message_id
                    ),
                    provenance.participantCodeById.get(
                        message.Participant
                    ) || null
                ) : null;
            })
            .filter(Boolean),
            provenance: itemProvenancePayload(
                item,
                itemEvidence,
                provenance
            )
        };
    });

    return {
        period,
        completionFilter,
        runs,
        run,
        items: itemPayloads,
        batches: provenance.batches,
        workbookImports,
        participants: [...provenance.sessionById.values()],
        corpusMessages: corpusRows.map(message => workspaceMessagePayload(
            message,
            provenance.batchIdByMessageId.get(message.id) || null,
            provenance.participantCodeById.get(message.Participant) || null
        ))
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

async function persistFrozenBatches(
    supabaseClient,
    runId,
    batches,
    batchSize
) {
    const sessionBatchCounts = new Map();

    batches.forEach(batch => {
        new Set(batch.map(message => message.sessionId).filter(Boolean))
            .forEach(sessionId => {
                sessionBatchCounts.set(
                    sessionId,
                    (sessionBatchCounts.get(sessionId) || 0) + 1
                );
            });
    });

    const batchRows = batches.map((batch, index) => {
        const sessionIds = [...new Set(
            batch.map(message => message.sessionId).filter(Boolean)
        )];

        return {
            analysis_run_id: runId,
            batch_number: index + 1,
            total_batches: batches.length,
            session_count: sessionIds.length,
            message_count: batch.length,
            input_token_count: null,
            grouping_criteria: {
                strategy: "sequential_session_preserving",
                partitionReason: "technical_message_limit",
                configuredMessageLimit: batchSize,
                splitSessionIds: sessionIds.filter(sessionId =>
                    sessionBatchCounts.get(sessionId) > 1
                )
            }
        };
    });
    const { data: storedRows, error: batchError } = await supabaseClient
        .from(ANALYSIS_TABLES.batches)
        .insert(batchRows)
        .select("*");

    if (batchError || (storedRows || []).length !== batches.length) {
        throw new AnalysisError(500, "Analysis batch records could not be stored.");
    }

    const storedByNumber = new Map(
        storedRows.map(batch => [batch.batch_number, batch])
    );
    const storedBatches = batches.map((messages, index) => ({
        ...storedByNumber.get(index + 1),
        messages
    }));
    const sessionLinks = storedBatches.flatMap(batch =>
        [...new Set(batch.messages
            .map(message => message.sessionId)
            .filter(Boolean)
        )].map(sessionId => ({
            batch_id: batch.id,
            session_id: sessionId
        }))
    );
    const messageLinks = storedBatches.flatMap(batch =>
        batch.messages.map(message => ({
            batch_id: batch.id,
            message_id: message.id,
            session_id: message.sessionId || null
        }))
    );

    if (sessionLinks.length) {
        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.batchSessions)
            .insert(sessionLinks);

        if (error) {
            throw new AnalysisError(500, "Frozen batch sessions could not be stored.");
        }
    }

    for (let index = 0; index < messageLinks.length; index += 500) {
        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.batchMessages)
            .insert(messageLinks.slice(index, index + 500));

        if (error) {
            throw new AnalysisError(500, "Frozen batch messages could not be stored.");
        }
    }

    await insertRunMessageLinks(supabaseClient, runId, batches);
    return storedBatches;
}

async function persistSuggestedItem(
    supabaseClient,
    runId,
    batch,
    item
) {
    const evidenceRecords = Array.isArray(item.evidence)
        ? item.evidence
        : item.evidenceIds.map(messageId => ({ messageId, codes: [] }));
    const { data, error } = await supabaseClient.rpc(
        "create_ai_analysis_item_with_batch",
        {
            p_analysis_run_id: runId,
            p_batch_id: batch.id,
            p_theme: item.theme,
            p_codes: item.codes,
            p_coded_phrases: item.codedPhrases,
            p_keywords: item.keywords,
            p_rationale: item.rationale,
            p_evidence: evidenceRecords.map(evidence => ({
                message_id: evidence.messageId,
                codes: evidence.codes
            })),
            p_suggestion_sources: item.suggestionSources.map(source => ({
                suggestion_type: source.suggestionType,
                suggestion_value: source.suggestionValue,
                message_id: source.messageId
            }))
        }
    );

    if (error || !data) {
        throw new AnalysisError(
            500,
            "AI suggestion and source provenance could not be stored."
        );
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

    const model = analysisModel(req.body?.model);
    const period = analysisPeriod(req.body?.start, req.body?.end);
    const completionFilter = analysisCompletionFilter(
        req.body?.completion
    );
    const eligibleSessions = await loadEligibleSessionRows(
        supabaseClient,
        completionFilter
    );
    const rows = filterCorpusRows(
        await loadInterviewMessagesForSessions(
            supabaseClient,
            eligibleSessions
        ),
        period
    );
    const prepared = prepareParticipantMessages(rows);

    if (!prepared.messages.length) {
        throw new AnalysisError(400, "No participant messages are available in this period.");
    }

    let batches = buildAnalysisBatches(prepared.messages, batchSize);
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
            completion_filter: completionFilter,
            completed_only:
                completionFilter === COMPLETION_FILTERS.completed,
            represented_languages: representedLanguages,
            status: "generating",
            model,
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
        batches = await persistFrozenBatches(
            supabaseClient,
            run.id,
            batches,
            batchSize
        );
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
                batches[index].messages,
                { model }
            );
            invalidEvidenceIds += result.invalidEvidenceIds;
            skippedItems += result.skippedItems + result.skippedComponents;

            if (Number.isInteger(result.inputTokenCount)) {
                const { error: tokenUpdateError } = await supabaseClient
                    .from(ANALYSIS_TABLES.batches)
                    .update({ input_token_count: result.inputTokenCount })
                    .eq("id", batches[index].id);

                if (tokenUpdateError) {
                    logOperationalFailure("batch_token_persistence", {
                        runId: run.id,
                        batchNumber: index + 1
                    }, tokenUpdateError);
                }
            }

            for (const item of result.items) {
                try {
                    await persistSuggestedItem(
                        supabaseClient,
                        run.id,
                        batches[index],
                        item
                    );
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

    return loadWorkspace(
        supabaseClient,
        period,
        completionFilter,
        run.id
    );
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
            researcher_coded_phrases: commaSeparatedList(
                req.body?.codedPhrases
            ),
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

function safeDiscussionConversation(value) {
    return (Array.isArray(value) ? value : []).slice(-12).map(message => {
        const role = message?.role === "assistant"
            ? "assistant"
            : "researcher";
        const content = typeof message?.content === "string"
            ? message.content.trim().slice(0, 4000)
            : "";
        return content ? { role, content } : null;
    }).filter(Boolean);
}

function discussionCodeKeywordGroups(item) {
    const components = item.provenance?.components || [];
    const codes = workingAnalysisFields(item).codes;
    const keywordComponents = components.filter(component =>
        component.type === "keyword" && component.available
    );

    return codes.map(code => {
        const codeComponent = components.find(component =>
            component.type === "code"
            && component.value?.toLowerCase() === code.toLowerCase()
        );
        const codeMessageIds = new Set(codeComponent?.messageIds || []);
        (item.evidence || []).filter(evidence =>
            (evidence.codes || []).some(attributedCode =>
                attributedCode.toLowerCase() === code.toLowerCase()
            )
        ).forEach(evidence => codeMessageIds.add(evidence.messageId));
        return {
            code,
            keywords: keywordComponents.filter(keyword =>
                keyword.messageIds.some(messageId =>
                    codeMessageIds.has(messageId)
                )
            ).map(keyword => ({
                keyword: keyword.value,
                supportingPassageCount: keyword.messageIds.length,
                supportingParticipantCount: new Set(
                    (item.evidence || []).filter(evidence =>
                        keyword.messageIds.includes(evidence.messageId)
                    ).map(evidence => evidence.participant).filter(Boolean)
                ).size
            }))
        };
    });
}

async function discussAnalysis(req, supabaseClient, openaiClient) {
    if (!openaiClient) {
        throw new AnalysisError(500, "Server configuration is incomplete.");
    }

    const itemId = safeId(req.body?.itemId, "Analysis item");
    const message = typeof req.body?.message === "string"
        ? req.body.message.trim().slice(0, 4000)
        : "";
    if (!message) {
        throw new AnalysisError(400, "A discussion message is required.");
    }

    const storedItem = await loadItem(supabaseClient, itemId);
    const run = await loadRun(supabaseClient, storedItem.analysis_run_id);
    const workspace = await loadWorkspace(
        supabaseClient,
        analysisPeriod(run.period_start, run.period_end),
        runCompletionFilter(run),
        run.id
    );
    const item = workspace.items.find(entry => entry.id === itemId);

    if (!item) {
        throw new AnalysisError(404, "Analysis item was not found.");
    }

    const working = workingAnalysisFields(item);
    const conversation = safeDiscussionConversation(
        req.body?.conversation
    );
    conversation.push({ role: "researcher", content: message });

    const latestWorkbookLayers = ["themes", "codes", "keywords"]
        .map(stage => workspace.workbookImports.find(layer =>
            layer.stage === stage
        ))
        .filter(Boolean)
        .map(layer => ({
            id: layer.id,
            stage: layer.stage,
            sourceFilename: layer.source_filename,
            importedAt: layer.imported_at,
            sourceSelection: layer.source_selection,
            researcherDecisions: (layer.grouping_data?.items || [])
                .slice(0, 500)
                .map(entry => ({
                    stableId: entry.stableId,
                    participantCode: entry.participantCode,
                    content: entry.content,
                    group: entry.group,
                    groupOrder: entry.groupOrder,
                    itemOrder: entry.itemOrder,
                    note: entry.note
                }))
        }));

    return discussAnalysisWithResearcher(
        openaiClient,
        {
            theme: working.theme,
            codes: working.codes,
            keywords: working.keywords,
            focusCode: typeof req.body?.focusCode === "string"
                ? req.body.focusCode.trim() || null
                : null,
            codeKeywordGroups: discussionCodeKeywordGroups(item),
            researcherWorkbookLayers: latestWorkbookLayers,
            evidence: (item.evidence || []).filter(evidence =>
                evidence.included
            ).map(evidence => ({
                messageId: evidence.messageId,
                participantId: evidence.participant,
                language: evidence.language,
                originalText: evidence.originalText,
                englishTranslation: evidence.englishTranslation,
                attributedCodes: evidence.codes || [],
                associatedKeywords:
                    evidence.associatedSuggestions?.keywords || []
            }))
        },
        conversation
    );
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
            researcher_coded_phrases: commaSeparatedList(
                req.body?.codedPhrases
            ),
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

async function batchesFromStoredRun(supabaseClient, runId, messages) {
    const byBatch = new Map();
    const { data: batchRows, error } = await supabaseClient
        .from(ANALYSIS_TABLES.batches)
        .select("id, batch_number")
        .eq("analysis_run_id", runId);

    if (error) {
        throw new AnalysisError(500, "Stored batch provenance could not be loaded.");
    }

    const batchIdByNumber = new Map((batchRows || []).map(batch => [
        batch.batch_number,
        batch.id
    ]));

    messages.forEach(message => {
        if (!byBatch.has(message.batchNumber)) {
            byBatch.set(message.batchNumber, []);
        }

        byBatch.get(message.batchNumber).push(message);
    });

    return [...byBatch.entries()]
        .sort(([left], [right]) => left - right)
        .map(([batchNumber, batch]) => ({
            id: batchIdByNumber.get(batchNumber) || null,
            batchNumber,
            messages: prepareParticipantMessages(batch).messages
        }));
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
    const run = await loadRun(supabaseClient, item.analysis_run_id);

    if (item.status === "archived") {
        throw new AnalysisError(409, "Archived analysis items cannot collect evidence.");
    }

    const instruction = workingAnalysisFields(item);

    if (!instruction.theme) {
        throw new AnalysisError(400, "A working theme is required before collecting evidence.");
    }

    const batches = await batchesFromStoredRun(
        supabaseClient,
        item.analysis_run_id,
        await runMessages(supabaseClient, item.analysis_run_id)
    );
    const collectedEvidence = new Map();
    let invalidEvidenceIds = 0;
    let failures = 0;

    for (let index = 0; index < batches.length; index += 1) {
        try {
            const result = await collectEvidenceForBatch(
                openaiClient,
                batches[index].messages,
                instruction,
                { model: analysisModel(run.model) }
            );
            invalidEvidenceIds += result.invalidEvidenceIds;
            result.evidence.forEach(evidence => {
                if (!collectedEvidence.has(evidence.messageId)) {
                    collectedEvidence.set(evidence.messageId, {
                        batchId: batches[index].id,
                        codes: new Set()
                    });
                }

                evidence.codes.forEach(code => {
                    collectedEvidence.get(evidence.messageId).codes.add(code);
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
        .insert([...collectedEvidence].map(([messageId, provenance]) => ({
            analysis_item_id: itemId,
            batch_id: provenance.batchId,
            message_id: messageId,
            evidence_round: evidenceRound,
            source: "feedback_ai",
            included: true,
            code_attributions: [...provenance.codes]
        })));

    if (evidenceError) {
        throw new AnalysisError(500, "Collected evidence could not be saved.");
    }

    const contributingBatches = [...new Set(
        [...collectedEvidence.values()]
            .map(provenance => provenance.batchId)
            .filter(Boolean)
    )];

    if (contributingBatches.length) {
        const { error: batchLinkError } = await supabaseClient
            .from(ANALYSIS_TABLES.itemBatches)
            .upsert(contributingBatches.map(batchId => ({
                analysis_item_id: itemId,
                batch_id: batchId,
                analysis_run_id: item.analysis_run_id,
                relationship_type: "contributed_to"
            })), {
                onConflict: "analysis_item_id,batch_id",
                ignoreDuplicates: true
            });

        if (batchLinkError) {
            throw new AnalysisError(500, "Contributing batch provenance could not be saved.");
        }
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

async function batchForRunMessage(supabaseClient, runId, messageId) {
    const { data: batches, error: batchError } = await supabaseClient
        .from(ANALYSIS_TABLES.batches)
        .select("id")
        .eq("analysis_run_id", runId);

    if (batchError || !(batches || []).length) {
        return null;
    }

    const { data, error } = await supabaseClient
        .from(ANALYSIS_TABLES.batchMessages)
        .select("batch_id")
        .in("batch_id", batches.map(batch => batch.id))
        .eq("message_id", messageId)
        .maybeSingle();

    return error ? null : data?.batch_id || null;
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

        const batchId = await batchForRunMessage(
            supabaseClient,
            item.analysis_run_id,
            messageId
        );

        const { error } = await supabaseClient
            .from(ANALYSIS_TABLES.evidence)
            .insert({
                analysis_item_id: itemId,
                batch_id: batchId,
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

        if (batchId) {
            const { error: batchLinkError } = await supabaseClient
                .from(ANALYSIS_TABLES.itemBatches)
                .upsert({
                    analysis_item_id: itemId,
                    batch_id: batchId,
                    analysis_run_id: item.analysis_run_id,
                    relationship_type: "contributed_to"
                }, {
                    onConflict: "analysis_item_id,batch_id",
                    ignoreDuplicates: true
                });

            if (batchLinkError) {
                throw new AnalysisError(500, "Manual evidence batch provenance could not be saved.");
            }
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
            confirmed_coded_phrases: confirmed.codedPhrases,
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
        .select("id, analysis_run_id, status, confirmed_theme, confirmed_codes, confirmed_coded_phrases, confirmed_keywords, confirmed_evidence_message_ids, confirmed_note, confirmed_statistics, confirmed_statistics_calculated_at, confirmed_working_revision, confirmed_at, changed_since_confirmation")
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
            codedPhrases: item.confirmed_coded_phrases,
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
            const completionFilter = analysisCompletionFilter(
                req.query?.completion
            );
            return res.status(200).json(await loadWorkspace(
                supabaseClient,
                period,
                completionFilter,
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

        if (action === "discuss") {
            return res.status(200).json(await discussAnalysis(
                req,
                supabaseClient,
                openaiClient
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
            runCompletionFilter(run),
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
