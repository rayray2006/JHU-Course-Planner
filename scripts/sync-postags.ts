/**
 * Populate `courses.pos_tags` in Supabase from the JHU Typesense index.
 *
 * Program-of-Study tags (BMED-BDS, CSCI-APPL, ROBO-CMCS …) are what the
 * degree checker and the chat agent's tag search match on. `ingest-postags.ts`
 * writes them, but it writes to local SQLite and keys its UPDATE on
 * `offering_name` alone — so it only ever tags course rows that already
 * existed when it last ran. Spring 2027 was ingested afterwards and came out
 * with zero tagged rows, while every other term has ~1,100, which makes every
 * tag search for the current term return nothing.
 *
 * Tags are a property of the course, not the section or the term: the index is
 * read across all sections and folded by offering name, which is how the
 * earlier terms were populated too.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/sync-postags.ts --dry
 *   npx tsx --env-file=.env.local scripts/sync-postags.ts --term "Spring 2027"
 *   npx tsx --env-file=.env.local scripts/sync-postags.ts
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const DRY = process.argv.includes("--dry");
const termIdx = process.argv.indexOf("--term");
const TERM = termIdx !== -1 ? process.argv[termIdx + 1] : null;

type Row = { id: number; term: string; offering_name: string; pos_tags: string | null };

async function getTypesenseConfig() {
  const res = await fetch("https://api.sis.jhu.edu/api/coursesearch/configuration");
  const json = await res.json();
  const config = json.data || json;
  return {
    host: config.typesenseHostNodes?.[0] as string,
    apiKey: config.typesenseApiKey as string,
    collection: (config.typesenseSchemaName || "sections") as string,
  };
}

/** offering_name -> sorted, comma-joined tag list, folded across all sections. */
async function fetchTagsByCode(): Promise<Map<string, string>> {
  const config = await getTypesenseConfig();
  const tags = new Map<string, Set<string>>();
  const perPage = 250;

  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      q: "*",
      per_page: String(perPage),
      page: String(page),
      include_fields: "OfferingName,PosTags",
      filter_by: "PosTags:![]",
    });
    const url = `https://${config.host}/collections/${config.collection}/documents/search?${params}`;
    const res = await fetch(url, { headers: { "X-TYPESENSE-API-KEY": config.apiKey } });
    if (!res.ok) throw new Error(`Typesense page ${page}: ${res.status}`);

    const result = (await res.json()) as {
      hits: { document: { OfferingName: string; PosTags?: string[] } }[];
      found: number;
    };
    if (page === 1) console.log(`  ${result.found} indexed sections carry tags`);

    for (const hit of result.hits) {
      const code = hit.document.OfferingName;
      for (const tag of hit.document.PosTags || []) {
        if (!tags.has(code)) tags.set(code, new Set());
        // JHU's own data carries both "BMED-BDS" and "BMED–BDS" (en dash).
        // Fold to the hyphen so a search for one finds the other.
        tags.get(code)!.add(tag.replace(/–|—/g, "-"));
      }
    }

    if (result.hits.length < perPage) break;
    if (page % 10 === 0) await new Promise((r) => setTimeout(r, 100));
  }

  return new Map([...tags].map(([code, set]) => [code, [...set].sort().join(",")]));
}

async function fetchRows(): Promise<Row[]> {
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("courses")
      .select("id, term, offering_name, pos_tags")
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
  console.log(`Fetching tags from the SIS index...`);
  const tagsByCode = await fetchTagsByCode();
  console.log(`  ${tagsByCode.size} distinct courses have tags`);

  console.log(`\nReading${TERM ? ` term "${TERM}"` : " all terms"}...`);
  const rows = await fetchRows();
  console.log(`  ${rows.length} course rows`);

  // Only write where the stored value actually differs, so re-running is a
  // no-op and an unrelated ingest is never clobbered.
  const stale = rows
    .map((row) => ({ row, tags: tagsByCode.get(row.offering_name) ?? "" }))
    .filter(({ row, tags }) => tags !== "" && tags !== (row.pos_tags ?? ""));

  if (stale.length === 0) {
    console.log("\n  Nothing to write — every row already matches the index.");
    return;
  }

  const byTerm = new Map<string, number>();
  for (const { row } of stale) byTerm.set(row.term, (byTerm.get(row.term) ?? 0) + 1);
  console.log(`\n  ${stale.length} rows need tags:`);
  for (const [term, n] of [...byTerm].sort()) console.log(`    ${term}: ${n}`);

  console.log("\n  Examples:");
  for (const { row, tags } of stale.slice(0, 5)) {
    console.log(`    ${row.offering_name} (${row.term}): ${JSON.stringify(row.pos_tags ?? "")} -> ${tags}`);
  }

  if (DRY) {
    console.log("\nDry run — nothing written. Re-run without --dry to apply.");
    return;
  }

  // Group by target value so identical writes go up as one request each.
  const groups = new Map<string, number[]>();
  for (const { row, tags } of stale) {
    if (!groups.has(tags)) groups.set(tags, []);
    groups.get(tags)!.push(row.id);
  }

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const [tags, ids] of groups) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { error } = await supabase.from("courses").update({ pos_tags: tags }).in("id", chunk);
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

  console.log(`\nDone. Updated ${updated} rows${failed ? `, ${failed} failed (${firstError})` : ""}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
