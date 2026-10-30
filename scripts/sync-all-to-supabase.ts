/**
 * Sync ALL SQLite tables to Supabase for production deployment.
 * Creates missing tables and pushes data.
 */
import postgres from "postgres";
import Database from "better-sqlite3";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const db = new Database(path.join(process.cwd(), "courses.db"));

async function syncTable(
  tableName: string,
  selectSql: string,
  conflictCol: string,
  transform?: (row: Record<string, unknown>) => Record<string, unknown>
) {
  const rows = db.prepare(selectSql).all() as Record<string, unknown>[];
  console.log(`\n${tableName}: ${rows.length} rows to sync`);

  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => (transform ? transform(r) : r));
    const { error } = await supabase.from(tableName).upsert(chunk as any, { onConflict: conflictCol });
    if (error) {
      console.error(`  Error at ${i}: ${error.message}`);
      // If table doesn't exist, we need to create it
      if (error.message.includes("not found")) {
        console.log(`  Table ${tableName} doesn't exist in Supabase — need to create via SQL editor`);
        return;
      }
    } else {
      console.log(`  ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function main() {
  const what = process.argv[2]; // specific table or "all"
  // Optional term filter for `courses`, e.g. `sync:supabase courses "Spring 2027"`.
  // Without it every term is re-pushed, which overwrites seats that the daily
  // cron has already refreshed in production with whatever SQLite last scraped.
  const termFilter = process.argv[3];

  if (!what || what === "all" || what === "available_terms") {
    await syncTable(
      "available_terms",
      "SELECT * FROM available_terms ORDER BY sort_order",
      "term"
    );
  }

  if (!what || what === "all" || what === "catalogue") {
    await syncTable(
      "catalogue",
      "SELECT offering_name, title, credits, department, description, prerequisites, corequisites, restrictions FROM catalogue",
      "offering_name"
    );
  }

  if (!what || what === "all" || what === "courses") {
    if (termFilter) console.log(`\ncourses: limiting to term "${termFilter}"`);
    await syncTable(
      "courses",
      termFilter
        ? `SELECT * FROM courses WHERE term = '${termFilter.replace(/'/g, "''")}'`
        : "SELECT * FROM courses",
      "offering_name,section_name,term",
      (r) => ({
        offering_name: r.offering_name,
        section_name: r.section_name,
        title: r.title,
        credits: r.credits,
        department: r.department,
        school_name: r.school_name,
        level: r.level,
        status: r.status,
        dow: r.dow,
        time_of_day: r.time_of_day,
        meetings: r.meetings,
        location: r.location,
        building: r.building,
        instruction_method: r.instruction_method,
        instructors: r.instructors,
        instructors_full_name: r.instructors_full_name,
        max_seats: r.max_seats,
        open_seats: r.open_seats,
        waitlisted: r.waitlisted,
        is_writing_intensive: r.is_writing_intensive,
        areas: r.areas,
        repeatable: r.repeatable,
        term: r.term,
        term_start_date: r.term_start_date,
        description: r.description || "",
        prerequisites: r.prerequisites || "",
        corequisites: r.corequisites || "",
        restrictions: r.restrictions || "",
        overall_quality: r.overall_quality,
        instructor_effectiveness: r.instructor_effectiveness,
        intellectual_challenge: r.intellectual_challenge,
        workload: r.workload,
        feedback_usefulness: r.feedback_usefulness,
        num_evaluations: r.num_evaluations || 0,
        num_respondents: r.num_respondents || 0,
        pos_tags: r.pos_tags || "",
      })
    );
  }

  if (!what || what === "all" || what === "professors") {
    await syncTable(
      "professors",
      "SELECT * FROM professors",
      "first_name,last_name,department",
      (r) => ({
        first_name: r.first_name,
        last_name: r.last_name,
        department: r.department,
        avg_rating: r.avg_rating,
        avg_difficulty: r.avg_difficulty,
        num_ratings: r.num_ratings,
        would_take_again_pct: r.would_take_again_pct,
        rmp_id: r.rmp_id,
      })
    );
  }

  if (!what || what === "all" || what === "evaluations") {
    await syncTable(
      "evaluations",
      "SELECT * FROM evaluations",
      "instance_key",
      (r) => ({
        course_code: r.course_code,
        instance_key: r.instance_key,
        course_name: r.course_name || "",
        instructor: r.instructor || "",
        term: r.term || "",
        overall_quality: r.overall_quality,
        instructor_effectiveness: r.instructor_effectiveness,
        intellectual_challenge: r.intellectual_challenge,
        workload: r.workload,
        feedback_usefulness: r.feedback_usefulness,
        num_respondents: r.num_respondents || 0,
        num_enrolled: r.num_enrolled || 0,
      })
    );
  }

  if (!what || what === "all" || what === "program_schemas") {
    await syncTable(
      "program_schemas",
      "SELECT program_name, program_url, school, schema, visible FROM program_schemas",
      "program_name"
    );
  }

  if (!what || what === "all" || what === "program_tags") {
    await syncTable(
      "program_tags",
      "SELECT * FROM program_tags",
      "id"
    );
  }

  console.log("\nDone!");
}

main().catch(console.error);
