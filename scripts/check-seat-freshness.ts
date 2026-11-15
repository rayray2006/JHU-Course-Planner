/**
 * Read-only: how stale are the stored open_seats?
 *
 * Pulls one school straight from SIS and diffs it against what the `courses`
 * table holds. Writes nothing — the point is to find out whether the nightly
 * cron is actually landing before anyone decides to show these numbers more
 * prominently.
 *
 *   npx tsx --env-file=.env.local scripts/check-seat-freshness.ts
 */
import { createClient } from "@supabase/supabase-js";
import { fetchSchoolTerm } from "../src/lib/sis-api";

const SCHOOL = "Whiting School of Engineering";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  );

  const { data: termRow } = await supabase
    .from("available_terms")
    .select("term")
    .eq("is_current", true)
    .maybeSingle();
  const term = termRow?.term as string;
  console.log(`current term: ${term}`);

  const live = await fetchSchoolTerm(SCHOOL, term, process.env.JHU_API_KEY!);
  console.log(`SIS returned ${live.length} sections for ${SCHOOL}`);

  // PostgREST caps a response at 1000 rows, so an unpaginated read here
  // silently truncates and every section past the cap looks "missing from the
  // DB". Page explicitly rather than trusting one request to return the lot.
  const PAGE = 1000;
  const stored: { offering_name: string; section_name: string; open_seats: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("courses")
      .select("offering_name, section_name, open_seats, max_seats")
      .eq("term", term)
      .eq("school_name", SCHOOL)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    stored.push(...data);
    if (data.length < PAGE) break;
  }

  const byKey = new Map(
    stored.map((r) => [`${r.offering_name}|${r.section_name}`, r]),
  );
  console.log(`DB holds ${byKey.size} sections for that school\n`);

  let same = 0;
  let differs = 0;
  let missing = 0;
  const examples: string[] = [];

  for (const c of live) {
    const key = `${c.OfferingName}|${c.SectionName}`;
    const row = byKey.get(key);
    if (!row) {
      missing++;
      continue;
    }
    if (String(row.open_seats) === String(c.OpenSeats)) same++;
    else {
      differs++;
      if (examples.length < 12) {
        examples.push(`  ${key}  stored ${row.open_seats} -> live ${c.OpenSeats}`);
      }
    }
  }

  console.log(`matching open_seats: ${same}`);
  console.log(`differing:           ${differs}`);
  console.log(`in SIS, not in DB:   ${missing}`);
  if (examples.length) {
    console.log("\nexamples of drift:");
    console.log(examples.join("\n"));
  }
  const total = same + differs;
  if (total) {
    console.log(`\n${((differs / total) * 100).toFixed(1)}% of sections have a stale seat count`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
