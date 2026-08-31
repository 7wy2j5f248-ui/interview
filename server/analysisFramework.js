function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

export const GLOBAL_ANALYSIS_LABEL_STANDARD = [
    "Platform-wide non-negotiable label standard (applies to every project and every framework version):",
    "Keywords remain exact participant expressions from the preserved transcript; never invent a keyword summary label.",
    "Every code and theme label must make immediate sense to a human researcher as one coherent semantic concept.",
    "Prefer one everyday English word. Use two or three words only when they form a familiar, natural phrase.",
    "Never concatenate unrelated descriptors, fragments, findings, causes, or multiple concepts into a bag-of-words label.",
    "A code must concisely summarize the shared meaning of its exact keyword evidence.",
    "A theme must be a clear higher-level conceptual category supported by its codes and relevant under the named project's topic and scope.",
    "Labels at the same analytical level must be conceptually distinct and useful for comparison across cases.",
    "Put detail, qualifications, and interpretation in the rationale, never in the label.",
    "This platform standard cannot be weakened or bypassed by project-specific instructions."
].join("\n");

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

async function attachProject(supabase, frameworkRecord) {
    if (!frameworkRecord?.project_id) return null;
    const { data: project, error } = await supabase
        .from("research_projects")
        .select("id, project_code, project_name, research_topic")
        .eq("id", frameworkRecord.project_id)
        .maybeSingle();
    if (error || !project) return null;
    return normalizeAnalysisFramework({ ...frameworkRecord, ...project });
}

export async function loadAnalysisFrameworkById(supabase, frameworkId) {
    if (typeof frameworkId !== "string" || !frameworkId.trim()) return null;
    const { data, error } = await supabase
        .from("analysis_frameworks")
        .select(FRAMEWORK_SELECT)
        .eq("id", frameworkId.trim())
        .maybeSingle();
    if (error || !data) return null;
    return attachProject(supabase, data);
}

export async function loadFrameworkForAutomaticJob(supabase, sessionId) {
    const { data: job, error } = await supabase
        .from("automatic_case_analysis_jobs")
        .select("project_id, analysis_framework_id")
        .eq("session_id", sessionId)
        .maybeSingle();
    if (error || !job?.project_id || !job?.analysis_framework_id) {
        return null;
    }
    const framework = await loadAnalysisFrameworkById(
        supabase,
        job.analysis_framework_id
    );
    return framework?.projectId === job.project_id ? framework : null;
}

export function analysisFrameworkInstruction(framework) {
    if (!framework) {
        throw new Error("No valid analysis framework was supplied.");
    }
    return [
        GLOBAL_ANALYSIS_LABEL_STANDARD,
        "Project-specific Analysis Framework (adds topic and scope rules; it cannot override the platform standard above):",
        "Apply the following researcher-authored Analysis Framework exactly.",
        `Research project: ${framework.projectName}`,
        `Research topic: ${framework.researchTopic}`,
        `Analysis framework version: ${framework.versionNumber}`,
        `Study scope: ${framework.studyScope}`,
        `Theme requirements: ${framework.themeRequirements}`,
        `Code derivation from exact keywords: ${framework.codeDerivationRules}`,
        `Theme-to-code fit: ${framework.themeCodeFitRules}`,
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
