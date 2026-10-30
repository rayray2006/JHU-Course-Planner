/**
 * Local re-run of the daily seat sync (src/app/api/cron/sync-seats/route.ts).
 *
 * Use when the Vercel cron has stopped and seat/waitlist data is stale. Fetches
 * the current term from SIS, reports what changed, upserts into Supabase, and
 * backfills descriptions/prereqs/evals onto brand-new sections (which SIS does
 * not carry) from the most recent other term of the same offering.
 *
 *   npm run sync:seats            # current term from available_terms
 *   npm run sync:seats -- "Spring 2027"
 */
import { createClient } from "@supabase/supabase-js";
import { fetchSchoolTerm, toCourseRow, SISApiError, SIS_API_BASE, type SISCourse } from "../src/lib/sis-api";

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

const API_KEY = process.env.JHU_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set JHU_API_KEY, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const key = (offering: string, section: string) => `${offering}|${section}`;

async function fetchSchool(school: string, term: string): Promise<SISCourse[]> {
  try {
    return await fetchSchoolTerm(school, term, API_KEY!);
  } catch (err) {
    const msg = err instanceof SISApiError ? err.message : String(err);
    console.error(`  ${school}: ${msg}`);
    if (err instanceof SISApiError && err.status === 401) process.exit(1);
    return [];
  }
}

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

async function resolveTerm(): Promise<string> {
  const argTerm = process.argv[2];
  if (argTerm) return argTerm;
  const { data, error } = await supabase
    .from("available_terms")
    .select("term")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error("could not resolve current term");
  return data.term as string;
}

type ExistingRow = {
  offering_name: string;
  section_name: string;
  status: string | null;
  max_seats: string | null;
  open_seats: string | null;
  waitlisted: string | null;
};

async function main() {
  const term = await resolveTerm();
  console.log(`Term: ${term}`);
  console.log(`SIS API: ${SIS_API_BASE}\n`);

  const fresh: SISCourse[] = [];
  for (const school of SCHOOLS) {
    console.log(`Fetching ${school}...`);
    const rows = await fetchSchool(school, term);
    console.log(`  ${rows.length} sections`);
    fresh.push(...rows);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fresh.length === 0) {
    console.error("\nSIS returned 0 sections — aborting so we don't touch existing data.");
    process.exit(1);
  }

  console.log("\nLoading existing rows from Supabase...");
  const existing = await selectAll<ExistingRow>(() =>
    supabase
      .from("courses")
      .select("offering_name, section_name, status, max_seats, open_seats, waitlisted")
      .eq("term", term)
      .order("id", { ascending: true })
  );
  console.log(`  ${existing.length} rows currently stored`);

  const byKey = new Map(existing.map((r) => [key(r.offering_name, r.section_name), r]));
  const freshKeys = new Set(fresh.map((c) => key(c.OfferingName, c.SectionName)));

  const newSections: SISCourse[] = [];
  const seatChanges: string[] = [];
  const statusChanges: string[] = [];
  for (const c of fresh) {
    const prev = byKey.get(key(c.OfferingName, c.SectionName));
    if (!prev) {
      newSections.push(c);
      continue;
    }
    if (prev.open_seats !== c.OpenSeats || prev.waitlisted !== c.Waitlisted || prev.max_seats !== c.MaxSeats) {
      seatChanges.push(
        `${c.OfferingName} (${c.SectionName}) seats ${prev.open_seats}/${prev.max_seats} -> ${c.OpenSeats}/${c.MaxSeats}, waitlist ${prev.waitlisted} -> ${c.Waitlisted}`
      );
    }
    if (prev.status !== c.Status) {
      statusChanges.push(`${c.OfferingName} (${c.SectionName}) ${prev.status} -> ${c.Status}`);
    }
  }
  const vanished = existing.filter((r) => !freshKeys.has(key(r.offering_name, r.section_name)));

  console.log(`\nDiff vs stored data:`);
  console.log(`  new sections:      ${newSections.length}`);
  console.log(`  seat/waitlist:     ${seatChanges.length} changed`);
  console.log(`  status:            ${statusChanges.length} changed`);
  console.log(`  no longer in SIS:  ${vanished.length} (left untouched)`);

  console.log("\nUpserting...");
  let updated = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500).map(toCourseRow);
    const { error } = await supabase
      .from("courses")
      .upsert(chunk, { onConflict: "offering_name,section_name,term" });
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
    updated += chunk.length;
    process.stdout.write(`\r  ${updated}/${fresh.length}`);
  }
  console.log("");

  if (newSections.length > 0) {
    await backfillNewSections(term, newSections);
  }

  const { count } = await supabase
    .from("courses")
    .select("*", { count: "exact", head: true })
    .eq("term", term);
  await supabase
    .from("available_terms")
    .update({ course_count: count ?? fresh.length, has_sis_data: true })
    .eq("term", term);

  console.log("\n--- summary ---");
  console.log(`term:            ${term}`);
  console.log(`fetched:         ${fresh.length}`);
  console.log(`rows in table:   ${count}`);
  if (newSections.length > 0) {
    console.log(`\nNew sections (${newSections.length}):`);
    for (const c of newSections.slice(0, 40)) {
      console.log(`  ${c.OfferingName} (${c.SectionName}) ${c.Title} — ${c.Instructors || "TBA"}`);
    }
    if (newSections.length > 40) console.log(`  ...and ${newSections.length - 40} more`);
  }
  if (statusChanges.length > 0) {
    console.log(`\nStatus changes (${statusChanges.length}):`);
    for (const line of statusChanges.slice(0, 40)) console.log(`  ${line}`);
    if (statusChanges.length > 40) console.log(`  ...and ${statusChanges.length - 40} more`);
  }
  if (seatChanges.length > 0) {
    console.log(`\nSeat/waitlist changes (${seatChanges.length}, first 40):`);
    for (const line of seatChanges.slice(0, 40)) console.log(`  ${line}`);
  }
}

/**
 * The seat sync only stores the top-level section fields (not SectionDetails),
 * so a section that is new to the table lands with description/prereq/eval
 * columns empty. Copy them from the most recent other term of the same
 * offering (same fallback the ingest script uses).
 */
async function backfillNewSections(term: string, newSections: SISCourse[]) {
  console.log(`\nBackfilling metadata for ${newSections.length} new sections...`);
  const offerings = [...new Set(newSections.map((c) => c.OfferingName))];

  const donors = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < offerings.length; i += 200) {
    const slice = offerings.slice(i, i + 200);
    const rows = await selectAll<Record<string, any>>(() =>
      supabase
        .from("courses")
        .select(
          "offering_name, term, description, prerequisites, corequisites, restrictions, all_departments, pos_tags, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents"
        )
        .in("offering_name", slice)
        .neq("term", term)
        .order("offering_name", { ascending: true })
    );
    for (const r of rows) {
      const prev = donors.get(r.offering_name);
      const better = !prev || (r.description && !prev.description) || (r.overall_quality != null && prev.overall_quality == null);
      if (better) donors.set(r.offering_name, r);
    }
  }

  let filled = 0;
  for (const c of newSections) {
    const d = donors.get(c.OfferingName);
    if (!d) continue;
    const { error } = await supabase
      .from("courses")
      .update({
        description: d.description ?? "",
        prerequisites: d.prerequisites ?? "",
        corequisites: d.corequisites ?? "",
        restrictions: d.restrictions ?? "",
        all_departments: d.all_departments ?? "",
        pos_tags: d.pos_tags ?? "",
        overall_quality: d.overall_quality ?? null,
        instructor_effectiveness: d.instructor_effectiveness ?? null,
        intellectual_challenge: d.intellectual_challenge ?? null,
        workload: d.workload ?? null,
        feedback_usefulness: d.feedback_usefulness ?? null,
        num_evaluations: d.num_evaluations ?? 0,
        num_respondents: d.num_respondents ?? 0,
      })
      .eq("offering_name", c.OfferingName)
      .eq("section_name", c.SectionName)
      .eq("term", term);
    if (!error) filled++;
  }
  console.log(`  backfilled ${filled}/${newSections.length} (rest are offerings with no prior term)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
