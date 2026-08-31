(function loadAutomaticAnalysisScripts() {
    "use strict";

    const legacy = document.createElement("script");
    legacy.src = "researcher-automatic-analysis-legacy.js?version=20260831-theme-hierarchy-v1";
    legacy.onload = () => {
        const review = document.createElement("script");
        review.src = "researcher-automatic-review.js?version=20260831-theme-hierarchy-v1";
        document.body.appendChild(review);

        const completeExport = document.createElement("script");
        completeExport.src = "researcher-complete-export.js?version=20260831-theme-hierarchy-v1";
        document.body.appendChild(completeExport);
    };
    document.body.appendChild(legacy);
}());
