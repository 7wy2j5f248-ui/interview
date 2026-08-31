function text(value) {
    return typeof value === "string" ? value.trim() : "";
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
    }, { data: active, error: activeError }] = await Promise.all([
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
            .select("project_id, framework_id, activated_at, activated_by")
    ]);
    if (projectError || frameworkError || activeError) {
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
        activeFrameworks: active || []
    };
}
