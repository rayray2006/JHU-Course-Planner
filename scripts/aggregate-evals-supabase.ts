/**
 * Re-aggregate the Supabase `evaluations` table into the rating columns on
 * `courses`. This is the Supabase counterpart to the SQLite-only aggregation
 * step in ingest-evaluations.ts — without it, freshly synced evaluations never
 * reach the columns the app actually reads.
 *
 *   npm run aggregate:evals            # apply
 *   npm run aggregate:evals -- --dry   # report what would change
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const DRY = process.argv.includes("--dry");

/** Supabase caps a select at 1000 rows, so page through explicitly. */
async function selectAll<T>(build: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if (!data || data.length < pageSize) return out;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function avg(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
}

type Agg = {
  overall_quality: number | null;
  instructor_effectiveness: number | null;
  intellectual_challenge: number | null;
  workload: number | null;
  feedback_usefulness: number | null;
  num_evaluations: number;
  num_respondents: number;
};

const EMPTY: Agg = {
  overall_quality: null,
  instructor_effectiveness: null,
  intellectual_challenge: null,
  workload: null,
  feedback_usefulness: null,
  num_evaluations: 0,
  num_respondents: 0,
};

async function main() {
  console.log("Loading evaluations...");
  const evals = await selectAll<any>(() =>
    supabase
      .from("evaluations")
      .select(
        "course_code, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_respondents"
      )
      .not("overall_quality", "is", null)
      .order("id", { ascending: true })
  );
  console.log(`  ${evals.length} rated evaluations`);

  const byCourse = new Map<string, any[]>();
  for (const e of evals) {
    const list = byCourse.get(e.course_code);
    if (list) list.push(e);
    else byCourse.set(e.course_code, [e]);
  }

  const aggs = new Map<string, Agg>();
  for (const [code, rows] of byCourse) {
    aggs.set(code, {
      overall_quality: avg(rows.map((r) => r.overall_quality)),
      instructor_effectiveness: avg(rows.map((r) => r.instructor_effectiveness)),
      intellectual_challenge: avg(rows.map((r) => r.intellectual_challenge)),
      workload: avg(rows.map((r) => r.workload)),
      feedback_usefulness: avg(rows.map((r) => r.feedback_usefulness)),
      num_evaluations: rows.length,
      num_respondents: rows.reduce((a, r) => a + (r.num_respondents || 0), 0),
    });
  }
  console.log(`  ${aggs.size} distinct course codes with ratings`);

  console.log("Loading courses...");
  const courses = await selectAll<any>(() =>
    supabase
      .from("courses")
      .select(
        "offering_name, section_name, term, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents"
      )
      .order("id", { ascending: true })
  );
  console.log(`  ${courses.length} course rows`);

  // Group by offering: every section/term of a course shares the same ratings,
  // so one UPDATE per offering covers them all. (An upsert can't be used here —
  // PostgREST builds a full INSERT tuple before conflict resolution, so NOT NULL
  // columns like `title` would be violated by a partial-column write.)
  const needsUpdate = new Map<string, Agg>();
  let changedRows = 0;
  let gained = 0;
  let cleared = 0;
  for (const c of courses) {
    const a = aggs.get(c.offering_name) ?? EMPTY;
    const differs =
      c.overall_quality !== a.overall_quality ||
      c.instructor_effectiveness !== a.instructor_effectiveness ||
      c.intellectual_challenge !== a.intellectual_challenge ||
      c.workload !== a.workload ||
      c.feedback_usefulness !== a.feedback_usefulness ||
      (c.num_evaluations ?? 0) !== a.num_evaluations ||
      (c.num_respondents ?? 0) !== a.num_respondents;
    if (!differs) continue;
    changedRows++;
    if (c.overall_quality == null && a.overall_quality != null) gained++;
    if (c.overall_quality != null && a.overall_quality == null) cleared++;
    needsUpdate.set(c.offering_name, a);
  }

  console.log(`\n${changedRows} course rows would change across ${needsUpdate.size} offerings:`);
  console.log(`  ${gained} gaining ratings, ${cleared} losing ratings`);

  if (DRY) {
    console.log("\n--dry: no writes performed.");
    return;
  }
  if (needsUpdate.size === 0) return;

  const entries = [...needsUpdate];
  let done = 0;
  const CONCURRENCY = 10;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + CONCURRENCY).map(async ([offering, agg]) => {
        const { error } = await supabase.from("courses").update(agg).eq("offering_name", offering);
        if (error) throw new Error(`update failed for ${offering}: ${error.message}`);
      })
    );
    done += Math.min(CONCURRENCY, entries.length - i);
    process.stdout.write(`\r  ${done}/${entries.length} offerings`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
