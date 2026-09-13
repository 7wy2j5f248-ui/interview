function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function number(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function displayId(prefix, value, index) {
    const supplied = text(value);
    if (new RegExp(`^${prefix}\\d+$`, "iu").test(supplied)) {
        return supplied.toUpperCase();
    }
    const numeric = number(value, index + 1);
    return `${prefix}${numeric}`;
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function extractCompleteJsonArray(source, key) {
    if (typeof source !== "string" || !source) return [];
    const keyPosition = source.indexOf(`"${key}"`);
    if (keyPosition < 0) return [];
    const arrayPosition = source.indexOf("[", keyPosition);
    if (arrayPosition < 0) return [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = arrayPosition; index < source.length; index += 1) {
        const character = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === "[") depth += 1;
        else if (character === "]") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const result = JSON.parse(source.slice(arrayPosition, index + 1));
                    return array(result);
                } catch {
                    return [];
                }
            }
        }
    }
    return [];
}

function parsedArrays(rawText) {
    return {
        meaningUnits: extractCompleteJsonArray(rawText, "meaning_units"),
        codes: extractCompleteJsonArray(rawText, "preliminary_codes"),
        categories: extractCompleteJsonArray(rawText, "preliminary_categories"),
        themes: extractCompleteJsonArray(rawText, "preliminary_tentative_themes")
            .concat(extractCompleteJsonArray(rawText, "tentative_themes"))
    };
}

function normalizeTranscript(sourceSnapshot, storedMessages) {
    const frozen = array(sourceSnapshot?.source_json?.analyticalTranscript);
    if (frozen.length) {
        return frozen.map((message, index) => ({
            id: text(message.message_id) || `turn-${index + 1}`,
            turnId: text(message.turn_id) || `T${index + 1}`,
            speaker: text(message.speaker) || "speaker",
            language: text(message.language),
            originalText: text(message.original_text),
            englishText: text(message.english_text),
            timestamp: null
        }));
    }
    return array(storedMessages).map((message, index) => ({
        id: String(message.id || `message-${index + 1}`),
        turnId: `T${index + 1}`,
        speaker: ["user", "participant"].includes(
            text(message.Speaker).toLowerCase()
        ) ? "participant" : "interviewer",
        language: text(message.Language),
        originalText: text(message.Message),
        englishText: text(message.EnglishTranslation) || text(message.Message),
        timestamp: message.Timestamp || null
    }));
}

function normalizeStructuredReport({
    meaningUnits = [], codes = [], codeMeaningUnits = [], categories = [],
    categoryCodes = [], themes = [], themeCategories = []
}) {
    const muIdByRecord = new Map();
    const normalizedMeaningUnits = array(meaningUnits).map((item, index) => {
        const id = displayId("MU", item.id, index);
        if (item.recordId) muIdByRecord.set(String(item.recordId), id);
        const segments = array(item.segments).length
            ? item.segments.map(segment => ({
                messageId: text(segment.messageId),
                exactText: text(segment.exactText),
                textField: text(segment.textField) || null,
                startOffset: segment.startOffset !== null
                    && segment.startOffset !== undefined
                    && Number.isInteger(Number(segment.startOffset))
                    ? Number(segment.startOffset) : null,
                endOffset: segment.endOffset !== null
                    && segment.endOffset !== undefined
                    && Number.isInteger(Number(segment.endOffset))
                    ? Number(segment.endOffset) : null
            }))
            : [{
                messageId: text(item.messageId),
                exactText: text(item.exactText),
                textField: text(item.textField) || null,
                startOffset: item.startOffset !== null
                    && item.startOffset !== undefined
                    && Number.isInteger(Number(item.startOffset))
                    ? Number(item.startOffset) : null,
                endOffset: item.endOffset !== null
                    && item.endOffset !== undefined
                    && Number.isInteger(Number(item.endOffset))
                    ? Number(item.endOffset) : null
            }];
        return {
            id,
            exactText: segments.map(segment => segment.exactText)
                .filter(Boolean).join(" … "),
            segments
        };
    });
    const codeIdByRecord = new Map();
    const normalizedCodes = array(codes).map((item, index) => {
        const id = displayId("CO", item.id, index);
        if (item.recordId) codeIdByRecord.set(String(item.recordId), id);
        return {
            id,
            label: text(item.label) || "Unlabelled Code",
            meaningUnitIds: unique(array(item.meaningUnitIds).map(String)
                .map(value => muIdByRecord.get(value) || displayId("MU", value, 0))),
            storedMentionCount: Number(item.mentionCount) || null
        };
    });
    array(codeMeaningUnits).forEach(link => {
        const codeId = codeIdByRecord.get(String(link.codeRecordId));
        const meaningUnitId = muIdByRecord.get(String(link.meaningUnitRecordId));
        const code = normalizedCodes.find(item => item.id === codeId);
        if (code && meaningUnitId) {
            code.meaningUnitIds = unique([...code.meaningUnitIds, meaningUnitId]);
        }
    });

    const categoryIdByRecord = new Map();
    const normalizedCategories = array(categories).map((item, index) => {
        const id = displayId("CA", item.id, index);
        if (item.recordId) categoryIdByRecord.set(String(item.recordId), id);
        return {
            id,
            label: text(item.label) || "Unlabelled Category",
            codeIds: unique(array(item.codeIds).map(String)
                .map(value => codeIdByRecord.get(value) || displayId("CO", value, 0)))
        };
    });
    array(categoryCodes).forEach(link => {
        const categoryId = categoryIdByRecord.get(String(link.categoryRecordId));
        const codeId = codeIdByRecord.get(String(link.codeRecordId));
        const category = normalizedCategories.find(item => item.id === categoryId);
        if (category && codeId) category.codeIds = unique([...category.codeIds, codeId]);
    });

    const themeIdByRecord = new Map();
    const normalizedThemes = array(themes).map((item, index) => {
        const id = displayId("TH", item.id, index);
        if (item.recordId) themeIdByRecord.set(String(item.recordId), id);
        return {
            id,
            statement: text(item.statement) || "Unlabelled Tentative Theme",
            categoryIds: unique(array(item.categoryIds).map(String)
                .map(value => categoryIdByRecord.get(value) || displayId("CA", value, 0)))
        };
    });
    array(themeCategories).forEach(link => {
        const themeId = themeIdByRecord.get(String(link.themeRecordId));
        const categoryId = categoryIdByRecord.get(String(link.categoryRecordId));
        const theme = normalizedThemes.find(item => item.id === themeId);
        if (theme && categoryId) {
            theme.categoryIds = unique([...theme.categoryIds, categoryId]);
        }
    });

    const codeById = new Map(normalizedCodes.map(item => [item.id, item]));
    const categoryById = new Map(normalizedCategories.map(item => [item.id, item]));
    normalizedCodes.forEach(item => {
        item.mentionCount = item.storedMentionCount || item.meaningUnitIds.length;
        item.categoryIds = normalizedCategories
            .filter(category => category.codeIds.includes(item.id))
            .map(category => category.id);
        delete item.storedMentionCount;
    });
    normalizedCategories.forEach(item => {
        item.meaningUnitIds = unique(item.codeIds.flatMap(codeId =>
            codeById.get(codeId)?.meaningUnitIds || []));
        item.mentionCount = item.meaningUnitIds.length;
        item.themeIds = normalizedThemes
            .filter(theme => theme.categoryIds.includes(item.id))
            .map(theme => theme.id);
    });
    normalizedThemes.forEach(item => {
        item.codeIds = unique(item.categoryIds.flatMap(categoryId =>
            categoryById.get(categoryId)?.codeIds || []));
        item.meaningUnitIds = unique(item.categoryIds.flatMap(categoryId =>
            categoryById.get(categoryId)?.meaningUnitIds || []));
        item.mentionCount = item.meaningUnitIds.length;
    });
    return {
        meaningUnits: normalizedMeaningUnits,
        codes: normalizedCodes,
        categories: normalizedCategories,
        themes: normalizedThemes
    };
}

function oldRawReport(rawText) {
    const parsed = parsedArrays(rawText);
    return normalizeStructuredReport({
        meaningUnits: parsed.meaningUnits.map((item, index) => ({
            id: displayId("MU",
                item.id ?? item.meaning_unit_number ?? item.unit_number, index),
            exactText: item.exact_source_text ?? item.english_text ?? item.text,
            messageId: item.message_id,
            startOffset: item.start_offset,
            endOffset: item.end_offset
        })),
        codes: parsed.codes.map((item, index) => ({
            id: displayId("CO", item.id ?? item.code_number ?? item.number, index),
            label: item.code ?? item.code_label ?? item.label,
            meaningUnitIds: array(item.meaning_unit_numbers ?? item.meaning_unit_ids),
            mentionCount: item.occurrence_count
        })),
        categories: parsed.categories.map((item, index) => ({
            id: displayId("CA",
                item.id ?? item.category_number ?? item.number, index),
            label: item.category ?? item.category_label ?? item.label,
            codeIds: array(item.code_numbers ?? item.code_ids)
        })),
        themes: parsed.themes.map((item, index) => ({
            id: displayId("TH", item.id ?? item.theme_number
                ?? item.tentative_theme_number ?? item.number, index),
            statement: item.theme ?? item.theme_label ?? item.tentative_theme
                ?? item.statement ?? item.label,
            categoryIds: array(item.category_numbers ?? item.category_ids)
        }))
    });
}

function v2PresentationReport(presentation) {
    return normalizeStructuredReport({
        meaningUnits: array(presentation?.meaning_units).map(item => ({
            id: item.id,
            segments: array(item.sources).map(source => ({
                messageId: source.message_id,
                exactText: source.english_text,
                startOffset: source.start_offset,
                endOffset: source.end_offset,
                textField: source.text_field
            }))
        })),
        codes: array(presentation?.preliminary_codes).map(item => ({
            id: item.id,
            label: item.label,
            meaningUnitIds: item.meaning_unit_ids,
            mentionCount: item.mention_count
        })),
        categories: array(presentation?.preliminary_categories).map(item => ({
            id: item.id,
            label: item.label,
            codeIds: item.code_ids
        })),
        themes: array(presentation?.preliminary_tentative_themes).map(item => ({
            id: item.id,
            statement: item.statement,
            categoryIds: item.category_ids
        }))
    });
}

function transcriptFields(message, preferred = null) {
    const fields = [
        { name: "original", value: message.originalText || "" },
        { name: "english", value: message.englishText || "" }
    ].filter(item => item.value);
    const uniqueFields = fields.filter((item, index) =>
        fields.findIndex(candidate => candidate.value === item.value) === index);
    if (!preferred) return uniqueFields;
    return [...uniqueFields].sort((left, right) =>
        Number(right.name === preferred) - Number(left.name === preferred));
}

function overlaps(ranges, start, end) {
    return ranges.some(range => start < range.end && end > range.start);
}

function nextUnclaimedOccurrence(haystack, needle, ranges) {
    const exact = haystack.indexOf(needle);
    const searchable = exact >= 0 ? haystack : haystack.toLocaleLowerCase();
    const target = exact >= 0 ? needle : needle.toLocaleLowerCase();
    let from = 0;
    while (from <= searchable.length - target.length) {
        const start = searchable.indexOf(target, from);
        if (start < 0) return null;
        const end = start + needle.length;
        if (!overlaps(ranges, start, end)) return { start, end };
        from = start + 1;
    }
    return null;
}

function locateUnanchoredMeaningUnits(report, transcript) {
    const messagesById = new Map(transcript.map(message =>
        [String(message.id), message]));
    const claimed = new Map();
    const rangesFor = (message, field) => {
        const key = `${message.id}:${field}`;
        if (!claimed.has(key)) claimed.set(key, []);
        return claimed.get(key);
    };
    report.meaningUnits.forEach(unit => {
        unit.segments.forEach(segment => {
            const needle = segment.exactText
                .replace(/^[“”"'\s]+|[“”"'\s]+$/gu, "");
            if (!needle) return;
            const declaredMessage = messagesById.get(String(segment.messageId));
            if (declaredMessage && segment.startOffset !== null
                && segment.endOffset !== null) {
                for (const field of transcriptFields(
                    declaredMessage, segment.textField
                )) {
                    const actual = field.value.slice(
                        segment.startOffset, segment.endOffset
                    );
                    if (actual.trim() !== needle) continue;
                    segment.textField = field.name;
                    rangesFor(declaredMessage, field.name).push({
                        start: segment.startOffset,
                        end: segment.endOffset
                    });
                    return;
                }
            }

            const messages = declaredMessage
                ? [declaredMessage, ...transcript.filter(message =>
                    String(message.id) !== String(declaredMessage.id))]
                : transcript;
            for (const message of messages) {
                for (const field of transcriptFields(message, segment.textField)) {
                    const ranges = rangesFor(message, field.name);
                    const located = nextUnclaimedOccurrence(
                        field.value, needle, ranges
                    );
                    if (!located) continue;
                    segment.messageId = message.id;
                    segment.startOffset = located.start;
                    segment.endOffset = located.end;
                    segment.textField = field.name;
                    ranges.push(located);
                    return;
                }
            }
        });
    });
}

export function buildCaseInspection({
    caseNumber, sourceSnapshot, storedMessages, presentation, attempt,
    normalizedPilotReport, submittedReport
}) {
    const transcript = normalizeTranscript(sourceSnapshot, storedMessages);
    const report = normalizedPilotReport
        || (presentation ? v2PresentationReport(presentation) : null)
        || oldRawReport(attempt?.raw_model_output_text);
    locateUnanchoredMeaningUnits(report, transcript);
    const actualResponseSha256 = typeof attempt?.raw_model_output_text === "string"
        ? createHash("sha256").update(attempt.raw_model_output_text).digest("hex")
        : null;
    return {
        caseNumber,
        readOnly: true,
        affectsProgression: false,
        explanation: "This optional view presents stored evidence only. Opening, closing, or never opening it does not approve, reject, pause, resume, or otherwise affect Stage 1, the cohort barrier, or Stage 2.",
        transcript,
        report,
        provenance: {
            provider: submittedReport?.provider || null,
            model: submittedReport?.model || null,
            reasoningEffort: submittedReport?.reasoning_effort || null,
            providerStatus: submittedReport?.provider_status
                || attempt?.provider_status || null,
            attemptNumber: attempt?.attempt_number || null,
            sourceKind: submittedReport?.source_kind || null,
            reportSha256: submittedReport?.report_sha256 || null,
            sourceResponseSha256: submittedReport?.source_response_sha256 || null,
            sourceResponseHashMatches:
                Boolean(actualResponseSha256
                    && submittedReport?.source_response_sha256)
                && actualResponseSha256 === submittedReport.source_response_sha256,
            exactFrozenResponsePreserved: true,
            newAiCallForPresentation: false
        },
        counts: {
            messages: transcript.length,
            participantTurns: transcript.filter(item => item.speaker === "participant").length,
            meaningUnits: report.meaningUnits.length,
            codes: report.codes.length,
            categories: report.categories.length,
            themes: report.themes.length,
            linkedMeaningUnitMentions: report.codes.reduce(
                (total, item) => total + item.mentionCount, 0
            )
        }
    };
}

export function normalizePilotReport(rows) {
    if (!array(rows?.meaningUnits).length
        && !array(rows?.codes).length
        && !array(rows?.categories).length
        && !array(rows?.themes).length) return null;
    return normalizeStructuredReport({
        meaningUnits: rows.meaningUnits.map(item => ({
            recordId: item.id,
            id: `MU${item.unit_number}`,
            messageId: item.message_id,
            exactText: item.exact_source_text,
            textField: "original",
            startOffset: item.start_offset,
            endOffset: item.end_offset
        })),
        codes: rows.codes.map(item => ({
            recordId: item.id,
            id: `CO${item.code_number}`,
            label: item.code_label,
            mentionCount: item.occurrence_count
        })),
        codeMeaningUnits: rows.codeMeaningUnits.map(item => ({
            codeRecordId: item.code_id,
            meaningUnitRecordId: item.meaning_unit_id
        })),
        categories: rows.categories.map(item => ({
            recordId: item.id,
            id: `CA${item.category_number}`,
            label: item.category_label
        })),
        categoryCodes: rows.categoryCodes.map(item => ({
            categoryRecordId: item.category_id,
            codeRecordId: item.code_id
        })),
        themes: rows.themes.map(item => ({
            recordId: item.id,
            id: `TH${item.theme_number}`,
            statement: item.theme_label
        })),
        themeCategories: rows.themeCategories.map(item => ({
            themeRecordId: item.theme_id,
            categoryRecordId: item.category_id
        }))
    });
}
import { createHash } from "node:crypto";
