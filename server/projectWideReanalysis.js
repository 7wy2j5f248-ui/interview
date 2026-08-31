function uuid(value) {
    return typeof value === "string"
        && /^[0-9a-f-]{36}$/i.test(value.trim())
        ? value.trim()
        : null;
}

function reason(value) {
    return typeof value === "string" ? value.trim().slice(0, 2_000) : "";
}

export async function cancelProjectWideReanalysisBatch(
    supabase,
    batchIdValue,
    cancellationReasonValue
) {
    const batchId = uuid(batchIdValue);
    const cancellationReason = reason(cancellationReasonValue);
    if (!batchId) throw new Error("Choose a valid project-wide run.");
    if (!cancellationReason) {
        throw new Error("Explain why this project-wide run should stop.");
    }
    const { data, error } = await supabase.rpc(
        "cancel_project_wide_reanalysis_batch",
        {
            p_batch_id: batchId,
            p_cancellation_reason: cancellationReason
        }
    );
    const cancelled = Array.isArray(data) ? data[0] || null : data || null;
    if (error || !cancelled) {
        throw new Error(
            error?.message
                || "This project-wide run could not be stopped. Refresh its status and try again."
        );
    }
    return {
        batchId: cancelled.batch_id,
        cancelledCaseCount: cancelled.cancelled_case_count,
        status: cancelled.batch_status,
        currentReportsPreserved: true,
        priorProposalsPreservedForAudit: true
    };
}
