import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchSchoolTerm, toCourseRow, SISApiError, type SISCourse } from "@/lib/sis-api";
import { pruneGhostSections, sectionKey, type PruneResult } from "@/lib/seat-sync";

export const maxDuration = 300;

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCurrentTerm(supabase: any): Promise<string | null> {
  const { data, error } = await supabase
    .from("available_terms")
    .select("term")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.term as string;
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.JHU_API_KEY;
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !supaUrl || !supaKey) {
    return NextResponse.json({ error: "missing env" }, { status: 500 });
  }

  const supabase = createClient(supaUrl, supaKey);
  const term = await getCurrentTerm(supabase);
  if (!term) return NextResponse.json({ error: "no current term" }, { status: 500 });

  const started = Date.now();
  const allRows: SISCourse[] = [];
  const fetchErrors: string[] = [];
  // Kept per school, because the prune below may only act on a school whose
  // fetch succeeded — one school being down must not make its stored sections
  // look cancelled.
  const liveBySchool = new Map<string, Set<string>>();
  for (const school of SCHOOLS) {
    try {
      const rows = await fetchSchoolTerm(school, term, apiKey);
      allRows.push(...rows);
      liveBySchool.set(school, new Set(rows.map((r) => sectionKey(r.OfferingName, r.SectionName))));
    } catch (err) {
      fetchErrors.push(`${school}: ${err instanceof SISApiError ? err.message : String(err)}`);
    }
  }
  if (allRows.length === 0) {
    // Nothing came back (bad key, host moved, SIS down). Leave stored data alone.
    return NextResponse.json({ term, fetched: 0, updated: 0, failed: 0, fetchErrors, durationMs: Date.now() - started }, { status: 502 });
  }

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < allRows.length; i += 500) {
    const chunk = allRows.slice(i, i + 500).map(toCourseRow);
    const { error } = await supabase
      .from("courses")
      .upsert(chunk, { onConflict: "offering_name,section_name,term" });
    if (error) {
      failed += chunk.length;
      if (!firstError) firstError = error.message;
    } else updated += chunk.length;
  }

  // Upserting alone left cancelled sections in the table for good, still
  // showing the seats they had when they disappeared. Only schools that
  // actually answered are considered.
  const pruned: PruneResult[] = [];
  for (const [school, liveKeys] of liveBySchool) {
    pruned.push(await pruneGhostSections(supabase, term, school, liveKeys));
  }

  return NextResponse.json({
    term,
    fetched: allRows.length,
    updated,
    failed,
    firstError,
    fetchErrors,
    removed: pruned.reduce((n, p) => n + p.deletedCourses, 0),
    removedFromSchedules: pruned.reduce((n, p) => n + p.deletedScheduleRows, 0),
    pruneSkipped: pruned.filter((p) => p.skipped).map((p) => `${p.school}: ${p.skipped}`),
    durationMs: Date.now() - started,
  });
}
