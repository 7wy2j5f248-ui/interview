import { createHash, randomUUID } from "node:crypto";
import { normalizeAnalysisModel } from "./modelConfiguration.js";

export const CASE_BOUND_ANALYSIS_VERSION = "case-bound-stage1-v3";
export const CASE_BOUND_PROMPT_VERSION =
    "case-bound-participant-info-mu-co-ca-th-v3";
export const CASE_BOUND_CONTRACT_VERSION = "pli-case-bound-analysis-v5";
export const STAGE2A_PROMPT_VERSION = "whole-cohort-hco-v2";
export const STAGE2B_PROMPT_VERSION = "whole-cohort-hca-v2";
export const STAGE2C_PROMPT_VERSION = "whole-cohort-hth-v2";

export const STAGE1_REASONING_EFFORTS = Object.freeze([
    "none", "minimal", "low", "medium", "high", "xhigh"
]);

export const STAGE1_GLOBAL_RULES = Object.freeze([
    "Analyze exactly one completed interview case independently. Do not use another case, a corpus vocabulary, or any earlier analytical output.",
    "Use only the frozen English analytical transcript supplied for this case. Interviewer turns provide conversational context; Meaning Units come only from participant turns.",
    "A Meaning Unit must be participant-specific, substantive, semantically coherent, and copied exactly from its cited English participant turn or turns. Exclude greetings, courtesies, generic acknowledgements, and empty conversational filler.",
    "Interview-protocol deviations are provenance about interviewer performance and do not invalidate substantive participant responses.",
    "Build one connected bottom-up case analysis: Meaning Units to Preliminary Codes to Preliminary Categories to Preliminary Tentative Themes.",
    "Verify upward semantic continuity: each CO must accurately represent its linked MU or MUs, each CA must coherently summarize its linked CO or COs, and each TH must be meaningfully grounded in its linked CA or CAs. An unrelated, contradictory, or unsupported link is incorrect.",
    "Do not force a number of MUs, COs, CAs, or THs. Do not standardize terminology across cases in Stage 1.",
    "Do not add unsupported facts, motives, causes, diagnoses, theories, or conclusions.",
    "All analytical output is English. All MU, CO, CA, and TH identifiers are local to this case and begin at 1; their complete identity is the case ID plus the local ID.",
    "Complete the separate participant_information section from explicit participant evidence in this frozen case. Report demographic values in English, cite the exact supporting participant turn or turns, use null with no sources when information was not stated, and never guess. Participant information remains separate from the MU to CO to CA to TH analysis.",
    "Return one complete connected report with no blank MU, CO, CA, or TH rows. Do not provide a second analysis, quality score, validation report, repair, or recommendation to rerun."
]);

export const STAGE1_ANALYTICAL_DEFINITIONS = Object.freeze({
    meaningUnit: "A Meaning Unit is a semantically coherent, participant-specific piece of substantive information that is analytically relevant to the research project and copied exactly from its cited English participant turn or turns. Unrelated fragments may not be concatenated into a Meaning Unit.",
    preliminaryCode: "A Preliminary Code is a concise, intelligible analytical label representing a coherent meaning in one or more linked Meaning Units in this case. It must not introduce meaning unsupported by those Meaning Units.",
    preliminaryCategory: "A Preliminary Category is a coherent higher-level analytical grouping of one or more linked Preliminary Codes in this case. It must identify a recognizable analytical area without exceeding the Codes that support it.",
    preliminaryTentativeTheme: "A Preliminary Tentative Theme is an intelligible participant-specific pattern of meaning connecting one or more linked Preliminary Categories in this case. It may synthesize beyond simple restatement, but must remain grounded in what this case supports.",
    connectedStructure: "The four arrays are synchronized views of one model-produced hierarchy. Every CO cites its supporting MU IDs, every CA cites its supporting CO IDs, and every TH cites its supporting CA IDs. Software never infers, repairs, remaps, or regenerates those analytical relationships."
});

export const PLI_CASE_BOUND_SYSTEM_CONTRACT = Object.freeze({
    stage1: Object.freeze([
        "A formally completed interview case automatically freezes its authoritative source and enters Stage 1 under the active researcher-approved configuration.",
        "Each Stage 1 attempt analyzes exactly one frozen case with exactly one researcher-selected provider and model.",
        "The complete assembled provider request is frozen before submission, and the exact provider response is frozen immediately upon receipt before presentation processing.",
        "No validator AI, reviewer AI, repair AI, monitor AI, gatekeeper AI, fallback model, substitute model, or second analytical call may judge, change, complete, correct, or replace the selected model's output.",
        "Run status is determined only from objective provider or technical completion information; qualitative adequacy never determines completion.",
        "A provider-completed response does not complete the Stage 1 case until the complete workbook source for its separate Participant Information and MU to CO to CA to TH analysis has been stored. The authoritative researcher-facing Stage 1 report is one deterministic Excel workbook containing every case in the completed researcher-defined cohort, with Participant Information and Meaning Units on separate worksheets. Separate per-case workbooks are not Stage 1 reports. Annotated transcripts are supporting evidence and never substitute for the cohort workbook. Report submission is automatic and objective; researcher viewing, inspection, or approval is never required and never controls progression.",
        "A completed Stage 1 case is final and may never be reopened, rerun, repaired, reanalyzed, or replaced.",
        "A technically incomplete or failed attempt is preserved exactly, receives no automatic retry or recovery, and leaves the case unresolved until the researcher explicitly starts a separate attempt.",
        "An unresolved cohort member may not be dropped, bypassed, or silently treated as complete."
    ]),
    stage2: Object.freeze([
        "Stage 2 begins only after the researcher-defined cohort is closed and every cohort member has objectively completed Stage 1 with a complete stored report.",
        "The full cohort advances together; no individual case advances alone and no cohort member may be omitted.",
        "Stage 2A, Stage 2B, and Stage 2C are created as one execution set and start concurrently from three separately frozen whole-cohort sources.",
        "Stage 2A receives only compact preliminary Code references and Code labels; Stage 2B receives only compact preliminary Category references and Category labels; Stage 2C receives only compact preliminary Theme references and Theme statements.",
        "Participant identifiers, transcripts, Meaning Units, demographics, and every unrelated analytical layer are excluded from all Stage 2 model requests. Private database lineage retains the return path to each case-local source item.",
        "PLI imposes no Stage 2 output-token ceiling. Only the selected provider and model's native technical limits apply.",
        "Each Stage 2A, Stage 2B, and Stage 2C operation is finalized only when its readable report has been stored. Researcher viewing is optional and has no workflow effect.",
        "Each Stage 2 request and exact provider response is immutable. No validator, reviewer, repair, fallback, automatic retry, or analytical quality gate is permitted."
    ]),
    softwareAuthority: Object.freeze([
        "Ordinary software may freeze, hash, queue, send, retrieve, store, classify objective technical status, and display explicit provider fields.",
        "Ordinary software may not make a qualitative judgment, exclude difficult material, invent analytical content, or alter provider-produced analytical relationships."
    ])
});

const idPattern = "^(MU|CO|CA|TH)[0-9]{3,}$";

const sourceSchema = {
    type: "object",
    properties: {
        turn_id: { type: "string", pattern: "^T[0-9]{3,}$" },
        message_id: { type: "string", minLength: 1 },
        english_text: { type: "string", minLength: 1 }
    },
    required: ["turn_id", "message_id", "english_text"],
    additionalProperties: false
};

function participantInformationField(valueSchema) {
    return {
        type: "object",
        properties: {
            value: valueSchema,
            sources: { type: "array", items: sourceSchema }
        },
        required: ["value", "sources"],
        additionalProperties: false
    };
}

const participantInformationTextField = participantInformationField({
    type: ["string", "null"]
});
const participantInformationIntegerField = participantInformationField({
    type: ["integer", "null"]
});

export const CASE_BOUND_PARTICIPANT_INFORMATION_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        current_country: participantInformationTextField,
        current_region: participantInformationTextField,
        country_of_origin: participantInformationTextField,
        diaspora_status: participantInformationTextField,
        gender: participantInformationTextField,
        age: participantInformationIntegerField,
        birth_year: participantInformationIntegerField,
        birth_cohort: participantInformationTextField,
        youth_status: participantInformationTextField,
        occupation: participantInformationTextField,
        education_level: participantInformationTextField,
        social_identity: participantInformationTextField,
        additional_descriptors: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string", minLength: 1 },
                    value: { type: "string", minLength: 1 },
                    sources: {
                        type: "array", minItems: 1, items: sourceSchema
                    }
                },
                required: ["name", "value", "sources"],
                additionalProperties: false
            }
        }
    },
    required: [
        "current_country", "current_region", "country_of_origin",
        "diaspora_status", "gender", "age", "birth_year", "birth_cohort",
        "youth_status", "occupation", "education_level", "social_identity",
        "additional_descriptors"
    ],
    additionalProperties: false
});

export const CASE_BOUND_STAGE1_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        participant_information: CASE_BOUND_PARTICIPANT_INFORMATION_SCHEMA,
        meaning_units: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^MU[0-9]{3,}$" },
                    sources: { type: "array", minItems: 1, items: sourceSchema }
                },
                required: ["id", "sources"],
                additionalProperties: false
            }
        },
        preliminary_codes: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^CO[0-9]{3,}$" },
                    label: { type: "string", minLength: 1 },
                    meaning_unit_ids: {
                        type: "array", minItems: 1,
                        items: { type: "string", pattern: "^MU[0-9]{3,}$" }
                    }
                },
                required: ["id", "label", "meaning_unit_ids"],
                additionalProperties: false
            }
        },
        preliminary_categories: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^CA[0-9]{3,}$" },
                    label: { type: "string", minLength: 1 },
                    code_ids: {
                        type: "array", minItems: 1,
                        items: { type: "string", pattern: "^CO[0-9]{3,}$" }
                    }
                },
                required: ["id", "label", "code_ids"],
                additionalProperties: false
            }
        },
        preliminary_tentative_themes: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^TH[0-9]{3,}$" },
                    statement: { type: "string", minLength: 1 },
                    category_ids: {
                        type: "array", minItems: 1,
                        items: { type: "string", pattern: "^CA[0-9]{3,}$" }
                    }
                },
                required: ["id", "statement", "category_ids"],
                additionalProperties: false
            }
        }
    },
    required: [
        "participant_information", "meaning_units", "preliminary_codes",
        "preliminary_categories", "preliminary_tentative_themes"
    ],
    additionalProperties: false
});

export const CASE_BOUND_STAGE2A_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        harmonized_codes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^HCO[0-9]{3,}$" },
                    label: { type: "string", minLength: 1 },
                    source_codes: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", pattern: "^PC[0-9]{6,}$" }
                    }
                },
                required: ["id", "label", "source_codes"],
                additionalProperties: false
            }
        }
    },
    required: ["harmonized_codes"],
    additionalProperties: false
});

export const CASE_BOUND_STAGE2B_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        harmonized_categories: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^HCA[0-9]{3,}$" },
                    label: { type: "string", minLength: 1 },
                    source_categories: {
                        type: "array", minItems: 1,
                        items: { type: "string", pattern: "^PCA[0-9]{6,}$" }
                    }
                },
                required: ["id", "label", "source_categories"],
                additionalProperties: false
            }
        }
    },
    required: ["harmonized_categories"],
    additionalProperties: false
});

export const CASE_BOUND_STAGE2C_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        harmonized_themes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", pattern: "^HTH[0-9]{3,}$" },
                    statement: { type: "string", minLength: 1 },
                    source_themes: {
                        type: "array", minItems: 1,
                        items: { type: "string", pattern: "^PTH[0-9]{6,}$" }
                    }
                },
                required: ["id", "statement", "source_themes"],
                additionalProperties: false
            }
        }
    },
    required: ["harmonized_themes"],
    additionalProperties: false
});

function requiredText(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required.`);
    }
    return value.trim();
}

export function normalizeStage1ReasoningEffort(value) {
    const effort = requiredText(value, "Reasoning effort");
    if (!STAGE1_REASONING_EFFORTS.includes(effort)) {
        throw new Error("Choose a supported Stage 1 reasoning effort.");
    }
    return effort;
}

export function normalizeStage1OutputAllowance(value) {
    if (value === null || value === undefined || value === "") return null;
    const allowance = Number(value);
    if (!Number.isSafeInteger(allowance) || allowance < 1) {
        throw new Error("The Stage 1 output allowance must be a positive integer.");
    }
    return allowance;
}

export function sha256(value) {
    return createHash("sha256").update(
        typeof value === "string" ? value : JSON.stringify(value)
    ).digest("hex");
}

export function buildCaseBoundInstructions(configuration) {
    const rules = Array.isArray(configuration?.globalRules)
        ? configuration.globalRules : STAGE1_GLOBAL_RULES;
    const projectContext = configuration?.projectContext || {};
    const guidelines = typeof configuration?.analysisSpecificGuidelines === "string"
        ? configuration.analysisSpecificGuidelines.trim() : "";
    return [
        `PLI Stage 1 contract ${CASE_BOUND_CONTRACT_VERSION}.`,
        "BINDING STAGE 1 SYSTEM CONTRACT\n" +
            PLI_CASE_BOUND_SYSTEM_CONTRACT.stage1.map((rule, index) =>
                `${index + 1}. ${rule}`).join("\n"),
        "GLOBAL ANALYSIS RULES\n" + rules.map((rule, index) =>
            `${index + 1}. ${rule}`).join("\n"),
        "ANALYTICAL DEFINITIONS\n" + JSON.stringify(
            STAGE1_ANALYTICAL_DEFINITIONS, null, 2
        ),
        "PROJECT CONTEXT\n" + JSON.stringify(projectContext, null, 2),
        "ANALYSIS-SPECIFIC GUIDELINES\n" + (guidelines || "None supplied by the researcher."),
        "OUTPUT REQUIREMENT\nReturn only the defined participant_information plus MU -> CO -> CA -> TH structure. Keep participant information separate from the analysis. Each reported demographic value must cite its explicit participant source, and each analytical upper-level object must cite the explicit case-local IDs directly supporting it."
    ].join("\n\n");
}

export function buildCaseBoundStage1Request(sourceSnapshot, configuration, {
    requestId = randomUUID()
} = {}) {
    const model = normalizeAnalysisModel(configuration?.model);
    const reasoningEffort = normalizeStage1ReasoningEffort(
        configuration?.reasoningEffort
    );
    const maxOutputTokens = normalizeStage1OutputAllowance(
        configuration?.maxOutputTokens
    );
    const caseId = requiredText(sourceSnapshot?.caseNumber, "Case ID");
    const turns = sourceSnapshot?.analyticalTranscript;
    if (!Array.isArray(turns) || !turns.length) {
        throw new Error("The frozen analytical transcript is required.");
    }
    const caseConfiguration = {
        ...configuration,
        projectContext: sourceSnapshot?.projectContext
            || configuration?.projectContext || {}
    };
    const request = {
        model,
        store: true,
        background: true,
        ...(maxOutputTokens === null
            ? {} : { max_output_tokens: maxOutputTokens }),
        reasoning: { effort: reasoningEffort },
        text: {
            verbosity: "medium",
            format: {
                type: "json_schema",
                name: "pli_case_bound_stage1",
                strict: true,
                schema: CASE_BOUND_STAGE1_SCHEMA
            }
        },
        metadata: {
            pli_operation: "case_bound_stage1",
            pli_case_id: caseId,
            pli_request_id: requestId
        },
        input: [
            { role: "system", content: buildCaseBoundInstructions(caseConfiguration) },
            {
                role: "user",
                content: "FROZEN AUTHORITATIVE CASE SOURCE\n" + JSON.stringify({
                    case_id: caseId,
                    source_sha256: sourceSnapshot.sourceSha256,
                    analytical_transcript: turns
                })
            }
        ]
    };
    return { requestId, request, requestSha256: sha256(request) };
}

export function buildCaseBoundStage2ARequest(corpusSnapshot, configuration, {
    requestId = randomUUID()
} = {}) {
    const model = normalizeAnalysisModel(configuration?.model);
    const reasoningEffort = normalizeStage1ReasoningEffort(
        configuration?.reasoningEffort
    );
    const cohortId = requiredText(corpusSnapshot?.cohortId, "Cohort ID");
    const preliminaryCodes = corpusSnapshot?.preliminary_codes;
    if (!Array.isArray(preliminaryCodes) || !preliminaryCodes.length) {
        throw new Error("The frozen whole-cohort preliminary CO source is required.");
    }
    const request = {
        model,
        store: true,
        background: true,
        reasoning: { effort: reasoningEffort },
        text: {
            verbosity: "medium",
            format: {
                type: "json_schema",
                name: "pli_whole_cohort_harmonized_codes",
                strict: true,
                schema: CASE_BOUND_STAGE2A_SCHEMA
            }
        },
        metadata: {
            pli_operation: "whole_cohort_stage2a",
            pli_cohort_id: cohortId,
            pli_request_id: requestId
        },
        input: [{
            role: "user",
            content: [
                `PLI Stage 2A contract ${CASE_BOUND_CONTRACT_VERSION}.`,
                "Harmonize preliminary Codes across the entire closed cohort in one response.",
                "BINDING STAGE 2 SYSTEM CONTRACT\n" +
                    PLI_CASE_BOUND_SYSTEM_CONTRACT.stage2.map((rule, index) =>
                        `${index + 1}. ${rule}`).join("\n"),
                "Use only the supplied compact source reference plus preliminary Code label. Participant identifiers, transcript, Meaning Unit, demographic, Category, Theme, earlier analysis, and external knowledge are unavailable and prohibited.",
                "Map every compact source reference to exactly one Harmonized Code. The database retains case provenance outside this model request. Do not validate, repair, or revise Stage 1.",
                "FROZEN WHOLE-COHORT PRELIMINARY CO SOURCE\n" + JSON.stringify({
                    cohort_id: cohortId,
                    corpus_sha256: corpusSnapshot.corpusSha256,
                    preliminary_codes: preliminaryCodes
                })
            ].join("\n\n")
        }]
    };
    return { requestId, request, requestSha256: sha256(request) };
}

const parallelStage2Contracts = Object.freeze({
    "2b": {
        sourceField: "preliminary_categories",
        sourceLabel: "preliminary CA",
        sourceObject: "Category label",
        outputLabel: "Harmonized Category",
        schemaName: "pli_whole_cohort_harmonized_categories",
        schema: CASE_BOUND_STAGE2B_SCHEMA
    },
    "2c": {
        sourceField: "preliminary_themes",
        sourceLabel: "preliminary TH",
        sourceObject: "Theme statement",
        outputLabel: "Harmonized Theme",
        schemaName: "pli_whole_cohort_harmonized_themes",
        schema: CASE_BOUND_STAGE2C_SCHEMA
    }
});

export function buildCaseBoundParallelStage2Request(
    analysisLayer,
    corpusSnapshot,
    configuration,
    { requestId = randomUUID() } = {}
) {
    const contract = parallelStage2Contracts[analysisLayer];
    if (!contract) throw new Error("Choose Stage 2B or Stage 2C.");
    const model = normalizeAnalysisModel(configuration?.model);
    const reasoningEffort = normalizeStage1ReasoningEffort(
        configuration?.reasoningEffort
    );
    const cohortId = requiredText(corpusSnapshot?.cohortId, "Cohort ID");
    const preliminaryItems = corpusSnapshot?.[contract.sourceField];
    if (!Array.isArray(preliminaryItems) || !preliminaryItems.length) {
        throw new Error(`The frozen whole-cohort ${contract.sourceLabel} source is required.`);
    }
    const request = {
        model,
        store: true,
        background: true,
        reasoning: { effort: reasoningEffort },
        text: {
            verbosity: "medium",
            format: {
                type: "json_schema",
                name: contract.schemaName,
                strict: true,
                schema: contract.schema
            }
        },
        metadata: {
            pli_operation: `whole_cohort_stage${analysisLayer}`,
            pli_cohort_id: cohortId,
            pli_request_id: requestId
        },
        input: [{
            role: "user",
            content: [
                `PLI Stage ${analysisLayer.toUpperCase()} contract ${CASE_BOUND_CONTRACT_VERSION}.`,
                `Harmonize preliminary ${contract.sourceObject}s across the entire closed cohort in one response.`,
                "BINDING STAGE 2 SYSTEM CONTRACT\n" +
                    PLI_CASE_BOUND_SYSTEM_CONTRACT.stage2.map((rule, index) =>
                        `${index + 1}. ${rule}`).join("\n"),
                `Use only the supplied compact source reference plus ${contract.sourceObject}. Participant identifiers, transcript, Meaning Unit, demographic, and every other analytical layer are unavailable and prohibited.`,
                `Map every compact source reference to exactly one ${contract.outputLabel}. The database retains case provenance outside this model request. Do not validate, repair, or revise Stage 1.`,
                `FROZEN WHOLE-COHORT ${contract.sourceLabel.toUpperCase()} SOURCE\n` + JSON.stringify({
                    cohort_id: cohortId,
                    corpus_sha256: corpusSnapshot.corpusSha256,
                    [contract.sourceField]: preliminaryItems
                })
            ].join("\n\n")
        }]
    };
    return { requestId, request, requestSha256: sha256(request) };
}

export function providerResponseText(response) {
    if (typeof response?.output_text === "string") return response.output_text;
    return (response?.output || []).flatMap(item =>
        (item?.content || []).map(content => content?.text)
            .filter(value => typeof value === "string")
    ).join("");
}

export function classifyProviderOutcome(response) {
    if (response?.status === "completed") return "completed";
    if (response?.status === "incomplete") return "technically_incomplete";
    if (["queued", "in_progress"].includes(response?.status)) {
        return "provider_pending";
    }
    return "failed";
}

export function explicitStage1Presentation(rawText) {
    const parsed = JSON.parse(requiredText(rawText, "Exact provider output"));
    const requiredArrays = [
        "meaning_units", "preliminary_codes", "preliminary_categories",
        "preliminary_tentative_themes"
    ];
    if (!requiredArrays.every(field => Array.isArray(parsed?.[field]))) {
        throw new Error("The completed response does not expose the four defined Stage 1 arrays.");
    }
    if (!parsed.participant_information
        || typeof parsed.participant_information !== "object"
        || Array.isArray(parsed.participant_information)) {
        throw new Error(
            "The completed response does not expose the separate participant-information report."
        );
    }
    return parsed;
}

export function explicitStage2APresentation(rawText) {
    const parsed = JSON.parse(requiredText(rawText, "Exact provider output"));
    if (!Array.isArray(parsed?.harmonized_codes)) {
        throw new Error("The completed response does not expose Harmonized Codes.");
    }
    return parsed;
}

export function explicitParallelStage2Presentation(analysisLayer, rawText) {
    const parsed = JSON.parse(requiredText(rawText, "Exact provider output"));
    const field = analysisLayer === "2b" ? "harmonized_categories"
        : analysisLayer === "2c" ? "harmonized_themes" : null;
    if (!field || !Array.isArray(parsed?.[field])) {
        throw new Error(`The completed Stage ${String(analysisLayer).toUpperCase()} response does not expose its defined harmonized output.`);
    }
    return parsed;
}

export function stage1ContractSnapshot({
    projectContext,
    analysisSpecificGuidelines = "",
    provider,
    model,
    reasoningEffort,
    maxOutputTokens
}) {
    const snapshot = {
        contractVersion: CASE_BOUND_CONTRACT_VERSION,
        analysisVersion: CASE_BOUND_ANALYSIS_VERSION,
        promptVersion: CASE_BOUND_PROMPT_VERSION,
        provider: requiredText(provider, "Provider"),
        model: normalizeAnalysisModel(model),
        reasoningEffort: normalizeStage1ReasoningEffort(reasoningEffort),
        maxOutputTokens: normalizeStage1OutputAllowance(maxOutputTokens),
        globalRules: [...STAGE1_GLOBAL_RULES],
        projectContext,
        analysisSpecificGuidelines: String(analysisSpecificGuidelines || "").trim(),
        outputSchema: CASE_BOUND_STAGE1_SCHEMA
    };
    return { snapshot, snapshotSha256: sha256(snapshot) };
}

export function isCaseLocalAnalyticalId(value) {
    return typeof value === "string" && new RegExp(idPattern).test(value);
}
