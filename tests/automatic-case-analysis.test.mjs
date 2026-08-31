import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    detectCompoundQuestionTurns,
    isConversationalCourtesy,
    isCategoryLabelShape,
    isConciseCodeLabelShape,
    isNaturalAnalyticLabelShape,
    validateAutomaticCaseAnalysis,
    validateAutomaticLabelQualityAudit,
    validateAutomaticCaseRelevanceAudit
} from "../server/analysisCore.js";

const migrationUrl = new URL(
    "../supabase/migrations/20260827143920_automatic_case_analysis_pipeline.sql",
    import.meta.url
);
const archiveMigrationUrl = new URL(
    "../supabase/migrations/20260827155638_add_case_archive_and_queue_wakeup.sql",
    import.meta.url
);
const demographicMigrationUrl = new URL(
    "../supabase/migrations/20260827164457_activate_v3_demographics_for_unfinished_cases.sql",
    import.meta.url
);
const historicalReprocessingMigrationUrl = new URL(
    "../supabase/migrations/20260827170200_reprocess_v2_reports_with_v3_demographics.sql",
    import.meta.url
);
const independentDemographicMigrationUrl = new URL(
    "../supabase/migrations/20260827171500_save_case_demographics_independently.sql",
    import.meta.url
);
const atomicReplacementGrantMigrationUrl = new URL(
    "../supabase/migrations/20260827171800_grant_atomic_report_supersede.sql",
    import.meta.url
);
const automaticTranslationMigrationUrl = new URL(
    "../supabase/migrations/20260827183500_backfill_completed_transcript_translations.sql",
    import.meta.url
);
const englishDemographicMigrationUrl = new URL(
    "../supabase/migrations/20260827190000_prefer_new_english_demographics.sql",
    import.meta.url
);
const independentTranslationQueueMigrationUrl = new URL(
    "../supabase/migrations/20260827182114_add_independent_transcript_translation_queue.sql",
    import.meta.url
);
const allSessionCaseCodesMigrationUrl = new URL(
    "../supabase/migrations/20260827211500_assign_case_codes_to_all_sessions.sql",
    import.meta.url
);
const incompleteSessionTimeoutMigrationUrl = new URL(
    "../supabase/migrations/20260827212500_mark_stale_sessions_incomplete.sql",
    import.meta.url
);
const hierarchyAuditMigrationUrl = new URL(
    "../supabase/migrations/20260831143424_theme_hierarchy_audit_provenance.sql",
    import.meta.url
);
const meaningUnitCategoryMigrationUrl = new URL(
    "../supabase/migrations/20260831173903_add_meaning_units_categories_autonomous_feedback.sql",
    import.meta.url
);

test("automatic case analysis retains exact meaning units and MU to CO to CA to TH hierarchy", () => {
    const passage = "I think about work before sleep, check work email in bed, worry about unfinished tasks, and plan tomorrow's work.";
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Pre-sleep work thoughts",
            rationale: "Thinking about work while trying to sleep.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: passage,
                anchor_expressions: ["think about work before sleep"]
            }]
        }, {
            label: "Bedtime email checking",
            rationale: "Checking work email in bed.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: passage,
                anchor_expressions: ["check work email in bed"]
            }]
        }, {
            label: "Unfinished-task worry",
            rationale: "Worry about unfinished work tasks.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: passage,
                anchor_expressions: ["worry about unfinished tasks"]
            }]
        }, {
            label: "Bedtime work planning",
            rationale: "Planning the next work day in bed.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: passage,
                anchor_expressions: ["plan tomorrow's work"]
            }]
        }],
        categories: [{
            label: "Work intruding into pre-sleep cognition",
            rationale: "Work thoughts and worry enter the pre-sleep period.",
            code_numbers: [1, 3]
        }, {
            label: "Bedtime work activity",
            rationale: "Work checking and planning continue in bed.",
            code_numbers: [2, 4]
        }],
        themes: [{
            label: "Work disrupting boundaries around sleep",
            rationale: "Work crosses both cognitive and behavioral sleep boundaries.",
            category_numbers: [1, 2]
        }],
        case_interpretation: "Work remains present during the participant's pre-sleep period."
    }, [{
        id: "message-1",
        originalText: passage,
        englishText: passage
    }]);

    assert.equal(result.complete, true);
    assert.deepEqual(result.codes[0].meaningUnits[0], {
        messageId: "message-1",
        exactText: passage,
        startOffset: 0,
        endOffset: passage.length,
        textSource: "original",
        anchors: ["think about work before sleep"]
    });
    assert.deepEqual(result.categories[0].codeNumbers, [1, 3]);
    assert.deepEqual(result.themes[0].categoryNumbers, [1, 2]);
});

test("automatic case analysis rejects paraphrased evidence and unassigned codes", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Weekend work",
            rationale: "Work schedule evidence.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "unpaid overtime",
                anchor_expressions: []
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "Work affects sleep."
    }, [{
        id: "message-1",
        originalText: "I work on weekends.",
        englishText: "I work on weekends."
    }]);

    assert.equal(result.complete, false);
    assert.equal(result.codes.length, 0);
    assert.ok(result.invalidEvidence > 0);
});

test("exact stored English translation is grounded with explicit provenance", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "night shift",
            rationale: "Night work disrupted the sleep schedule.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "The night shift disrupted my sleep.",
                anchor_expressions: ["night shift"]
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "Night work disrupted sleep."
    }, [{
        id: "message-1",
        originalText: "夜班打乱了我的睡眠。",
        englishTranslation: "The night shift disrupted my sleep."
    }]);

    assert.equal(result.complete, true);
    assert.equal(result.codes[0].meaningUnits[0].textSource, "english_translation");
    assert.equal(result.codes[0].meaningUnits[0].exactText, "The night shift disrupted my sleep.");
});

test("a substantive interview cannot pass as a one-code thin proposal", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
        id: `message-${index + 1}`,
        originalText: `Sleep evidence ${index + 1}`,
        englishTranslation: `Sleep evidence ${index + 1}`
    }));
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "bedtime",
            rationale: "The participant describes bedtime.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "Sleep evidence 1",
                anchor_expressions: ["Sleep evidence 1"]
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "The interview contains several distinct sleep accounts."
    }, messages);

    assert.equal(result.substantiveMessageCount, 6);
    assert.equal(result.fullHierarchyExpected, true);
    assert.equal(result.hierarchyCoverageComplete, false);
    assert.equal(result.complete, false);
});

test("model underscore formatting is normalized before hierarchy validation", () => {
    const text = "Night shifts delay sleep, naps reduce sleepiness, television fills silence, and the phone stays muted.";
    const result = validateAutomaticCaseAnalysis({
        codes: ["onset_with_living_alone", "short_naps", "background_tv", "phone_restraint"].map(label => ({
            label,
            rationale: "Transcript-supported sleep behavior.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: text,
                anchor_expressions: []
            }]
        })),
        categories: [{
            label: "schedule_disruption",
            rationale: "Work and naps shape sleep timing.",
            code_numbers: [1, 2]
        }, {
            label: "evening_media",
            rationale: "Media choices shape the bedtime setting.",
            code_numbers: [3, 4]
        }],
        themes: [{
            label: "active_management_of_sleep_disruption",
            rationale: "The participant manages work and media pressures around sleep.",
            category_numbers: [1, 2]
        }],
        case_interpretation: "The participant actively manages several sleep pressures."
    }, [{ id: "message-1", originalText: text }]);

    assert.equal(result.complete, true);
    assert.equal(result.codes[0].label, "onset living alone");
    assert.equal(result.categories[0].label, "schedule disruption");
    assert.equal(result.themes[0].label, "active management of sleep disruption");
});

test("overlong model code labels are deterministically reduced to three words", () => {
    const text = "I do not think technology changed my sleep.";
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "direct bed after call",
            rationale: "A supported bedtime transition.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: text,
                anchor_expressions: []
            }]
        }, {
            label: "no tech sleep change",
            rationale: "A supported negative technology assessment.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: text,
                anchor_expressions: []
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "The participant reports a bounded technology stance."
    }, [{ id: "message-1", originalText: text }]);

    assert.equal(result.codes[0].label, "direct bed call");
    assert.equal(result.codes[1].label, "no sleep change");
    assert.ok(result.codes.every(code => code.label.split(" ").length <= 3));
});

test("case re-analysis requires transcript, code, theme, and research-scope relevance", () => {
    const analysis = {
        codes: [{
            label: "AI non-use",
            rationale: "The participant does not use chatbots.",
            highlights: [{
                messageId: "message-1",
                exactText: "don't really mess with those",
                startOffset: 5,
                endOffset: 34
            }]
        }],
        themes: [{
            label: "Technology",
            rationale: "Technology adoption.",
            codeNumbers: [1]
        }]
    };
    const result = validateAutomaticCaseRelevanceAudit(analysis, {
        checks: [{
            code_number: 1,
            message_id: "message-1",
            exact_text: "don't really mess with those",
            transcript_grounded: true,
            supports_code: true,
            supports_theme: true,
            research_scope_relevant: false,
            explanation: "The participant did not connect chatbot use to sleep."
        }],
        overall_summary: "Exact but outside the sleep-analysis scope."
    });

    assert.equal(result.complete, false);
    assert.equal(result.rejectedEvidence.length, 1);
    assert.equal(result.checks[0].transcriptGrounded, true);
    assert.equal(result.checks[0].researchScopeRelevant, false);
});

test("global label audit rejects short but incoherent labels", () => {
    const analysis = {
        codes: [{
            label: "Routine Stable Longstanding",
            rationale: "A descriptor bundle rather than one natural concept.",
            highlights: [{ messageId: "message-1", exactText: "same routine" }]
        }, {
            label: "Rest pattern",
            rationale: "A second coherent code for theme support.",
            highlights: [{ messageId: "message-2", exactText: "same bedtime" }]
        }],
        categories: [],
        themes: [],
        unassignedCodeNumbers: [1, 2],
        unassignedCategoryNumbers: []
    };
    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks: [{
            kind: "code",
            number: 1,
            label: "Routine Stable Longstanding",
            natural_language: false,
            coherent_concept: false,
            conceptually_distinct: true,
            evidence_supported: true,
            topic_relevant: true,
            comparison_useful: false,
            has_multiple_children: true,
            semantic_coverage: true,
            higher_level_abstraction: true,
            patterned_meaning: true,
            explanation: "Three descriptors were concatenated without naming one concept."
        }, {
            kind: "code",
            number: 2,
            label: "Rest pattern",
            natural_language: true,
            coherent_concept: true,
            conceptually_distinct: true,
            evidence_supported: true,
            topic_relevant: true,
            comparison_useful: true,
            has_multiple_children: true,
            semantic_coverage: true,
            higher_level_abstraction: true,
            patterned_meaning: true,
            explanation: "A coherent code label."
        }],
        unsynthesized_checks: [{
            kind: "code",
            number: 1,
            label: "Routine Stable Longstanding",
            reason: "No defensible category is available."
        }, {
            kind: "code",
            number: 2,
            label: "Rest pattern",
            reason: "No defensible category is available."
        }],
        overall_summary: "Repair the code label."
    });

    assert.equal(isNaturalAnalyticLabelShape("Sleep routine"), true);
    assert.equal(isNaturalAnalyticLabelShape("Work and family"), false);
    assert.equal(isCategoryLabelShape("Sleep timing and duration"), true);
    assert.equal(isConciseCodeLabelShape("Sleep timing"), true);
    assert.equal(isConciseCodeLabelShape("Good_morning_sleep_quality"), false);
    assert.equal(isConciseCodeLabelShape("Long descriptive bedtime work pattern"), false);
    assert.equal(audit.complete, false);
    assert.equal(audit.rejectedLabels.length, 1);
    assert.match(audit.rejectedLabels[0].explanation, /concatenated/);
});

test("code style and comparison flags are advisory while evidence and coherence stay mandatory", () => {
    const analysis = {
        codes: [{
            label: "evening activity",
            rationale: "A coherent immediate pre-sleep activity.",
            highlights: [{ messageId: "message-1", exactText: "club call" }]
        }],
        categories: [],
        themes: [],
        unassignedCodeNumbers: [1],
        unassignedCategoryNumbers: []
    };
    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks: [{
            kind: "code",
            number: 1,
            label: "evening activity",
            natural_language: false,
            coherent_concept: true,
            conceptually_distinct: false,
            evidence_supported: true,
            topic_relevant: true,
            comparison_useful: false,
            has_multiple_children: true,
            semantic_coverage: true,
            higher_level_abstraction: true,
            patterned_meaning: true,
            explanation: "Valid in this case, but a broad comparison label."
        }],
        unsynthesized_checks: [{
            kind: "code",
            number: 1,
            label: "evening activity",
            reason: "No defensible category is available."
        }],
        overall_summary: "The code is valid with advisory comparison flags."
    });

    assert.equal(audit.complete, true);
    assert.equal(audit.checks[0].naturalLanguage, false);
    assert.equal(audit.checks[0].evidenceSupported, true);
    assert.equal(audit.checks[0].conceptuallyDistinct, false);
    assert.equal(audit.checks[0].comparisonUseful, false);
});

test("a familiar natural code is not rejected merely for being broad or informal", () => {
    const analysis = {
        codes: [{
            label: "social media",
            rationale: "A concise common term for the supported media behaviour.",
            highlights: [{ messageId: "message-1", exactText: "Instagram" }]
        }],
        categories: [],
        themes: [],
        unassignedCodeNumbers: [1],
        unassignedCategoryNumbers: []
    };
    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks: [{
            kind: "code",
            number: 1,
            label: "social media",
            natural_language: true,
            coherent_concept: false,
            conceptually_distinct: false,
            evidence_supported: true,
            topic_relevant: true,
            comparison_useful: false,
            has_multiple_children: true,
            semantic_coverage: true,
            higher_level_abstraction: true,
            patterned_meaning: true,
            explanation: "Familiar and supported, but broad."
        }],
        unsynthesized_checks: [{
            kind: "code",
            number: 1,
            label: "social media",
            reason: "No second related code is available."
        }],
        overall_summary: "The natural code remains valid with advisory flags."
    });

    assert.equal(audit.complete, true);
    assert.equal(audit.checks[0].coherentConcept, false);
});

test("category wording style is advisory while hierarchy quality stays mandatory", () => {
    const analysis = {
        codes: [
            { label: "bedtime", rationale: "Timing.", highlights: [] },
            { label: "sleep onset", rationale: "Onset.", highlights: [] }
        ],
        categories: [{
            label: "presleep routine",
            rationale: "Groups related bedtime behaviours.",
            codeNumbers: [1, 2]
        }],
        themes: [],
        unassignedCodeNumbers: [],
        unassignedCategoryNumbers: [1]
    };
    const checks = analysis.codes.map((code, index) => ({
        kind: "code",
        number: index + 1,
        label: code.label,
        natural_language: true,
        coherent_concept: true,
        conceptually_distinct: true,
        evidence_supported: true,
        topic_relevant: true,
        comparison_useful: true,
        has_multiple_children: true,
        semantic_coverage: true,
        higher_level_abstraction: true,
        patterned_meaning: true,
        explanation: "Accepted code."
    }));
    checks.push({
        kind: "category",
        number: 1,
        label: "presleep routine",
        natural_language: false,
        coherent_concept: true,
        conceptually_distinct: true,
        evidence_supported: true,
        topic_relevant: true,
        comparison_useful: true,
        has_multiple_children: true,
        semantic_coverage: true,
        higher_level_abstraction: true,
        patterned_meaning: true,
        explanation: "Technical wording, but a complete category."
    });
    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks,
        unsynthesized_checks: [{
            kind: "category",
            number: 1,
            label: "presleep routine",
            reason: "No second category supports a theme."
        }],
        overall_summary: "Style remains visible without blocking completion."
    });

    assert.equal(audit.complete, true);
    assert.equal(audit.checks[2].naturalLanguage, false);
});

test("one-code categories are rejected while the code remains a completed finding", () => {
    const analysis = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Sleep anxiety",
            rationale: "An evidence-supported code.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "worried about sleeping",
                anchor_expressions: ["worried about sleeping"]
            }]
        }],
        categories: [{
            label: "Sleep anxiety",
            rationale: "A one-to-one paraphrase of the only code.",
            code_numbers: [1]
        }],
        themes: [],
        case_interpretation: "The participant expressed sleep anxiety."
    }, [{
        id: "message-1",
        originalText: "I am worried about sleeping tonight."
    }]);

    assert.equal(analysis.complete, true);
    assert.equal(analysis.categories.length, 0);
    assert.deepEqual(analysis.unassignedCodeNumbers, [1]);
    assert.equal(analysis.rejectedCategoryAssignments.length, 1);

    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks: [{
            kind: "code",
            number: 1,
            label: "Sleep anxiety",
            natural_language: true,
            coherent_concept: true,
            conceptually_distinct: true,
            evidence_supported: true,
            topic_relevant: true,
            comparison_useful: true,
            has_multiple_children: true,
            semantic_coverage: true,
            higher_level_abstraction: true,
            patterned_meaning: true,
            explanation: "The code is a coherent evidence-supported concept."
        }],
        unsynthesized_checks: [{
            kind: "code",
            number: 1,
            label: "Sleep anxiety",
            reason: "No second semantically related code is available."
        }],
        overall_summary: "The code remains ungrouped for review."
    });

    assert.equal(audit.complete, true);
    assert.equal(audit.themeHierarchy.complete, true);
    assert.equal(audit.themeHierarchy.ungroupedCodes.length, 1);
});

test("each code and category has at most one hierarchy parent", () => {
    const messages = [1, 2, 3, 4].map(number => ({
        id: `message-${number}`,
        originalText: `sleep evidence ${number}`
    }));
    const analysis = validateAutomaticCaseAnalysis({
        codes: messages.map((message, index) => ({
            label: `Sleep ${index + 1}`,
            rationale: "One supported sleep concept.",
            meaning_unit_evidence: [{
                message_id: message.id,
                exact_text: message.originalText,
                anchor_expressions: [message.originalText]
            }]
        })),
        categories: [{
            label: "Sleep timing",
            rationale: "Related timing codes.",
            code_numbers: [1, 2]
        }, {
            label: "Sleep pattern",
            rationale: "Overlapping code assignment.",
            code_numbers: [1, 3]
        }, {
            label: "Sleep context",
            rationale: "Related context codes.",
            code_numbers: [3, 4]
        }],
        themes: [{
            label: "Timing shapes the sleep experience",
            rationale: "A patterned relationship.",
            category_numbers: [1, 2]
        }, {
            label: "Context shapes the sleep experience",
            rationale: "An overlapping category assignment.",
            category_numbers: [1, 2]
        }],
        case_interpretation: "A bounded hierarchy test."
    }, messages);

    assert.equal(analysis.categories.length, 2);
    assert.match(
        analysis.rejectedCategoryAssignments[0].reason,
        /at most one category parent/
    );
    assert.equal(analysis.themes.length, 1);
    assert.match(
        analysis.rejectedThemeAssignments[0].reason,
        /at most one theme parent/
    );
});

test("themes fail when their categories do not form a patterned meaning", () => {
    const analysis = {
        codes: [
            { label: "Online browsing", rationale: "Online evidence.", highlights: [] },
            { label: "Work schedule", rationale: "Work evidence.", highlights: [] }
        ],
        categories: [
            { label: "Online activity", rationale: "Browsing.", codeNumbers: [1, 2] },
            { label: "Work demands", rationale: "Scheduling.", codeNumbers: [1, 2] }
        ],
        themes: [{
            label: "Unrelated observations placed together",
            rationale: "Two unrelated categories were grouped superficially.",
            categoryNumbers: [1, 2]
        }],
        unassignedCodeNumbers: [],
        unassignedCategoryNumbers: []
    };
    const checks = analysis.codes.map((code, index) => ({
        kind: "code",
        number: index + 1,
        label: code.label,
        natural_language: true,
        coherent_concept: true,
        conceptually_distinct: true,
        evidence_supported: true,
        topic_relevant: true,
        comparison_useful: true,
        has_multiple_children: true,
        semantic_coverage: true,
        higher_level_abstraction: true,
        patterned_meaning: true,
        explanation: "Code label accepted."
    }));
    analysis.categories.forEach((category, index) => checks.push({
        kind: "category",
        number: index + 1,
        label: category.label,
        natural_language: true,
        coherent_concept: true,
        conceptually_distinct: true,
        evidence_supported: true,
        topic_relevant: true,
        comparison_useful: true,
        has_multiple_children: true,
        semantic_coverage: true,
        higher_level_abstraction: true,
        patterned_meaning: true,
        explanation: "Category accepted."
    }));
    checks.push({
        kind: "theme",
        number: 1,
        label: "Unrelated observations placed together",
        natural_language: true,
        coherent_concept: true,
        conceptually_distinct: true,
        evidence_supported: true,
        topic_relevant: false,
        comparison_useful: false,
        has_multiple_children: true,
        semantic_coverage: false,
        higher_level_abstraction: false,
        patterned_meaning: false,
        explanation: "The categories do not form one project-relevant pattern."
    });
    const audit = validateAutomaticLabelQualityAudit(analysis, {
        checks,
        unsynthesized_checks: [],
        overall_summary: "The theme must be regrouped or removed."
    });

    assert.equal(audit.complete, false);
    assert.equal(audit.themeHierarchy.complete, false);
    assert.equal(audit.themeHierarchy.checks[0].patternedMeaning, false);
});

test("compound interviewer questions remain visible as source-quality flags", () => {
    const flags = detectCompoundQuestionTurns([{
        id: "question-1",
        Speaker: "ai",
        Message: "Do you use social media? If so, how before bed?"
    }, {
        id: "answer-1",
        Speaker: "user",
        Message: "Not much."
    }]);

    assert.equal(flags.length, 1);
    assert.equal(flags[0].messageId, "question-1");
    assert.equal(flags[0].issueType, "compound_question");
    assert.match(flags[0].explanation, /does not rewrite the transcript/);
});

test("invalid extra evidence is omitted without discarding an otherwise exact case", () => {
    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Weekend work",
            rationale: "Work schedule evidence.",
            meaning_unit_evidence: [
                { message_id: "message-1", exact_text: "work on weekends", anchor_expressions: ["work on weekends"] },
                { message_id: "message-1", exact_text: "unpaid overtime", anchor_expressions: [] }
            ]
        }, {
            label: "Sleep timing",
            rationale: "Sleep timing evidence.",
            meaning_unit_evidence: [
                { message_id: "message-1", exact_text: "weekends", anchor_expressions: ["weekends"] }
            ]
        }],
        categories: [],
        themes: [],
        case_interpretation: "Weekend work affects this case."
    }, [{
        id: "message-1",
        originalText: "I often work on weekends.",
        englishText: "I often work on weekends."
    }]);

    assert.equal(result.complete, true);
    assert.equal(result.invalidEvidence, 1);
    assert.equal(result.codes[0].highlights.length, 1);
});

test("greetings and conversational courtesies are never retained as keywords", () => {
    assert.equal(isConversationalCourtesy("Hello!"), true);
    assert.equal(isConversationalCourtesy("谢谢"), true);
    assert.equal(isConversationalCourtesy("مرحبا"), true);
    assert.equal(isConversationalCourtesy("work on weekends"), false);

    const result = validateAutomaticCaseAnalysis({
        codes: [{
            label: "Greeting",
            rationale: "Routine conversation.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "Hello",
                anchor_expressions: ["Hello"]
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "A greeting occurred."
    }, [{
        id: "message-1",
        originalText: "Hello!",
        englishText: "Hello!"
    }]);

    assert.equal(result.complete, false);
    assert.equal(result.codes.length, 0);
});

test("automatic demographics retain only exact participant evidence and provenance", () => {
    const result = validateAutomaticCaseAnalysis({
        demographics: {
            current_country: {
                value: "Canada",
                message_id: "message-1",
                exact_text: "live in Canada",
                basis: "stated"
            },
            age: {
                value: 34,
                message_id: "message-1",
                exact_text: "I am 34",
                basis: "stated"
            },
            birth_year: {
                value: 1992,
                message_id: "message-1",
                exact_text: "born in 1991",
                basis: "stated"
            },
            occupation: {
                value: "Nurse",
                message_id: "message-1",
                exact_text: "work as a nurse",
                basis: "stated"
            }
        },
        codes: [{
            label: "Work schedule",
            rationale: "Shift work affects sleep.",
            meaning_unit_evidence: [{
                message_id: "message-1",
                exact_text: "night shifts",
                anchor_expressions: ["night shifts"]
            }]
        }],
        categories: [],
        themes: [],
        case_interpretation: "Night shifts affect sleep."
    }, [{
        id: "message-1",
        originalText: "I am 34, live in Canada, work as a nurse, and do night shifts. I was born in 1991.",
        englishText: "I am 34, live in Canada, work as a nurse, and do night shifts. I was born in 1991."
    }]);

    assert.equal(result.complete, true);
    assert.deepEqual(result.demographics, {
        current_country: "Canada",
        age: 34,
        additional_descriptors: { occupation: "Nurse" }
    });
    assert.equal(result.invalidDemographicEvidence, 1);
    assert.equal(
        result.descriptorSources.age.source_message_id,
        "message-1"
    );
    assert.equal(result.descriptorSources.age.raw_answer, "I am 34");
    assert.equal(result.descriptorSources.age.basis, "stated");
});

test("formal completion enqueues a strict FIFO atomic case pipeline", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");

    assert.match(migration, /interview_sessions_enqueue_case_analysis/);
    assert.match(migration, /source_completed_at[\s\S]*queued_at[\s\S]*session_id/);
    assert.match(migration, /automatic_case_analysis_fifo/);
    assert.match(migration, /complete_automatic_case_analysis/);
    assert.match(migration, /for update/);
    assert.match(migration, /enable row level security/);
    assert.match(chat, /if \(finalQuestionAnswered\)[\s\S]*scheduleAutomaticCaseAnalysis\(req\)/);
});

test("future reports preserve MU to CO to CA to TH lineage and unsynthesized findings", async () => {
    const migration = await readFile(meaningUnitCategoryMigrationUrl, "utf8");
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const review = await readFile(
        new URL("../researcher-automatic-review.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /qualitative_case_meaning_units/);
    assert.match(migration, /qualitative_case_categories/);
    assert.match(migration, /jsonb_array_length[\s\S]*codeNumbers[\s\S]*< 2/);
    assert.match(migration, /jsonb_array_length[\s\S]*categoryNumbers[\s\S]*< 2/);
    assert.match(dashboard, /analysis_hierarchy_audit/);
    assert.match(review, /MU → CO → CA → TH hierarchy provenance/);
    assert.match(review, /Codes retained without a defensible category/);
});

test("researcher dashboard uses four separate case, keyword, code, and theme forms", async () => {
    const html = await readFile(new URL("../researcher.html", import.meta.url), "utf8");
    const script = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(html, /Form 1 · Cases/);
    assert.match(html, /Form 2 · Keywords/);
    assert.match(html, /Form 3 · Codes/);
    assert.match(html, /Form 4 · Themes/);
    assert.doesNotMatch(html, /data-automatic-analysis-view="categories"/);
    assert.match(html, /Meaning units are first completed within every\s*individual case/);
    assert.match(html, /previous preliminary\s*analysis version/);
    assert.match(html, /stops before themes or any cross-case refinement/);
    assert.match(html, /TH = Theme · CA = Category ·\s*CO = Code · K = Keyword · MU = Meaning Unit/);
    assert.match(html, /data-automatic-analysis-view="incomplete"[^>]*>Needs attention/);
    assert.match(html, /data-automatic-analysis-view="archive"/);
    assert.match(html, /Download complete Excel analysis/);
    assert.match(html, /automaticCaseReportDialog/);
    assert.match(html, /automaticCaseArchiveButton/);
    assert.match(script, /function renderKeywords/);
    assert.match(script, /function renderCodes/);
    assert.match(script, /function renderThemes/);
    assert.match(script, /Linked category path/);
    assert.match(script, /Linked keyword\(s\)/);
    assert.match(script, /Exact transcript evidence/);
    assert.match(script, /Participant code:/);
    assert.match(script, /start_offset/);
    assert.match(script, /FORM_ONE_DEMOGRAPHIC_COLUMNS/);
    assert.match(
        script,
        /\["current_country", "Country of residence"\][\s\S]*\["country_of_origin", "Country of origin"\][\s\S]*\["gender", "Gender"\][\s\S]*\["age", "Age"\][\s\S]*\["occupation", "Occupation"\][\s\S]*\["education_level", "Education"\]/
    );
    assert.match(script, /\["current_region", "Region of residence"\]/);
    assert.match(script, /\["diaspora_status", "Diaspora status"\]/);
    assert.match(script, /\["birth_year", "Year of birth"\]/);
    assert.match(script, /\["birth_cohort", "Birth cohort"\]/);
    assert.match(script, /\["youth_status", "Youth status"\]/);
    assert.match(script, /\["social_identity", "Social identity"\]/);
    assert.match(
        script,
        /\.\.\.COMPACT_IDENTIFIER_HEADERS,\s*"Link to transcript",\s*"Case report",\s*"Analysis status",\s*"Archive",\s*"AI discussion",\s*"Language",\s*\.\.\.FORM_ONE_DEMOGRAPHIC_COLUMNS/
    );
    assert.match(script, /transcriptUrl\(item\)/);
    assert.match(script, /URLSearchParams\(window\.location\.search\)\.get\("case"\)/);
    assert.match(script, /openRequestedTranscript\(\)/);
    assert.match(script, /Open case report/);
    assert.match(script, /function archiveCaseButton/);
    assert.match(script, /button\.textContent = caseRecord\.hasReport[\s\S]*?"Archive"/);
    assert.match(script, /setArchiveState\(caseRecord, true\)/);
    assert.match(script, /renderArchive/);
    assert.match(script, /maximumCodes/);
    assert.match(script, /maximumThemes/);
    assert.match(script, /codes\.map\(code => code\.code_label\)\.join/);
    assert.match(script, /themes\.map\(theme => theme\.theme_label\)\.join/);
    assert.match(script, /MU\/CO\/CA\/TH hierarchy/);
    assert.match(script, /preserves its transcript, report, language, demographic columns/);
    assert.match(
        script,
        /"Archived",\s*"Archive note",\s*"Link to transcript",\s*"Language",\s*\.\.\.FORM_ONE_DEMOGRAPHIC_COLUMNS/
    );
    assert.match(script, /Restore to active analysis/);
    assert.match(script, /action: shouldArchive \? "archive" : "restore"/);
    assert.match(script, /function casesForAnalysisForms/);
    assert.match(script, /leftCompleted \? -1 : 1/);
    assert.match(script, /participantCode\(left\)\.localeCompare/);
    assert.match(script, /function sessionNumber/);
    assert.match(script, /label: "P#"[\s\S]*label: "S#"/);
    assert.match(script, /participant-code order/);
    assert.match(script, /caseRecord\.hasReport/);
    assert.match(dashboard, /hasReport: Boolean\(report\)/);
    assert.doesNotMatch(script, /"Demographic data",\s*"Case report"/);
});

test("Needs attention keeps incomplete transcripts separate from the four analysis forms", async () => {
    const html = await readFile(new URL("../researcher.html", import.meta.url), "utf8");
    const script = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const migration = await readFile(allSessionCaseCodesMigrationUrl, "utf8");
    const timeoutMigration = await readFile(
        incompleteSessionTimeoutMigrationUrl,
        "utf8"
    );

    assert.match(html, /data-automatic-analysis-view="incomplete"/);
    assert.match(html, /automaticAnalysisIncompleteCount/);
    assert.match(script, /function renderIncomplete/);
    assert.match(script, /Why it needs attention/);
    assert.match(script, /Brief partial-case summary/);
    assert.match(script, /No keywords, codes, categories, or themes are assigned before formal completion/);
    assert.match(script, /requestedScope === "incomplete"/);
    assert.match(dashboard, /function incompleteCompletionRemark/);
    assert.match(dashboard, /function incompleteCaseSummary/);
    assert.match(dashboard, /\.eq\("completed", false\)/);
    assert.match(dashboard, /formal completion signal missing/);
    assert.match(dashboard, /participantResponseCount/);
    assert.match(dashboard, /session_status", \["timed_out", "abandoned"\]/);
    assert.match(migration, /ensure_session_case_code_mapping/);
    assert.match(migration, /from every interview session, complete or incomplete/);
    assert.match(timeoutMigration, /mark_stale_interview_sessions_incomplete/);
    assert.match(timeoutMigration, /pli-mark-incomplete-sessions/);
    assert.match(timeoutMigration, /\* \* \* \* \*/);
    assert.match(timeoutMigration, /session_status = 'timed_out'/);
});

test("researcher archive is durable, auditable, and excluded from future claims", async () => {
    const migration = await readFile(archiveMigrationUrl, "utf8");
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const api = await readFile(
        new URL("../api/automatic-analysis.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /add column archived_at timestamptz/);
    assert.match(migration, /automatic_case_analysis_archive_events/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /set_automatic_case_archive/);
    assert.match(
        migration,
        /claim_next_automatic_case_analysis[\s\S]*job\.archived_at is null/
    );
    assert.match(migration, /pli-automatic-case-analysis-wakeup/);
    assert.match(migration, /\* \* \* \* \*/);
    assert.match(migration, /https:\/\/intervu\.quest\/api\/loadDesign/);
    assert.match(dashboard, /scope === "archived"/);
    assert.match(dashboard, /set_automatic_case_archive/);
    assert.match(api, /\["archive", "restore"\]/);
});

test("v2 preserves superseded reports and restarts the FIFO queue", async () => {
    const migration = await readFile(
        new URL(
            "../supabase/migrations/20260827152027_refine_automatic_case_analysis_v2.sql",
            import.meta.url
        ),
        "utf8"
    );

    assert.match(migration, /superseded_at/);
    assert.match(migration, /where superseded_at is null/);
    assert.match(migration, /case-analysis-v2-no-conversational-courtesies/);
    assert.match(migration, /status = 'pending'/);
});

test("v3 saves evidenced demographics atomically without replacing completed reports", async () => {
    const migration = await readFile(demographicMigrationUrl, "utf8");
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const core = await readFile(
        new URL("../server/analysisCore.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /participant_descriptors as descriptor/);
    assert.match(migration, /descriptorSources/);
    assert.match(migration, /descriptor_sources/);
    assert.match(migration, /stored_demographics/);
    assert.match(migration, /case-analysis-v3-evidence-backed-demographics/);
    assert.match(migration, /where archived_at is null\s+and status <> 'completed'/);
    assert.doesNotMatch(migration, /update public\.qualitative_case_reports/);
    assert.match(migration, /from public, anon, authenticated/);
    assert.match(worker, /demographics: analysis\.demographics/);
    assert.match(worker, /descriptorSources: analysis\.descriptorSources/);
    assert.match(core, /source_message_id/);
    assert.match(core, /extraction_method: AUTOMATIC_CASE_ANALYSIS_VERSION/);
});

test("historical v2 reports remain active until an atomic v3 replacement succeeds", async () => {
    const migration = await readFile(
        historicalReprocessingMigrationUrl,
        "utf8"
    );

    assert.match(migration, /before insert on public\.qualitative_case_reports/);
    assert.match(migration, /superseded_at = now\(\)/);
    assert.match(migration, /new\.analysis_version/);
    assert.match(migration, /security invoker/);
    assert.match(migration, /from public, anon, authenticated/);
    assert.match(migration, /status = 'pending'/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.match(
        migration,
        /report\.analysis_version =\s*'case-analysis-v2-no-conversational-courtesies'/
    );
    assert.doesNotMatch(migration, /delete from public\.qualitative_case_reports/);
});

test("evidenced demographics survive an invalid replacement hierarchy", async () => {
    const migration = await readFile(
        independentDemographicMigrationUrl,
        "utf8"
    );
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /save_automatic_case_demographics/);
    assert.match(migration, /job\.status <> 'processing'/);
    assert.match(migration, /participant_descriptors as descriptor/);
    assert.match(migration, /descriptor_sources/);
    assert.match(migration, /to service_role/);
    assert.match(worker, /save_automatic_case_demographics/);
    assert.match(worker, /if \(!analysis\.complete/);
    assert.ok(
        worker.indexOf("save_automatic_case_demographics")
        < worker.indexOf("if (!analysis.complete")
    );
    assert.match(dashboard, /function mergedDemographics/);
    assert.match(dashboard, /demographics: mergedDemographics/);
});

test("atomic replacement grants only its two lineage columns", async () => {
    const migration = await readFile(
        atomicReplacementGrantMigrationUrl,
        "utf8"
    );

    assert.match(
        migration,
        /grant update \(superseded_at, superseded_reason\)/
    );
    assert.match(migration, /on public\.qualitative_case_reports/);
    assert.match(migration, /to service_role/);
    assert.doesNotMatch(migration, /grant update on/);
    assert.doesNotMatch(migration, /to anon|to authenticated/);
});

test("new automatic reports use English while preserving original meaning units", async () => {
    const core = await readFile(
        new URL("../server/analysisCore.js", import.meta.url),
        "utf8"
    );

    assert.match(core, /analytical report in English/);
    assert.match(core, /exact_text in the participant's original language/);
});

test("formal completion automatically translates before case analysis", async () => {
    const migration = await readFile(automaticTranslationMigrationUrl, "utf8");
    const worker = await readFile(
        new URL("../server/automaticCaseAnalysis.js", import.meta.url),
        "utf8"
    );
    const chat = await readFile(
        new URL("../api/chat.js", import.meta.url),
        "utf8"
    );
    const translation = await readFile(
        new URL("../server/messageTranslation.js", import.meta.url),
        "utf8"
    );

    assert.match(worker, /ensureEnglishTranslations/);
    assert.match(worker, /failOnError: true/);
    assert.ok(
        worker.indexOf("await ensureEnglishTranslations")
        < worker.indexOf("const analysis = await generateAutomaticCaseAnalysis")
    );
    assert.match(migration, /job\.archived_at is null/);
    assert.match(migration, /session\.completed = true/);
    assert.match(migration, /message\."Language"/);
    assert.match(migration, /message\."EnglishTranslation"/);
    assert.doesNotMatch(migration, /qualitative_case_reports/);
    assert.match(chat, /scheduleCompletedTranscriptTranslation/);
    assert.ok(
        chat.indexOf("scheduleCompletedTranscriptTranslation")
        < chat.indexOf("scheduleAutomaticCaseAnalysis(req)")
    );
    assert.match(translation, /\/api\/automatic-analysis/);
    assert.match(translation, /worker: "translation"/);
    assert.match(translation, /waitUntil\(fetch\(url/);
    assert.match(translation, /RESEARCHER_DASHBOARD_TOKEN/);
});

test("historical translations run from a durable queue independent of analysis", async () => {
    const migration = await readFile(
        independentTranslationQueueMigrationUrl,
        "utf8"
    );
    const worker = await readFile(
        new URL("../server/transcriptTranslationQueue.js", import.meta.url),
        "utf8"
    );
    const endpoint = await readFile(
        new URL("../api/automatic-analysis.js", import.meta.url),
        "utf8"
    );
    const loadDesign = await readFile(
        new URL("../api/loadDesign.js", import.meta.url),
        "utf8"
    );

    assert.match(migration, /automatic_transcript_translation_jobs/);
    assert.match(migration, /claim_next_transcript_translation/);
    assert.match(migration, /claim_transcript_translation_session/);
    assert.match(migration, /finish_transcript_translation/);
    assert.match(migration, /session\.completed = true/);
    assert.match(migration, /analysis_job\.archived_at is null/);
    assert.match(migration, /enable row level security/);
    assert.match(worker, /TRANSLATION_CHUNK_SIZE = 12/);
    assert.match(worker, /ensureEnglishTranslations/);
    assert.match(endpoint, /translation_independent_from_case_analysis/);
    assert.match(endpoint, /req\.body\?\.worker === "translation"/);
    assert.match(loadDesign, /scheduleTranscriptTranslationBackfill/);
});

test("new English demographics replace old display values without losing provenance", async () => {
    const migration = await readFile(englishDemographicMigrationUrl, "utf8");

    assert.match(
        migration,
        /current_country = coalesce\(\s*excluded\.current_country,\s*descriptor\.current_country/
    );
    assert.match(
        migration,
        /additional_descriptors =\s*descriptor\.additional_descriptors\s*\|\| excluded\.additional_descriptors/
    );
    assert.match(
        migration,
        /descriptor_sources =\s*descriptor\.descriptor_sources\s*\|\| excluded\.descriptor_sources/
    );
    assert.match(migration, /job\.archived_at is null/);
    assert.match(migration, /job\.status = 'completed'/);
    assert.match(migration, /lower\(coalesce\(session\.language, ''\)\) <> 'en'/);
    assert.match(migration, /report\.superseded_at is null/);
    assert.match(migration, /report\.demographics::text/);
    assert.doesNotMatch(migration, /delete from public\.qualitative_case_reports/);
});

test("automatic dashboard exposes every transcript independently of analysis completion", async () => {
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const script = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /session_id, participant_id, language/);
    assert.match(dashboard, /loadParticipantCodeMap/);
    assert.match(dashboard, /transcriptIdentity/);
    assert.doesNotMatch(dashboard, /\.select\([^)]*TranslationState/);
    assert.match(
        dashboard,
        /loadIncompleteDashboard[\s\S]*\.from\("interview_messages"\)/
    );
    assert.match(script, /button\.disabled = !caseRecord\.transcriptIdentity\?\.sessionId/);
    assert.match(script, /\/api\/messages\?session=/);
    assert.match(script, /Verified match/);
});

test("separate Cases and Keywords forms load every case and stored unit", async () => {
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );
    const script = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );
    const html = await readFile(
        new URL("../researcher.html", import.meta.url),
        "utf8"
    );

    assert.match(dashboard, /async function requireAllData/);
    assert.match(dashboard, /DATABASE_PAGE_SIZE = 1000/);
    assert.match(
        dashboard,
        /current_country, current_region, country_of_origin, diaspora_status, gender, age, birth_year, birth_cohort, youth_status, education_level, social_identity, additional_descriptors/
    );
    assert.match(
        dashboard,
        /qualitative_case_meaning_units[\s\S]*\.order\("report_id"[\s\S]*\.order\("unit_number"/
    );
    assert.match(script, /async function fetchDashboardPage/);
    assert.match(script, /const remainingPages = await fetchRemainingDashboardPages/);
    assert.match(script, /DASHBOARD_PAGE_CONCURRENCY = 4/);
    assert.match(script, /casesWithKeywords/);
    assert.match(script, /function renderKeywords/);
    assert.match(script, /function keywordExpressions/);
    assert.match(script, /Open exact evidence/);
    assert.match(script, /Framework \/ report provenance/);
    assert.match(html, /researcher-automatic-analysis\.js\?version=20260831-advanced-preliminary-v1/);
    assert.match(html, /automaticAnalysisGateStatus/);
    assert.match(script, /cache: "no-store"/);
    assert.match(script, /searchParams\.set\("fresh"/);
    assert.match(script, /unlockButton\.disabled = true/);
    assert.match(dashboard, /private, no-store, no-cache/);
    assert.match(dashboard, /generatedAt: new Date\(\)\.toISOString\(\)/);
});

test("automatic dashboard has compact cases, traceable meaning units, and a finite unlock wait", async () => {
    const html = await readFile(new URL("../researcher.html", import.meta.url), "utf8");
    const script = await readFile(
        new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
        "utf8"
    );
    const dashboard = await readFile(
        new URL("../server/caseAnalysisDashboard.js", import.meta.url),
        "utf8"
    );

    assert.match(script, /label: "P#", className: "analysisIdentifierColumn"/);
    assert.match(script, /label: "S#", className: "analysisIdentifierColumn"/);
    assert.match(script, /analysisExactKeywordCell/);
    assert.match(script, /unit\.exact_text/);
    assert.match(script, /unit\.message_id/);
    assert.match(
        script,
        /openTranscript\(\s*caseRecord,\s*highlight\.message_id/
    );
    assert.match(html, /analysisIdentifierColumn[\s\S]*min-width: 4\.25rem/);
    assert.match(html, /analysisEvidenceTextCell[\s\S]*min-width: 22rem/);
    assert.match(html, /keywordRecordsScroll[\s\S]*max-height: 42rem/);
    assert.match(dashboard, /enrichAnalysisHighlightSources/);
    assert.match(script, /DASHBOARD_REQUEST_TIMEOUT_MS = 20000/);
    assert.match(script, /new AbortController\(\)/);
    assert.match(script, /signal: controller\.signal/);
    assert.match(script, /dashboard request timed out\. Please try unlocking again/);
});

test("Forms 2 to 4 open transcript evidence and return to the same record", async () => {
    const [html, script, review] = await Promise.all([
        readFile(new URL("../researcher.html", import.meta.url), "utf8"),
        readFile(
            new URL("../researcher-automatic-analysis-legacy.js", import.meta.url),
            "utf8"
        ),
        readFile(
            new URL("../researcher-automatic-review.js", import.meta.url),
            "utf8"
        )
    ]);

    assert.match(html, /Return to analysis form/);
    assert.match(html, /Analytical abbreviations:/);
    assert.match(
        html,
        /<div class="tableScroll">[\s\S]*?<tbody id="languageSummaryBody">/
    );
    assert.match(script, /function firstEvidenceMessageId/);
    assert.match(script, /function rememberTranscriptOrigin/);
    assert.match(script, /function returnFromTranscript/);
    assert.match(script, /data-transcript-origin/);
    assert.match(script, /Open the annotated transcript evidence for this/);
    assert.match(script, /Return to \$\{transcriptReturnContext\.label\}/);
    assert.match(script, /trigger\?\.focus\(\{ preventScroll: true \}\)/);
    assert.doesNotMatch(
        review,
        /automaticAnalysisReview"\)\.scrollIntoView/
    );
    assert.match(review, /current form and scroll position were preserved/);
});

test("researcher analysis assets cannot be held on a stale cached version", async () => {
    const config = JSON.parse(await readFile(
        new URL("../vercel.json", import.meta.url),
        "utf8"
    ));
    const bySource = new Map(config.headers.map(rule => [rule.source, rule.headers]));

    ["/researcher.html", "/researcher-automatic-analysis.js"].forEach(source => {
        const cacheHeader = bySource.get(source)?.find(
            header => header.key.toLowerCase() === "cache-control"
        );
        assert.match(cacheHeader?.value || "", /no-store/);
    });
});
