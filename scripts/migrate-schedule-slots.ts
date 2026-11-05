/**
 * Adds parallel schedules (Schedule 1/2/3) to the schedules table.
 *
 * Supabase's REST API cannot run DDL, so this prints the SQL to paste into the
 * Supabase SQL Editor and then verifies the result — the same shape as
 * migrate-schema.ts.
 *
 * Safe for existing *data* by construction: the new column defaults to 1, so
 * every row already in the table becomes that visitor's Schedule 1. No rows are
 * moved, rewritten or deleted.
 *
 * It is NOT backward compatible with the deployed code, though. Step 2 drops
 * the unique constraint that the old build names in its upsert conflict
 * target, and an upsert whose ON CONFLICT no longer matches a unique index
 * errors outright. So between running this and deploying the build that knows
 * about slots, "add course" fails in production. Run it immediately before the
 * deploy, not hours ahead.
 *
 *   npx tsx --env-file=.env.local scripts/migrate-schedule-slots.ts
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
-- 1. The slot itself. DEFAULT 1 is what preserves existing schedules: every
--    row already in the table becomes its owner's "Schedule 1" in place.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS schedule_slot SMALLINT NOT NULL DEFAULT 1;

-- 2. Uniqueness has to include the slot. While it does not, adding a class
--    that is already in Schedule 1 to Schedule 2 collides on the old key and
--    the upsert UPDATEs that row — silently moving the class between
--    schedules instead of putting a copy in both.
--
--    This table has carried that key under two different names (the inline
--    UNIQUE in supabase/schema.sql is auto-named; migrate-schema.ts created
--    'schedules_unique_per_term'), so match on the columns rather than a name
--    and drop whichever one is actually here.
DO $$
DECLARE target text;
BEGIN
  FOR target IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'schedules'
       AND con.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(con.conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           = ARRAY['offering_name','section_name','session_id','term']
  LOOP
    EXECUTE format('ALTER TABLE schedules DROP CONSTRAINT %I', target);
    RAISE NOTICE 'dropped old unique constraint %', target;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schedules_unique_per_slot'
  ) THEN
    ALTER TABLE schedules ADD CONSTRAINT schedules_unique_per_slot
      UNIQUE (session_id, schedule_slot, offering_name, section_name, term);
  END IF;
END $$;

-- 3. Keep slots inside the range the UI can actually display.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_slot_range;
ALTER TABLE schedules ADD CONSTRAINT schedules_slot_range CHECK (schedule_slot BETWEEN 1 AND 3);

-- 4. Every read filters on these three together.
CREATE INDEX IF NOT EXISTS idx_schedules_session_slot ON schedules(session_id, schedule_slot, term);
`;

async function verify(): Promise<boolean> {
  let ok = true;

  const { error: colErr } = await supabase.from("schedules").select("schedule_slot").limit(1);
  if (colErr) {
    console.log(`❌ schedules.schedule_slot column missing: ${colErr.message}`);
    return false;
  }
  console.log("✓ schedules.schedule_slot column exists");

  // Every pre-existing row must have landed in slot 1 — that is the whole
  // promise of this migration, so check it rather than assume the default.
  const { count: total } = await supabase
    .from("schedules")
    .select("*", { count: "exact", head: true });
  const { count: slot1 } = await supabase
    .from("schedules")
    .select("*", { count: "exact", head: true })
    .eq("schedule_slot", 1);
  const { count: stray } = await supabase
    .from("schedules")
    .select("*", { count: "exact", head: true })
    .not("schedule_slot", "in", "(1,2,3)");

  console.log(`✓ ${slot1}/${total} rows are in Schedule 1`);
  if (stray) {
    console.log(`❌ ${stray} rows sit outside slots 1-3`);
    ok = false;
  }

  // Prove the new uniqueness rule is the one in force: an upsert naming the
  // slot in its conflict target only resolves if a matching unique index
  // exists. Nothing is written — the row is removed either way.
  const probe = `__slotprobe_${Date.now()}`;
  const { error: upErr } = await supabase.from("schedules").upsert(
    { session_id: probe, schedule_slot: 2, offering_name: "__PROBE__", section_name: "00", term: "__probe__" },
    { onConflict: "session_id,schedule_slot,offering_name,section_name,term" }
  );
  if (upErr) {
    console.log(`❌ unique constraint not updated: ${upErr.message}`);
    ok = false;
  } else {
    console.log("✓ schedules_unique_per_slot is in force");
  }
  await supabase.from("schedules").delete().eq("session_id", probe);

  return ok;
}

async function main() {
  const alreadyDone = !(await supabase.from("schedules").select("schedule_slot").limit(1)).error;

  if (!alreadyDone) {
    console.log("Run this in the Supabase SQL Editor, then re-run this script:\n");
    console.log("─".repeat(72));
    console.log(MIGRATION_SQL.trim());
    console.log("─".repeat(72));
    console.log("\nNothing is deleted or moved. Existing rows become Schedule 1 via the column default.");
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
