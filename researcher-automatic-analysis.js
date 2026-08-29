(function loadAutomaticAnalysisScripts() {
    "use strict";

    const frequencyRanking = document.createElement("script");
    frequencyRanking.src = "researcher-analysis-frequency-ranking.js?version=20260829-frequency-ranking-v1";
    frequencyRanking.onload = () => {
        const legacy = document.createElement("script");
        legacy.src = "researcher-automatic-analysis-legacy.js?version=20260827-incomplete-form-v10";
        legacy.onload = () => {
            const completeExport = document.createElement("script");
            completeExport.src = "researcher-complete-export.js?version=20260829-frequency-ranked-export-v2";
            document.body.appendChild(completeExport);
        };
        document.body.appendChild(legacy);
    };
    document.body.appendChild(frequencyRanking);
}());
