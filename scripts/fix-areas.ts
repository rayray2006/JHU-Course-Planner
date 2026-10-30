/**
 * Re-normalise `courses.areas` rows that are still in the raw SIS format.
 *
 * The Typesense-backed SIS API returns caret-separated areas with codes
 * ("Humanities (H)^Science and Data (FA2)"); `normalizeAreas` folds that into
 * the stored format the search tools, degree checker and course detail UI all
 * match on ("Science and Data, H"). A deployment running the pre-normalisation
 * cron wrote raw values straight into Supabase, so those rows silently miss
 * every area and Foundational Ability filter.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/fix-areas.ts --dry
 *   npx tsx --env-file=.env.local scripts/fix-areas.ts
 *   npx tsx --env-file=.env.local scripts/fix-areas.ts --term "Fall 2026"
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeAreas } from "../src/lib/sis-api";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const DRY = process.argv.includes("--dry");
const termIdx = process.argv.indexOf("--term");
const TERM = termIdx !== -1 ? process.argv[termIdx + 1] : null;

type Row = { id: number; term: string; offering_name: string; section_name: string; areas: string };

/** Raw format markers: a caret separator, or a trailing "(CODE)". */
function isRaw(areas: string): boolean {
  return areas.includes("^") || /\([A-Z][A-Za-z0-9.]*\)\s*$/.test(areas.trim());
}

async function fetchAllRows(): Promise<Row[]> {
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("courses")
      .select("id, term, offering_name, section_name, areas")
      .neq("areas", "")
      .order("id")
      .range(from, from + PAGE - 1);
    if (TERM) q = q.eq("term", TERM);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

async function main() {
  console.log(`Scanning${TERM ? ` term "${TERM}"` : " all terms"}${DRY ? " (dry run)" : ""}...`);

  const all = await fetchAllRows();
  console.log(`  ${all.length} rows with a non-empty areas value`);

  // Only rewrite where normalising actually changes the stored value, so the
  // script is idempotent and safe to re-run after any ingest.
  const broken = all
    .filter((r) => isRaw(r.areas))
    .map((r) => ({ row: r, fixed: normalizeAreas(r.areas) }))
    .filter(({ row, fixed }) => fixed !== row.areas);

  if (broken.length === 0) {
    console.log("  Nothing to fix — every areas value is already normalised.");
    return;
  }

  const byTerm = new Map<string, number>();
  for (const { row } of broken) byTerm.set(row.term, (byTerm.get(row.term) ?? 0) + 1);
  console.log(`\n  ${broken.length} rows need rewriting:`);
  for (const [term, n] of [...byTerm].sort()) console.log(`    ${term}: ${n}`);

  console.log("\n  Examples:");
  for (const { row, fixed } of broken.slice(0, 5)) {
    console.log(`    ${row.offering_name} ${row.section_name} (${row.term})`);
    console.log(`      ${row.areas}`);
    console.log(`   -> ${fixed}`);
  }

  if (DRY) {
    console.log("\nDry run — nothing written. Re-run without --dry to apply.");
    return;
  }

  // Group by target value so identical rewrites go up as one request each.
  const groups = new Map<string, number[]>();
  for (const { row, fixed } of broken) {
    if (!groups.has(fixed)) groups.set(fixed, []);
    groups.get(fixed)!.push(row.id);
  }

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const [fixed, ids] of groups) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { error } = await supabase.from("courses").update({ areas: fixed }).in("id", chunk);
      if (error) {
        failed += chunk.length;
        if (!firstError) firstError = error.message;
      } else {
        updated += chunk.length;
      }
    }
    process.stdout.write(`  updated ${updated}/${broken.length}\r`);
  }
  console.log();

  console.log(`\nDone. Updated ${updated} rows${failed ? `, ${failed} failed (${firstError})` : ""}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
