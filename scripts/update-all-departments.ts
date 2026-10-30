import { createClient } from "@supabase/supabase-js";
import { fetchSchoolTerm, formatAllDepartments } from "../src/lib/sis-api";
import { CURRENT_TERM } from "../src/lib/terms";

const API_KEY = process.env.JHU_API_KEY!;
const args = process.argv.slice(2).filter((a) => a !== "--dry");
const TERM = args[0] || CURRENT_TERM;
const DRY = process.argv.includes("--dry");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

async function main() {
  // First, add column if it doesn't exist (will fail silently if already there)
  console.log("Ensuring all_departments column exists...");

  // Desired value per section, keyed the way the course rows are identified.
  const want = new Map<string, string>();
  for (const school of SCHOOLS) {
    console.log(`Fetching ${school}...`);
    let data;
    try {
      data = await fetchSchoolTerm(school, TERM, API_KEY);
    } catch (err) {
      console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    console.log(`  Got ${data.length} sections`);
    for (const c of data) {
      // Convert ^ separator to comma for readable storage
      want.set(`${c.OfferingName}::${c.SectionName}`, formatAllDepartments(c.AllDepartments));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`\n  ${want.size} sections from SIS`);

  // Read the stored rows once and write only the ones that differ. The old
  // loop issued one UPDATE per section — 4,447 round trips at ~350ms each,
  // which is half an hour for a term that mostly already matches.
  type Row = { id: number; offering_name: string; section_name: string; all_departments: string | null };
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("courses")
      .select("id, offering_name, section_name, all_departments")
      .eq("term", TERM)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  console.log(`  ${rows.length} stored rows for "${TERM}"`);

  const stale = rows
    .map((row) => ({ row, value: want.get(`${row.offering_name}::${row.section_name}`) ?? "" }))
    .filter(({ row, value }) => value !== "" && value !== (row.all_departments ?? ""));

  if (stale.length === 0) {
    console.log("\n  Nothing to write — every row already matches SIS.");
    return;
  }

  console.log(`\n  ${stale.length} rows need all_departments`);
  for (const { row, value } of stale.slice(0, 5)) {
    console.log(`    ${row.offering_name} ${row.section_name}: ${JSON.stringify(row.all_departments ?? "")} -> ${value}`);
  }

  if (DRY) {
    console.log("\nDry run — nothing written. Re-run without --dry to apply.");
    return;
  }

  const groups = new Map<string, number[]>();
  for (const { row, value } of stale) {
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(row.id);
  }

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const [value, ids] of groups) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { error } = await supabase.from("courses").update({ all_departments: value }).in("id", chunk);
      if (error) {
        failed += chunk.length;
        if (!firstError) firstError = error.message;
      } else {
        updated += chunk.length;
      }
    }
    process.stdout.write(`  updated ${updated}/${stale.length}\r`);
  }
  console.log();

  console.log(`\nDone! Updated ${updated} rows${failed ? `, ${failed} failed (${firstError})` : ""}.`);

  // Verify
  const { data: sample } = await supabase
    .from("courses")
    .select("offering_name, title, department, all_departments")
    .ilike("all_departments", "%^%")
    .limit(5);

  // Check for courses with multiple departments
  const { data: multi } = await supabase
    .from("courses")
    .select("offering_name, title, all_departments")
    .ilike("all_departments", "%, %")
    .limit(10);

  console.log("\nSample cross-listed courses:");
  (multi || []).forEach((c) => console.log(`  ${c.offering_name} ${c.title}: ${c.all_departments}`));
}

main().catch(console.error);
