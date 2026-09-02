import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260902201500_use_stored_english_for_stage1_meaning_units.sql",
  import.meta.url,
);
const priorityMigrationUrl = new URL(
  "../supabase/migrations/20260902202500_refine_stage1_english_display_priority.sql",
  import.meta.url,
);
const resolvedEnglishMigrationUrl = new URL(
  "../supabase/migrations/20260902204500_require_resolved_english_stage1_mu_display.sql",
  import.meta.url,
);

test("Stage 1 form displays stored English while preserving original Meaning Units", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /add column english_text text/i);
  assert.match(migration, /unit\.exact_text/i);
  assert.match(migration, /candidate\."EnglishTranslation"/i);
  assert.match(migration, /stage1_inline_english_translation/i);
  assert.match(migration, /stage1_english_meaning_unit/i);
  assert.match(migration, /coalesce\(english_text, exact_text\)/i);
  assert.doesNotMatch(migration, /createAnalysisProviderClient|responses\.create|chat\.completions/i);
});

test("English Stage 1 Meaning Units are not mistaken for bilingual translations", async () => {
  const migration = await readFile(priorityMigrationUrl, "utf8");

  assert.match(migration, /coalesce\(form\.language, 'en'\) <> 'en'/i);
  assert.match(migration, /when coalesce\(resolved\.language, 'en'\) = 'en'/i);
  assert.match(migration, /then resolved\.exact_text/i);
  assert.match(migration, /resolved\.stored_message_translation/i);
});

test("short non-English MU excerpts resolve only through unique stored message matches", async () => {
  const migration = await readFile(resolvedEnglishMigrationUrl, "utf8");

  assert.match(migration, /stage1_text_looks_english/i);
  assert.match(migration, /length\(context\.normalized_exact_text\) >= 2/i);
  assert.match(migration, /select count\(\*\)[\s\S]*matching\.content_match/i);
  assert.match(migration, /stage1_text_without_separate_translation/i);
  assert.doesNotMatch(migration, /createAnalysisProviderClient|responses\.create|chat\.completions/i);
});
