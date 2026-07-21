(function initializeDesignReview() {
    "use strict";

    const reviewDialog = document.getElementById("reviewDialog");
    const reviewSummary = document.getElementById("reviewSummary");
    const savePin = document.getElementById("savePin");
    const saveStatus = document.getElementById("saveStatus");
    const confirmSaveButton = document.getElementById("confirmSaveButton");
    const versionInputs = [
        document.getElementById("topicNumber"),
        document.getElementById("versionNumber"),
        document.getElementById("progressNumber")
    ];
    let reviewedDesign = null;

    function positiveInteger(value, label) {
        const parsed = Number(value);

        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`${label} must be a whole number of 1 or greater.`);
        }

        return parsed;
    }

    function protocolVersion() {
        const topic = positiveInteger(versionInputs[0].value, "Topic number");
        const version = positiveInteger(versionInputs[1].value, "Version number");
        const progress = positiveInteger(versionInputs[2].value, "Progress number");
        return `${topic}.${version}.${progress}`;
    }

    function updateVersionPreview() {
        const values = versionInputs.map((input, index) => {
            const value = Number(input.value);
            return Number.isInteger(value) && value > 0
                ? value
                : [2, 1, 4][index];
        });

        document.getElementById("protocolVersionPreview").textContent =
            values.join(".");
    }

    function collectDesign() {
        return {
            researchTitle: document.getElementById("researchTitle").value,
            protocolVersion: protocolVersion(),
            versionNotes: document.getElementById("versionNotes").value,
            researchPurpose: document.getElementById("researchPurpose").value,
            interviewTopic: document.getElementById("interviewTopic").value,
            interviewModel: document.getElementById("interviewModel").value,
            interviewQuestions: document.getElementById("interviewQuestions").value,
            aiRole: document.getElementById("aiRole").value,
            researchGoal: document.getElementById("researchGoal").value,
            endingMessage: document.getElementById("endingMessage").value,
            interviewQuestionCount: document.getElementById("interviewQuestionCount").value,
            maximumInterviewerQuestions: document.getElementById("maximumInterviewerQuestions").value
        };
    }

    function reviewField(label, value) {
        const section = document.createElement("section");
        section.style.marginBottom = "16px";
        const heading = document.createElement("h3");
        heading.textContent = label;
        heading.style.marginBottom = "4px";
        const text = document.createElement("div");
        text.textContent = String(value || "—");
        text.style.whiteSpace = "pre-wrap";
        section.append(heading, text);
        return section;
    }

    function renderReview(design) {
        reviewSummary.replaceChildren(
            reviewField("Research title", design.researchTitle),
            reviewField("Protocol version", design.protocolVersion),
            reviewField("Version notes", design.versionNotes),
            reviewField("Research purpose", design.researchPurpose),
            reviewField("Interview topic", design.interviewTopic),
            reviewField("Interview model", design.interviewModel),
            reviewField("AI role", design.aiRole),
            reviewField("Research goal", design.researchGoal),
            reviewField("Interview questions", design.interviewQuestions),
            reviewField("Ending message", design.endingMessage),
            reviewField("Interview question count", design.interviewQuestionCount),
            reviewField("Maximum interviewer questions", design.maximumInterviewerQuestions)
        );
    }

    function setSaveStatus(message, isError = false) {
        saveStatus.textContent = message;
        saveStatus.style.color = isError ? "#9b1c1c" : "#333";
    }

    versionInputs.forEach(input => input.addEventListener("input", updateVersionPreview));
    updateVersionPreview();

    document.getElementById("reviewButton").addEventListener("click", () => {
        try {
            reviewedDesign = collectDesign();
            renderReview(reviewedDesign);
            savePin.value = "";
            setSaveStatus("");
            reviewDialog.showModal();
        } catch (error) {
            alert(error.message);
        }
    });

    document.getElementById("backToEditButton").addEventListener("click", () => {
        reviewedDesign = null;
        savePin.value = "";
        reviewDialog.close();
    });

    confirmSaveButton.addEventListener("click", async () => {
        const pin = savePin.value;

        if (!reviewedDesign) {
            setSaveStatus("Review the research design again before saving.", true);
            return;
        }

        if (!pin) {
            setSaveStatus("Enter the PIN security code before saving.", true);
            return;
        }

        confirmSaveButton.disabled = true;
        setSaveStatus("Verifying PIN and saving research design…");

        try {
            const response = await fetch("/api/saveDesign", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${pin}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(reviewedDesign)
            });
            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(result.error || "The research design could not be saved.");
            }

            setSaveStatus(result.message || "Research design saved.");
            savePin.value = "";
            reviewedDesign = null;
        } catch (error) {
            setSaveStatus(error.message, true);
        } finally {
            confirmSaveButton.disabled = false;
        }
    });
}());
