/**
 * Supabase schema migration script.
 *
 * This creates the new tables (catalogue, program_requirements, available_terms)
 * and adds the term column to schedules.
 *
 * Since we can't run raw SQL via the Supabase REST API, this script outputs
 * the SQL to run in the Supabase SQL Editor, then verifies the tables exist.
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
-- 1. Add term column to schedules
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS term TEXT NOT NULL DEFAULT 'Spring 2027';

-- 2. Drop old unique constraint and add new one with term
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'schedules_session_id_offering_name_section_name_key') THEN
    ALTER TABLE schedules DROP CONSTRAINT schedules_session_id_offering_name_section_name_key;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'schedules_unique_per_term') THEN
    ALTER TABLE schedules ADD CONSTRAINT schedules_unique_per_term
      UNIQUE(session_id, offering_name, section_name, term);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_schedules_term ON schedules(term);
CREATE INDEX IF NOT EXISTS idx_courses_term ON courses(term);

-- 3. Catalogue table
CREATE TABLE IF NOT EXISTS catalogue (
  id SERIAL PRIMARY KEY,
  offering_name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  credits TEXT,
  department TEXT,
  description TEXT DEFAULT '',
  prerequisites TEXT DEFAULT '',
  corequisites TEXT DEFAULT '',
  restrictions TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_catalogue_title ON catalogue(title);
CREATE INDEX IF NOT EXISTS idx_catalogue_department ON catalogue(department);
CREATE INDEX IF NOT EXISTS idx_catalogue_offering ON catalogue(offering_name);

-- 4. Program requirements table
CREATE TABLE IF NOT EXISTS program_requirements (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  program_name TEXT NOT NULL DEFAULT 'My Program',
  requirements JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, program_name)
);
CREATE INDEX IF NOT EXISTS idx_requirements_session ON program_requirements(session_id);

-- 5. Available terms table
CREATE TABLE IF NOT EXISTS available_terms (
  term TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  has_sis_data BOOLEAN DEFAULT FALSE,
  course_count INTEGER DEFAULT 0,
  is_current BOOLEAN DEFAULT FALSE
);

-- Pre-populate terms
INSERT INTO available_terms VALUES ('Fall 2024', 1, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Spring 2025', 2, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Summer 2025', 3, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Fall 2025', 4, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Spring 2026', 5, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Summer 2026', 6, FALSE, 0, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Fall 2026', 7, TRUE, 5810, FALSE) ON CONFLICT (term) DO NOTHING;
INSERT INTO available_terms VALUES ('Spring 2027', 8, TRUE, 4447, TRUE) ON CONFLICT (term) DO NOTHING;
`;

async function verify() {
  console.log("Verifying Supabase schema...\n");

  const checks = [
    { table: "available_terms", desc: "available_terms table" },
    { table: "catalogue", desc: "catalogue table" },
    { table: "program_requirements", desc: "program_requirements table" },
  ];

  let allGood = true;
  for (const check of checks) {
    const { error } = await supabase.from(check.table).select("*").limit(1);
    if (error) {
      console.log(`❌ ${check.desc}: ${error.message}`);
      allGood = false;
    } else {
      console.log(`✓ ${check.desc} exists`);
    }
  }

  // Check schedules has term column
  const { data: sch, error: schErr } = await supabase.from("schedules").select("term").limit(1);
  if (schErr && schErr.message.includes("term")) {
    console.log("❌ schedules.term column missing");
    allGood = false;
  } else {
    console.log("✓ schedules.term column exists");
  }

  // Check available_terms data
  const { data: terms } = await supabase
    .from("available_terms")
    .select("term, sort_order, has_sis_data, is_current")
    .order("sort_order");
  if (terms && terms.length > 0) {
    console.log(`\nAvailable terms (${terms.length}):`);
    for (const t of terms) {
      const flags = [
        t.has_sis_data ? "SIS" : "",
        t.is_current ? "CURRENT" : "",
      ].filter(Boolean).join(", ");
      console.log(`  ${t.term}${flags ? ` [${flags}]` : ""}`);
    }
  }

  return allGood;
}

async function main() {
  const ok = await verify();

  if (!ok) {
    console.log("\n" + "=".repeat(60));
    console.log("MIGRATION NEEDED: Run this SQL in the Supabase SQL Editor:");
    console.log("https://supabase.com/dashboard/project/mkpgtplmlzpljxkbjtpr/sql/new");
    console.log("=".repeat(60));
    console.log(MIGRATION_SQL);
    console.log("=".repeat(60));
    console.log("\nAfter running the SQL, re-run this script to verify.");
    process.exit(1);
  } else {
    console.log("\n✓ All migrations verified!");
  }
}

main().catch(console.error);
