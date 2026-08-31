(function initializeGlobalRules() {
    "use strict";

    const TOKEN_KEY = "researcherDashboardToken";
    const DRAFT_KEY = "pliGlobalAnalysisRulesDraftV1";
    const pin = document.getElementById("researcherPin");
    const rules = document.getElementById("globalRules");
    const notes = document.getElementById("versionNotes");
    const status = document.getElementById("rulesStatus");
    const draftStatus = document.getElementById("draftStatus");
    const history = document.getElementById("rulesHistory");
    const dialog = document.getElementById("reviewDialog");
    const saveStatus = document.getElementById("saveStatus");
    let workspace = { activeRuleId: null, rules: [] };
    let reviewed = null;

    function token() {
        return pin.value || sessionStorage.getItem(TOKEN_KEY) || "";
    }

    function setStatus(message, error = false) {
        status.textContent = message;
        status.style.color = error ? "#9b1c1c" : "#214f35";
    }

    function saveDraft() {
        const draft = {
            rulesText: rules.value,
            versionNotes: notes.value,
            savedAt: new Date().toISOString()
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        draftStatus.textContent = `Draft protected at ${new Date(draft.savedAt).toLocaleTimeString()}.`;
    }

    function storedDraft() {
        try {
            return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
        } catch {
            return null;
        }
    }

    function renderHistory() {
        if (!workspace.rules.length) {
            history.textContent = "No saved global rule version exists.";
            return;
        }
        const list = document.createElement("ol");
        workspace.rules.forEach(item => {
            const row = document.createElement("li");
            row.style.marginBottom = "10px";
            row.textContent = `v${item.versionNumber}${
                item.id === workspace.activeRuleId ? " · active" : ""
            } · ${item.createdAt ? new Date(item.createdAt).toLocaleString() : "timestamp unavailable"}${
                item.predecessorId ? ` · predecessor ${item.predecessorId}` : " · first version"
            }${item.versionNotes ? ` — ${item.versionNotes}` : ""}`;
            list.appendChild(row);
        });
        history.replaceChildren(list);
    }

    async function loadWorkspace() {
        if (!token()) throw new Error("Enter the researcher PIN.");
        setStatus("Loading global rule history…");
        const response = await fetch("/api/saveDesign?action=global_analysis_rules", {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token()}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Unable to load rules.");
        sessionStorage.setItem(TOKEN_KEY, token());
        workspace = data;
        const active = workspace.rules.find(item =>
            item.id === workspace.activeRuleId
        ) || workspace.rules[0] || null;
        const draft = storedDraft();
        rules.value = draft?.rulesText || active?.rulesText || "";
        notes.value = draft?.versionNotes || "";
        renderHistory();
        setStatus(draft
            ? "Rule history loaded. The protected unsaved draft was restored."
            : "Rule history loaded. Saving creates a new future-only version.");
    }

    document.getElementById("loadRulesButton").addEventListener("click", () => {
        loadWorkspace().catch(error => setStatus(error.message, true));
    });
    rules.addEventListener("input", saveDraft);
    notes.addEventListener("input", saveDraft);

    document.getElementById("reviewRulesButton").addEventListener("click", () => {
        const rulesText = rules.value.trim();
        if (!rulesText) {
            setStatus("Global analysis rules cannot be blank.", true);
            return;
        }
        reviewed = {
            action: "save_global_analysis_rules",
            rulesText,
            versionNotes: notes.value.trim()
        };
        document.getElementById("reviewText").textContent = rulesText;
        document.getElementById("reviewNotes").textContent =
            reviewed.versionNotes || "—";
        saveStatus.textContent = "";
        dialog.showModal();
    });

    document.getElementById("saveRulesButton").addEventListener("click", async event => {
        if (!reviewed) return;
        const button = event.currentTarget;
        button.disabled = true;
        saveStatus.textContent = "Saving immutable global rule version…";
        try {
            const response = await fetch("/api/saveDesign", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(reviewed)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || "Unable to save rules.");
            localStorage.removeItem(DRAFT_KEY);
            reviewed = null;
            saveStatus.textContent = `${result.message} No completed report changed and no historical job was queued.`;
            await loadWorkspace();
        } catch (error) {
            saveStatus.textContent = error.message;
            saveStatus.style.color = "#9b1c1c";
        } finally {
            button.disabled = false;
        }
    });

    const storedToken = sessionStorage.getItem(TOKEN_KEY);
    if (storedToken) {
        pin.value = storedToken;
        loadWorkspace().catch(error => setStatus(error.message, true));
    }
}());
