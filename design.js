document.getElementById("saveButton").addEventListener("click", async function () {

    const design = {

        researchTitle: document.getElementById("researchTitle").value,

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

    const response = await fetch("/api/saveDesign", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify(design)
});

const result = await response.json();

alert(result.message);

});
