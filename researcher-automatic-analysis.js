(function loadAutomaticAnalysisScripts() {
    "use strict";

    const legacy = document.createElement("script");
    legacy.src = "researcher-automatic-analysis-legacy.js?version=20260829-server-ranked-v11";
    legacy.onload = () => {
        const completeExport = document.createElement("script");
        completeExport.src = "researcher-complete-export.js?version=20260829-frequency-ranked-export-v3";
        document.body.appendChild(completeExport);
    };
    document.body.appendChild(legacy);
}());
