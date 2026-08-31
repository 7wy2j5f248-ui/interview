(function initializeCompleteAnalysisExport() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const originalButton = document.getElementById("automaticAnalysisDownloadButton");
    const lockButton = document.getElementById("automaticAnalysisLockButton");
    const status = document.getElementById("automaticAnalysisStatus");

    if (!originalButton) return;

    const button = originalButton.cloneNode(true);
    button.id = originalButton.id;
    button.textContent = "Download complete Excel analysis";
    button.title = "Downloads every active case in one Excel workbook with separate MU, CO, CA, and TH structures; the 100-case dashboard page size does not limit this export.";
    originalButton.replaceWith(button);

    if (lockButton) {
        lockButton.textContent = "Lock researcher access";
        lockButton.title = "Removes the researcher token from this browser session and hides the analysis workspace until it is unlocked again.";
    }

    async function downloadCompleteWorkbook() {
        const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
        if (!token) {
            status.textContent = "Unlock the analysis workspace before downloading.";
            status.className = "errorMessage";
            return;
        }

        button.disabled = true;
        const oldLabel = button.textContent;
        button.textContent = "Preparing complete Excel…";
        status.textContent = "Preparing the complete corpus. MU, CO, CA, and TH identifiers remain in headers while analytical cells contain substantive content only.";
        status.className = "muted";

        try {
            const response = await fetch("/api/automatic-analysis-ranked-export", {
                cache: "no-store",
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(
                    data.error || "The complete case-analysis Excel export could not be generated."
                );
            }

            const blob = await response.blob();
            const disposition = response.headers.get("Content-Disposition") || "";
            const filename = disposition.match(/filename="([^"]+)"/)?.[1]
                || "PLI-complete-case-analysis.xlsx";
            const caseCount = response.headers.get("X-PLI-Case-Count");
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);

            status.textContent = caseCount
                ? `Complete Excel downloaded: ${caseCount} active cases.`
                : "Complete Excel analysis downloaded.";
            status.className = "muted";
        } catch (error) {
            status.textContent = error.message;
            status.className = "errorMessage";
        } finally {
            button.disabled = false;
            button.textContent = oldLabel;
        }
    }

    button.addEventListener("click", downloadCompleteWorkbook);
}());
