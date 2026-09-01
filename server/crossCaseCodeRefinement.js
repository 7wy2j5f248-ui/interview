const REFINEMENT_SCHEMA = {
    type: "object",
    properties: {
        decision: { type: "string", enum: ["equivalent", "distinct"] },
        existing_refined_code_id: { type: "string" },
        refined_label: { type: "string" },
        refined_definition: { type: "string" },
        rationale: { type: "string" }
    },
    required: [
        "decision", "existing_refined_code_id", "refined_label",
        "refined_definition", "rationale"
    ],
    additionalProperties: false
};

function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function responseText(response) {
    return response?.output_text
        || response?.output?.flatMap(item => item?.content || [])
            .find(item => typeof item?.text === "string")?.text
        || "";
}

function parsed(response, description) {
    try {
        return JSON.parse(responseText(response));
    } catch (error) {
        throw new Error(`${description} returned invalid structured data.`, {
            cause: error
        });
    }
}

function responseOptions(claim, schema, name, input) {
    return {
        model: claim.model,
        store: false,
        reasoning: { effort: claim.reasoning_effort, context: "current_turn" },
        text: {
            verbosity: "medium",
            format: { type: "json_schema", name, strict: true, schema }
        },
        input
    };
}

export function validatePreliminaryCodes(value, meaningUnits) {
    const validIds = new Set(meaningUnits.map(unit => unit.id));
    const covered = new Set();
    const problems = [];
    const codes = (Array.isArray(value?.preliminary_codes)
        ? value.preliminary_codes : []).map((raw, index) => {
        const label = text(raw?.label);
        const definition = text(raw?.definition);
        const rationale = text(raw?.rationale);
        const meaningUnitIds = [...new Set(
            (Array.isArray(raw?.meaning_unit_ids) ? raw.meaning_unit_ids : [])
                .map(text).filter(Boolean)
        )];
        if (!label || label.split(/\s+/u).length > 5) {
            problems.push(`CO${index + 1} needs a concise one-to-five-word label.`);
        }
        if (!definition || !rationale) {
            problems.push(`CO${index + 1} needs a definition and case-grounded rationale.`);
        }
        if (!meaningUnitIds.length
            || meaningUnitIds.some(id => !validIds.has(id))) {
            problems.push(`CO${index + 1} has invalid Meaning Unit provenance.`);
        }
        meaningUnitIds.forEach(id => covered.add(id));
        return { label, definition, rationale, meaningUnitIds };
    });
    if (!codes.length) problems.push("At least one preliminary Code is required.");
    const omitted = [...validIds].filter(id => !covered.has(id));
    if (omitted.length) {
        problems.push(`Meaning Units without a preliminary Code: ${omitted.join(", ")}.`);
    }
    return { complete: !problems.length, codes, problems };
}

async function loadPreliminarySource(supabase, claim) {
    const [
        { data: report, error: reportError },
        { data: meaningUnits, error: muError },
        { data: codes, error: codeError },
        { data: links, error: linkError }
    ] =
        await Promise.all([
            supabase.from("advanced_preliminary_case_reports")
                .select("id, case_number, session_id, project_id")
                .eq("id", claim.stage1_report_id).maybeSingle(),
            supabase.from("advanced_preliminary_meaning_units")
                .select("id, unit_number, message_id, exact_source_text, source_language, context_note")
                .eq("report_id", claim.stage1_report_id)
                .order("unit_number"),
            supabase.from("advanced_preliminary_codes")
                .select("id, code_number, code_label, definition, rationale")
                .eq("report_id", claim.stage1_report_id)
                .order("code_number"),
            supabase.from("advanced_preliminary_code_meaning_units")
                .select("code_id, meaning_unit_id")
                .eq("report_id", claim.stage1_report_id)
        ]);
    if (reportError || !report || muError || codeError || linkError
        || !meaningUnits?.length || !codes?.length) {
        throw new Error("The preserved preliminary case Codes and Meaning Units could not be loaded.");
    }
    const linksByCode = (links || []).reduce((map, item) => {
        if (!map.has(item.code_id)) map.set(item.code_id, []);
        map.get(item.code_id).push(item.meaning_unit_id);
        return map;
    }, new Map());
    const preliminaryCodes = codes.map(code => ({
        label: code.code_label,
        definition: code.definition,
        rationale: code.rationale,
        meaningUnitIds: linksByCode.get(code.id) || []
    }));
    const validated = validatePreliminaryCodes(
        { preliminary_codes: preliminaryCodes.map(code => ({
            label: code.label,
            definition: code.definition,
            rationale: code.rationale,
            meaning_unit_ids: code.meaningUnitIds
        })) },
        meaningUnits
    );
    if (!validated.complete) {
        throw new Error(
            `Stored preliminary Code lineage is invalid: ${validated.problems.join(" | ")}`
        );
    }
    return { report, meaningUnits, preliminaryCodes: validated.codes };
}

async function loadRefinementSource(supabase, claim) {
    const { data: preliminary, error: codeError } = await supabase
        .from("stage2_preliminary_codes")
        .select("id, case_number, code_number, code_label, definition, rationale")
        .eq("id", claim.preliminary_code_id).maybeSingle();
    if (codeError || !preliminary) {
        throw new Error("The preliminary Code could not be loaded.");
    }
    const { data: links, error: linkError } = await supabase
        .from("stage2_preliminary_code_evidence")
        .select("meaning_unit_id")
        .eq("preliminary_code_id", preliminary.id);
    const muIds = (links || []).map(item => item.meaning_unit_id);
    const { data: meaningUnits, error: muError } = muIds.length
        ? await supabase.from("advanced_preliminary_meaning_units")
            .select("id, message_id, exact_source_text, context_note")
            .in("id", muIds)
        : { data: [], error: null };
    const { data: refinedCodes, error: refinedError } = await supabase
        .from("stage2_refined_codes")
        .select("id, refined_code_number, refined_code_label, definition")
        .eq("run_id", claim.run_id)
        .order("refined_code_number");
    if (linkError || muError || refinedError) {
        throw new Error("Cross-case Code evidence or vocabulary could not be loaded.");
    }
    return { preliminary, meaningUnits: meaningUnits || [], refinedCodes: refinedCodes || [] };
}

export function validateRefinement(value, candidates) {
    const decision = value?.decision;
    const existingRefinedCodeId = text(value?.existing_refined_code_id) || "";
    const refinedLabel = text(value?.refined_label);
    const refinedDefinition = text(value?.refined_definition);
    const rationale = text(value?.rationale);
    const candidateIds = new Set(candidates.map(item => item.id));
    const problems = [];
    if (!rationale) problems.push("A semantic comparison rationale is required.");
    if (decision === "equivalent") {
        if (!candidateIds.has(existingRefinedCodeId)) {
            problems.push("An equivalent decision must name an existing refined Code.");
        }
    } else if (decision === "distinct") {
        if (!refinedLabel || refinedLabel.split(/\s+/u).length > 5
            || !refinedDefinition) {
            problems.push("A distinct decision needs a concise refined label and definition.");
        }
    } else problems.push("The decision must be equivalent or distinct.");
    return {
        complete: !problems.length,
        payload: {
            decision,
            existingRefinedCodeId,
            refinedLabel: refinedLabel || "Not used",
            refinedDefinition: refinedDefinition || "Not used",
            rationale
        },
        problems
    };
}

async function refineOneCode(openaiClient, claim, source) {
    const prompt = [
        "Perform only Cross-Case Code Refinement. Compare the current preliminary Code and its exact Meaning Unit evidence with the existing refined Code vocabulary derived from earlier cases.",
        "Choose equivalent only when the expressed meanings genuinely correspond. Similar wording is not enough. Do not merge analytically different meanings to reduce the vocabulary. If no justified equivalent exists, choose distinct and create a concise shared-ready refined Code.",
        "Do not alter Meaning Units. Do not generate Categories or Themes.",
        `Current preliminary Code (JSON): ${JSON.stringify(source.preliminary)}`,
        `Supporting Meaning Units (JSON): ${JSON.stringify(source.meaningUnits)}`,
        `Existing refined Codes (JSON): ${JSON.stringify(source.refinedCodes)}`
    ].join("\n\n");
    const response = await openaiClient.responses.create(responseOptions(
        claim,
        REFINEMENT_SCHEMA,
        "stage2_cross_case_code_refinement",
        [{ role: "system", content: prompt }]
    ));
    const result = validateRefinement(
        parsed(response, "Stage 2 cross-case Code refinement"),
        source.refinedCodes
    );
    if (!result.complete) {
        throw new Error(`Stage 2 refinement failed validation: ${result.problems.join(" | ")}`);
    }
    return {
        ...result,
        inputTokens: response?.usage?.input_tokens || 0,
        outputTokens: response?.usage?.output_tokens || 0
    };
}

async function fail(supabase, claim, error) {
    await supabase.rpc("fail_stage2_code_refinement", {
        p_phase: claim.phase,
        p_job_id: claim.job_id,
        p_error: error instanceof Error ? error.message : String(error)
    });
}

export async function processNextCrossCaseCodeRefinement(supabase, openaiClient) {
    const { data, error } = await supabase.rpc("claim_next_stage2_code_refinement");
    if (error) throw new Error("The next Stage 2 Code-refinement item could not be claimed.", { cause: error });
    const claim = Array.isArray(data) ? data[0] || null : data || null;
    if (!claim) return { claimed: false };
    try {
        if (claim.phase === "preliminary_code") {
            const source = await loadPreliminarySource(supabase, claim);
            const { data: saved, error: saveError } = await supabase.rpc(
                "complete_stage2_preliminary_case",
                {
                    p_job_id: claim.job_id,
                    p_payload: { preliminaryCodes: source.preliminaryCodes },
                    p_input_tokens: 0,
                    p_output_tokens: 0
                }
            );
            if (saveError || !saved) throw new Error("Stage 2 preliminary Codes were not saved.");
        } else {
            const source = await loadRefinementSource(supabase, claim);
            const result = await refineOneCode(openaiClient, claim, source);
            const { data: saved, error: saveError } = await supabase.rpc(
                "complete_stage2_refined_code",
                {
                    p_job_id: claim.job_id,
                    p_payload: result.payload,
                    p_model: claim.model,
                    p_input_tokens: result.inputTokens,
                    p_output_tokens: result.outputTokens
                }
            );
            if (saveError || !saved) throw new Error("The refined Code assignment was not saved.");
        }
        return { claimed: true, completed: true, phase: claim.phase, runId: claim.run_id };
    } catch (error) {
        await fail(supabase, claim, error);
        console.error("Stage 2 Code refinement failed", {
            phase: claim.phase,
            jobId: claim.job_id,
            error: error instanceof Error ? error.message : String(error)
        });
        return { claimed: true, completed: false, phase: claim.phase, runId: claim.run_id };
    }
}
