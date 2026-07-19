from pathlib import Path

# This wrapper narrows one ambiguous source replacement before executing the patch.
# Kept separate so the generated application diff remains easy to inspect.
original = Path(__file__).with_name("apply-configurable-model-selection.py")
source = original.read_text(encoding="utf-8")

old = '''replace_once(
    "api/analysis.js",
    ''' + "'''" + '''    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);

    if (item.status === "archived") {''' + "'''" + ''',
    ''' + "'''" + '''    const itemId = safeId(req.body?.itemId, "Analysis item");
    const item = await loadItem(supabaseClient, itemId);
    const run = await loadRun(supabaseClient, item.analysis_run_id);

    if (item.status === "archived") {''' + "'''" + '''
)'''

new = '''replace_once(
    "api/analysis.js",
    ''' + "'''" + '''async function collectEvidence(
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

    if (item.status === "archived") {''' + "'''" + ''',
    ''' + "'''" + '''async function collectEvidence(
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

    if (item.status === "archived") {''' + "'''" + '''
)'''

if source.count(old) != 1:
    raise RuntimeError(f"Expected one ambiguous analysis replacement block, found {source.count(old)}")

source = source.replace(old, new, 1)
exec(compile(source, str(original), "exec"), {
    "__file__": str(original),
    "__name__": "__main__"
})
