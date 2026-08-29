(function loadAutomaticAnalysisScripts() {
    "use strict";

    const legacy = document.createElement("script");
    legacy.src = "researcher-automatic-analysis-legacy.js?version=20260827-incomplete-form-v10";
    legacy.onload = () => {
        const completeExport = document.createElement("script");
        completeExport.src = "researcher-complete-export.js?version=20260829-complete-export-v1";
        document.body.appendChild(completeExport);
    };
    document.body.appendChild(legacy);
}());
