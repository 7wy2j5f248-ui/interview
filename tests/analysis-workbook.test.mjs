import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
    ANALYSIS_WORKBOOK_VERSION,
    createAnalysisWorkbook,
    parseAnalysisWorkbook
} from "../server/analysisWorkbook.js";

const runId = "11111111-1111-4111-8111-111111111111";

function themeSnapshot() {
    return {
        stage: "themes",
        runId,
        selection: { themePosition: "T1", codePosition: "T1-C1" },
        mainHeaders: ["Participant code", "Language", "T1", "T2"],
        mainRows: [
            ["P0001", "en", "Stable routine", "Night waking"],
            ["P0002", "fr", "Shift work", ""]
        ],
        detailHeaders: [
            "Stable theme ID",
            "Participant code",
            "Theme position",
            "Theme content",
            "Researcher group",
            "Group order",
            "Item order",
            "Researcher note"
        ],
        detailRows: [
            ["P0001-T1", "P0001", "T1", "Stable routine", "", "", 1, ""],
            ["P0001-T2", "P0001", "T2", "Night waking", "", "", 2, ""],
            ["P0002-T1", "P0002", "T1", "Shift work", "", "", 3, ""]
        ]
    };
}

test("theme workbook keeps content in cells and stable positional headers", async () => {
    const buffer = await createAnalysisWorkbook(
        themeSnapshot(),
        new Date("2026-08-27T08:00:00.000Z")
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const main = workbook.worksheets[0];
    assert.ok(main);
    assert.deepEqual(
        main.getRow(1).values.slice(1),
        ["Participant code", "Language", "T1", "T2"]
    );
    assert.equal(main.getCell("C2").value, "Stable routine");
    assert.equal(main.getCell("D2").value, "Night waking");
    assert.equal(workbook.getWorksheet("PLI Metadata").state, "veryHidden");
});

test("uploaded workbook records researcher grouping and physical order", async () => {
    const buffer = await createAnalysisWorkbook(themeSnapshot());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const grouping = workbook.getWorksheet("Theme grouping");

    grouping.spliceRows(2, 3,
        ["P0002-T1", "P0002", "T1", "Shift work", "Work schedule", 1, 1, "Prioritize"],
        ["P0001-T2", "P0001", "T2", "Night waking", "Sleep disruption", 2, 2, ""],
        ["P0001-T1", "P0001", "T1", "Stable routine", "Routine", 3, 3, ""]
    );
    const edited = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseAnalysisWorkbook(edited, "themes");

    assert.equal(parsed.version, ANALYSIS_WORKBOOK_VERSION);
    assert.equal(parsed.runId, runId);
    assert.deepEqual(parsed.rowOrder, ["P0002", "P0001"]);
    assert.equal(parsed.groupingData.items[0].stableId, "P0002-T1");
    assert.equal(parsed.groupingData.items[0].group, "Work schedule");
    assert.equal(parsed.groupingData.items[0].note, "Prioritize");
    assert.equal(parsed.groupingData.items[2].groupOrder, 3);
});

test("workbook parser rejects upload to a different stage", async () => {
    const buffer = await createAnalysisWorkbook(themeSnapshot());
    await assert.rejects(
        parseAnalysisWorkbook(buffer, "codes"),
        /wrong analysis stage/
    );
});
