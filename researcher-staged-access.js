(function initializeStagedResearcherAccess() {
    "use strict";

    const TOKEN_STORAGE_KEY = "researcherDashboardToken";
    const gate = document.getElementById("automaticAnalysisTokenGate");
    const workspace = document.getElementById("automaticAnalysisWorkspace");
    const input = document.getElementById("automaticAnalysisToken");
    const button = document.getElementById("automaticAnalysisUnlockButton");
    const status = document.getElementById("automaticAnalysisGateStatus");

    function reveal() {
        gate.hidden = true;
        workspace.hidden = false;
    }

    button.addEventListener("click", () => {
        const entered = input.value.trim();
        if (!entered) {
            status.textContent = "Enter the researcher dashboard token.";
            status.className = "errorMessage";
            return;
        }
        sessionStorage.setItem(TOKEN_STORAGE_KEY, entered);
        reveal();
    });

    const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    if (stored) {
        input.value = stored;
        reveal();
    }
}());
