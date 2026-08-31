function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

export const GLOBAL_ANALYSIS_LABEL_STANDARD = [
    "Platform-wide non-negotiable label standard (applies to every project and every framework version):",
    "The report for each participant is completed independently before cross-case comparison. Evidence and assignments remain tied to that single case.",
    "A meaning unit is an exact coherent passage whose boundary follows meaning rather than punctuation. Optional anchors remain exact expressions inside that highlighted passage.",
    "The annotated transcript highlights the complete meaning unit, places its code above it, and preserves the upward code → category → theme path.",
    "A code must be supportable by its meaning units. Never introduce a cause, motive, diagnosis, social structure, consequence, or theoretical explanation absent from the underlying text.",
    "Codes, categories, and themes use common corpus-wide terminology when this case's own evidence supports it. Shared vocabulary never supplies missing case evidence.",
    "A category answers 'What is being described?' and groups at least two related codes into one firm descriptive phenomenon.",
    "A theme answers 'What patterned meaning links these observations?' and interprets at least two categories together.",
    "Themes are interpretive analytical results, not approval requests. Complete and publish the outcome without waiting for a researcher decision.",
    "If a firm code or category lacks enough related material for a defensible higher level, retain it as unsynthesized. Never force a category or theme.",
    "Every code, category, theme, and complete evidence chain must remain relevant under the named project's topic and scope.",
    "Labels at the same analytical level must be conceptually distinct and useful for comparison across cases.",
    "Researcher feedback begins a new completed analysis version; it never pauses or approves an in-progress automation run.",
    "This platform standard cannot be weakened or bypassed by project-specific instructions."
].join("\n");

function normalizeGlobalAnalysisRules(record) {
    if (!record?.id) return null;
    const versionNumber = Number(record.version_number);
    const rulesText = text(record.rules_text);
    if (!Number.isInteger(versionNumber) || versionNumber < 1 || !rulesText) {
        return null;
    }
    return {
        id: record.id,
        versionNumber,
        predecessorId: record.predecessor_id || null,
        rulesText,
        versionNotes: text(record.version_notes) || null,
        createdAt: record.created_at || null
    };
}

export async function loadActiveGlobalAnalysisRules(supabase) {
    const { data: active, error: activeError } = await supabase
        .from("active_global_analysis_rules")
        .select("rule_id, activated_at, activated_by")
        .eq("singleton", true)
        .maybeSingle();
    if (activeError || !active?.rule_id) return null;
    const { data: rules, error: rulesError } = await supabase
        .from("global_analysis_rules")
        .select("id, version_number, predecessor_id, rules_text, version_notes, created_at")
        .eq("id", active.rule_id)
        .maybeSingle();
    const normalized = rulesError ? null : normalizeGlobalAnalysisRules(rules);
    return normalized ? {
        ...normalized,
        activatedAt: active.activated_at || null,
        activatedBy: active.activated_by || null
    } : null;
}

export async function loadGlobalAnalysisRulesById(supabase, ruleId) {
    if (typeof ruleId !== "string" || !ruleId.trim()) return null;
    const { data, error } = await supabase
        .from("global_analysis_rules")
        .select("id, version_number, predecessor_id, rules_text, version_notes, created_at")
        .eq("id", ruleId.trim())
        .maybeSingle();
    return error ? null : normalizeGlobalAnalysisRules(data);
}

export async function listGlobalAnalysisRulesWorkspace(supabase) {
    const [{ data: rules, error: rulesError }, {
        data: active,
        error: activeError
    }] = await Promise.all([
        supabase
            .from("global_analysis_rules")
            .select("id, version_number, predecessor_id, rules_text, version_notes, created_at")
            .order("version_number", { ascending: false }),
        supabase
            .from("active_global_analysis_rules")
            .select("rule_id, activated_at, activated_by")
            .eq("singleton", true)
            .maybeSingle()
    ]);
    if (rulesError || activeError) {
        throw new Error("The global analysis-rules workspace could not be loaded.");
    }
    return {
        activeRuleId: active?.rule_id || null,
        activatedAt: active?.activated_at || null,
        rules: (rules || []).map(normalizeGlobalAnalysisRules).filter(Boolean)
    };
}

export function normalizeAnalysisFramework(record) {
    if (!record?.id || !record?.project_id) return null;
    const versionNumber = Number(record.version_number);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) return null;

    const framework = {
        id: record.id,
        projectId: record.project_id,
        versionNumber,
        predecessorId: record.predecessor_id || null,
        projectCode: text(record.project_code),
        projectName: text(record.project_name),
        researchTopic: text(record.research_topic),
        studyScope: text(record.study_scope),
        themeRequirements: text(record.theme_requirements),
        codeDerivationRules: text(record.code_derivation_rules),
        themeCodeFitRules: text(record.theme_code_fit_rules),
        inclusionRules: text(record.inclusion_rules),
        exclusionRules: text(record.exclusion_rules),
        provenanceExpectations: text(record.provenance_expectations),
        applicationScope: record.application_scope,
        versionNotes: text(record.version_notes) || null,
        createdAt: record.created_at || null
    };
    const required = [
        "projectName",
        "researchTopic",
        "studyScope",
        "themeRequirements",
        "codeDerivationRules",
        "themeCodeFitRules",
        "inclusionRules",
        "exclusionRules",
        "provenanceExpectations"
    ];
    return required.every(field => framework[field]) ? framework : null;
}

const FRAMEWORK_SELECT = [
    "id",
    "project_id",
    "version_number",
    "predecessor_id",
    "study_scope",
    "theme_requirements",
    "code_derivation_rules",
    "theme_code_fit_rules",
    "inclusion_rules",
    "exclusion_rules",
    "provenance_expectations",
    "application_scope",
    "version_notes",
    "created_at"
].join(", ");

async function attachProject(supabase, frameworkRecord, globalRuleId = null) {
    if (!frameworkRecord?.project_id) return null;
    const { data: project, error } = await supabase
        .from("research_projects")
        .select("id, project_code, project_name, research_topic")
        .eq("id", frameworkRecord.project_id)
        .maybeSingle();
    if (error || !project) return null;
    const [framework, globalAnalysisRules] = await Promise.all([
        Promise.resolve(normalizeAnalysisFramework({
            ...frameworkRecord,
            ...project
        })),
        globalRuleId
            ? loadGlobalAnalysisRulesById(supabase, globalRuleId)
            : loadActiveGlobalAnalysisRules(supabase)
    ]);
    return framework ? { ...framework, globalAnalysisRules } : null;
}

export async function loadAnalysisFrameworkById(
    supabase,
    frameworkId,
    globalRuleId = null
) {
    if (typeof frameworkId !== "string" || !frameworkId.trim()) return null;
    const { data, error } = await supabase
        .from("analysis_frameworks")
        .select(FRAMEWORK_SELECT)
        .eq("id", frameworkId.trim())
        .maybeSingle();
    if (error || !data) return null;
    return attachProject(supabase, data, globalRuleId);
}

export async function loadFrameworkForAutomaticJob(supabase, sessionId) {
    const { data: job, error } = await supabase
        .from("automatic_case_analysis_jobs")
        .select("project_id, analysis_framework_id, global_analysis_rule_id")
        .eq("session_id", sessionId)
        .maybeSingle();
    if (error || !job?.project_id || !job?.analysis_framework_id) {
        return null;
    }
    const framework = await loadAnalysisFrameworkById(
        supabase,
        job.analysis_framework_id,
        job.global_analysis_rule_id
    );
    return framework?.projectId === job.project_id ? framework : null;
}

function uniqueLabels(rows, key) {
    return [...new Set((rows || []).map(row => text(row?.[key])).filter(Boolean))]
        .slice(0, 250);
}

export async function loadSharedAnalysisVocabulary(
    supabase,
    projectId,
    { excludeReportId = null } = {}
) {
    if (!projectId) return { codes: [], categories: [], themes: [] };

    let reportQuery = supabase
        .from("qualitative_case_reports")
        .select("id")
        .eq("project_id", projectId)
        .is("superseded_at", null)
        .order("completed_at", { ascending: false })
        .limit(250);
    if (excludeReportId) reportQuery = reportQuery.neq("id", excludeReportId);
    const { data: reports, error: reportError } = await reportQuery;
    const reportIds = reportError ? [] : (reports || []).map(report => report.id);
    if (!reportIds.length) return { codes: [], categories: [], themes: [] };

    const [codeResult, categoryResult, themeResult] = await Promise.all([
        supabase
            .from("qualitative_case_codes")
            .select("code_label")
            .in("report_id", reportIds),
        supabase
            .from("qualitative_case_categories")
            .select("category_label")
            .in("report_id", reportIds),
        supabase
            .from("qualitative_case_themes")
            .select("theme_label")
            .in("report_id", reportIds)
    ]);

    return {
        codes: codeResult.error ? [] : uniqueLabels(codeResult.data, "code_label"),
        categories: categoryResult.error
            ? [] : uniqueLabels(categoryResult.data, "category_label"),
        themes: themeResult.error
            ? [] : uniqueLabels(themeResult.data, "theme_label")
    };
}

export function analysisFrameworkInstruction(framework) {
    if (!framework) {
        throw new Error("No valid analysis framework was supplied.");
    }
    return [
        `Global analysis rules v${
            framework.globalAnalysisRules?.versionNumber || "fallback"
        } (applies across projects):`,
        framework.globalAnalysisRules?.rulesText
            || GLOBAL_ANALYSIS_LABEL_STANDARD,
        "Project-specific Analysis Framework (adds topic and scope rules; it cannot override the platform standard above):",
        "Apply the following researcher-authored Analysis Framework exactly.",
        `Research project: ${framework.projectName}`,
        `Research topic: ${framework.researchTopic}`,
        `Analysis framework version: ${framework.versionNumber}`,
        `Study scope: ${framework.studyScope}`,
        `Theme requirements: ${framework.themeRequirements}`,
        `Meaning-unit and code derivation rules (legacy database field): ${framework.codeDerivationRules}`,
        "Category rule: group related text-supported codes into firm descriptive categories using common cross-case terminology.",
        `Category/theme fit and patterned-meaning guidance (legacy database field): ${framework.themeCodeFitRules}`,
        `Inclusion rules: ${framework.inclusionRules}`,
        `Exclusion rules: ${framework.exclusionRules}`,
        `Researcher-visible provenance: ${framework.provenanceExpectations}`,
        "Do not import assumptions from a different project or research topic."
    ].join("\n");
}

export async function listAnalysisFrameworkWorkspace(supabase) {
    const [{ data: projects, error: projectError }, {
        data: frameworks,
        error: frameworkError
    }, { data: active, error: activeError }, {
        data: reanalysisBatches,
        error: batchError
    }] = await Promise.all([
        supabase
            .from("research_projects")
            .select("id, project_code, project_name, research_topic, created_at")
            .order("created_at", { ascending: true }),
        supabase
            .from("analysis_frameworks")
            .select(FRAMEWORK_SELECT)
            .order("created_at", { ascending: false }),
        supabase
            .from("active_analysis_frameworks")
            .select("project_id, framework_id, activated_at, activated_by"),
        supabase
            .from("analysis_framework_reanalysis_batches")
            .select("id, project_id, analysis_framework_id, status, researcher_notes, eligible_case_count, queued_case_count, processing_case_count, proposal_ready_case_count, approved_case_count, rejected_case_count, failed_case_count, cancelled_case_count, requested_at, updated_at, completed_at, cancellation_requested_at, cancelled_at, cancellation_reason, cancelled_by")
            .order("requested_at", { ascending: false })
            .limit(30)
    ]);
    if (projectError || frameworkError || activeError || batchError) {
        throw new Error("The analysis-framework workspace could not be loaded.");
    }
    const projectById = new Map((projects || []).map(project => [
        project.id,
        project
    ]));
    const normalized = (frameworks || []).map(framework =>
        normalizeAnalysisFramework({
            ...framework,
            ...(projectById.get(framework.project_id) || {})
        })
    ).filter(Boolean);
    return {
        projects: projects || [],
        frameworks: normalized,
        activeFrameworks: active || [],
        reanalysisBatches: reanalysisBatches || []
    };
}
