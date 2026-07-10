document.getElementById("saveButton").addEventListener("click", function () {

    const design = {

        researchTitle: document.getElementById("researchTitle").value,

        researchPurpose: document.getElementById("researchPurpose").value,

        interviewTopic: document.getElementById("interviewTopic").value,

        interviewQuestions: document.getElementById("interviewQuestions").value,

        aiRole: document.getElementById("aiRole").value,

        researchGoal: document.getElementById("researchGoal").value,

        endingMessage: document.getElementById("endingMessage").value,

        interviewQuestionCount: document.getElementById("interviewQuestionCount").value,

        maximumInterviewerQuestions: document.getElementById("maximumInterviewerQuestions").value

    };

    localStorage.setItem("design", JSON.stringify(design));

alert("Research design saved.");

});
