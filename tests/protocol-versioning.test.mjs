import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protocolMigrationUrl = new URL(
  "../supabase/migrations/20260719043000_add_protocol_version_metadata.sql",
  import.meta.url
);
const freezeMigrationUrl = new URL(
  "../supabase/migrations/20260719050000_freeze_research_design_per_session.sql",
  import.meta.url
);

test("design interface records protocol version and change notes", async () => {
  const [html, script, endpoint] = await Promise.all([
    readFile(new URL("../design.html", import.meta.url), "utf8"),
    readFile(new URL("../design.js", import.meta.url), "utf8"),
    readFile(new URL("../api/saveDesign.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="protocolVersion"/);
  assert.match(html, /id="versionNotes"/);
  assert.match(script, /protocolVersion:/);
  assert.match(script, /versionNotes:/);
  assert.match(endpoint, /protocol_version: protocolVersion/);
  assert.match(endpoint, /version_notes:/);
});

test("database stores version metadata and freezes one design per session", async () => {
  const [protocolMigration, freezeMigration, lifecycle, chat] = await Promise.all([
    readFile(protocolMigrationUrl, "utf8"),
    readFile(freezeMigrationUrl, "utf8"),
    readFile(new URL("../server/sessionLifecycle.js", import.meta.url), "utf8"),
    readFile(new URL("../api/chat.js", import.meta.url), "utf8")
  ]);

  assert.match(protocolMigration, /protocol_version text/);
  assert.match(protocolMigration, /version_notes text/);
  assert.match(freezeMigration, /research_design_id uuid references public\.research_designs\(id\)/);
  assert.match(freezeMigration, /selected_research_design_id uuid/);
  assert.match(lifecycle, /p_research_design_id: requestedDesignId/);
  assert.match(chat, /researchDesignId: activeDesign\.id/);
  assert.match(chat, /preparedSession\.researchDesignId/);
  assert.match(chat, /loadResearchDesignById/);
});