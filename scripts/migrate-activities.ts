/**
 * Adds the `activities` table — custom time blocks (clubs, work, practice)
 * that sit on the calendar next to courses.
 *
 * Supabase's REST API cannot run DDL, so this prints the SQL to paste into the
 * Supabase SQL Editor and then verifies the result.
 *
 * Unlike migrate-schedule-slots.ts, this one is safe to run at any time: it
 * only creates a new table. Nothing reads or writes it until the build that
 * knows about activities is deployed, and no existing query changes shape, so
 * there is no window where the running site misbehaves.
 *
 *   npx tsx --env-file=.env.local scripts/migrate-activities.ts
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MIGRATION_SQL = `
-- Custom time blocks. One row per activity; the days it repeats on live in a
-- single SIS-style string ("MW", "TTh") so the calendar can reuse the meeting
-- parser it already has for courses.
CREATE TABLE IF NOT EXISTS activities (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  schedule_slot SMALLINT NOT NULL DEFAULT 1,
  term TEXT NOT NULL,
  name TEXT NOT NULL,
  days TEXT NOT NULL,
  start_min SMALLINT NOT NULL,
  end_min SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same three-column filter as every schedule read.
CREATE INDEX IF NOT EXISTS idx_activities_session_slot
  ON activities(session_id, schedule_slot, term);

-- Keep the stored values inside what the grid can draw (8am-10pm) and what the
-- UI can render, so a bad write fails here rather than becoming an invisible
-- row someone has to hunt for later.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_slot_range;
ALTER TABLE activities ADD CONSTRAINT activities_slot_range
  CHECK (schedule_slot BETWEEN 1 AND 3);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_time_range;
ALTER TABLE activities ADD CONSTRAINT activities_time_range
  CHECK (start_min >= 480 AND end_min <= 1320 AND end_min - start_min >= 15);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_name_len;
ALTER TABLE activities ADD CONSTRAINT activities_name_len
  CHECK (char_length(name) BETWEEN 1 AND 60);
`;

async function verify(): Promise<boolean> {
  let ok = true;

  const { error } = await supabase.from("activities").select("id").limit(1);
  if (error) {
    console.log(`❌ activities table: ${error.message}`);
    return false;
  }
  console.log("✓ activities table exists");

  // Prove the CHECK constraints are actually on: insert something the UI could
  // never draw and expect the database, not the app, to refuse it.
  const probe = `__probe_${Date.now()}`;
  const { error: badTime } = await supabase
    .from("activities")
    .insert({ session_id: probe, schedule_slot: 1, term: "probe", name: "probe", days: "M", start_min: 60, end_min: 120 });
  if (badTime) {
    console.log("✓ time-range constraint is in force");
  } else {
    console.log("❌ a 1am activity was accepted — activities_time_range is missing");
    ok = false;
  }

  const { error: badSlot } = await supabase
    .from("activities")
    .insert({ session_id: probe, schedule_slot: 9, term: "probe", name: "probe", days: "M", start_min: 600, end_min: 660 });
  if (badSlot) {
    console.log("✓ slot-range constraint is in force");
  } else {
    console.log("❌ slot 9 was accepted — activities_slot_range is missing");
    ok = false;
  }

  const { error: good, data: inserted } = await supabase
    .from("activities")
    .insert({ session_id: probe, schedule_slot: 1, term: "probe", name: "probe", days: "MW", start_min: 600, end_min: 660 })
    .select("id");
  if (good) {
    console.log(`❌ a valid activity was rejected: ${good.message}`);
    ok = false;
  } else {
    console.log("✓ a valid activity inserts");
    await supabase.from("activities").delete().eq("session_id", probe);
    const { count } = await supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("session_id", probe);
    console.log(count === 0 ? "✓ probe rows cleaned up" : `❌ ${count} probe row(s) left behind (id ${inserted?.[0]?.id})`);
    if (count !== 0) ok = false;
  }

  const { count: total } = await supabase.from("activities").select("id", { count: "exact", head: true });
  console.log(`\nactivities rows: ${total ?? 0}`);

  return ok;
}

async function main() {
  const exists = !(await supabase.from("activities").select("id").limit(1)).error;

  if (!exists) {
    console.log("Run this in the Supabase SQL Editor, then re-run this script:\n");
    console.log("─".repeat(72));
    console.log(MIGRATION_SQL.trim());
    console.log("─".repeat(72));
    console.log("\nThis only creates a new table — nothing existing is touched, and the");
    console.log("running site is unaffected until the build that uses it is deployed.");
    process.exit(1);
  }

  console.log("Verifying migration...\n");
  const ok = await verify();
  console.log(ok ? "\nMigration verified." : "\nMigration incomplete — see above.");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
