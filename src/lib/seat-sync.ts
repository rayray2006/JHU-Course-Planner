/**
 * Removing sections SIS has stopped listing.
 *
 * The sync only ever upserted, so a section that was cancelled or unpublished
 * stayed in `courses` forever — still carrying the seat count it had on the day
 * it vanished, so it reads as a live, bookable class. Spring 2027 had 50 of
 * these across the three schools (fifteen sections of one Senior Thesis among
 * them), all showing "Open".
 *
 * Deleting is riskier than upserting, so this is deliberately timid: it works
 * one school at a time, only for a school whose fetch actually succeeded, and
 * it refuses to act at all when the share of rows it would remove looks more
 * like a bad SIS response than a handful of cancellations.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const sectionKey = (offering: string, section: string) => `${offering}|${section}`;

export type PruneResult = {
  school: string;
  /** Rows stored for this school and term. */
  stored: number;
  /** Stored rows SIS no longer lists. */
  ghosts: number;
  deletedCourses: number;
  /** Saved-schedule entries pointing at a section that has now been removed. */
  deletedScheduleRows: number;
  /** Set when nothing was deleted, saying why. */
  skipped: string | null;
  examples: string[];
};

const PAGE = 1000;
const ID_CHUNK = 200;
const KEY_CHUNK = 50;

/**
 * The most of a school's stored sections this is willing to delete in one run.
 *
 * `fetchSchoolTerm` throws on a non-200 and on a body that is not an array, so
 * the obvious failures never reach this far. What it cannot catch is SIS
 * answering 200 with a short list — a partial index, a term half-published —
 * and that would look exactly like "most of this school was cancelled". Real
 * cancellations run near 1% of a school, so anything past 10% is treated as a
 * bad response and left alone for a human to look at.
 */
const DEFAULT_MAX_SHARE = 0.1;

export async function pruneGhostSections(
  supabase: SupabaseClient,
  term: string,
  school: string,
  /** Keys SIS currently lists for this school, via {@link sectionKey}. */
  liveKeys: Set<string>,
  opts: { maxShare?: number; dryRun?: boolean } = {},
): Promise<PruneResult> {
  const maxShare = opts.maxShare ?? DEFAULT_MAX_SHARE;
  const out: PruneResult = {
    school,
    stored: 0,
    ghosts: 0,
    deletedCourses: 0,
    deletedScheduleRows: 0,
    skipped: null,
    examples: [],
  };

  // PostgREST caps a select at 1000 rows. An unpaginated read here would make
  // every section past the cap look absent from SIS, which is the one mistake
  // this function must not make.
  const stored: { id: number; offering_name: string; section_name: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("courses")
      .select("id, offering_name, section_name")
      .eq("term", term)
      .eq("school_name", school)
      .range(from, from + PAGE - 1);
    if (error) {
      out.skipped = `could not read stored sections: ${error.message}`;
      return out;
    }
    if (!data?.length) break;
    stored.push(...data);
    if (data.length < PAGE) break;
  }

  out.stored = stored.length;
  if (stored.length === 0) return out;

  if (liveKeys.size === 0) {
    out.skipped = "SIS listed no sections for this school";
    return out;
  }

  const ghosts = stored.filter((r) => !liveKeys.has(sectionKey(r.offering_name, r.section_name)));
  out.ghosts = ghosts.length;
  out.examples = ghosts.slice(0, 10).map((g) => sectionKey(g.offering_name, g.section_name));
  if (ghosts.length === 0) return out;

  if (ghosts.length / stored.length > maxShare) {
    out.skipped =
      `${ghosts.length} of ${stored.length} stored sections were missing from the SIS response ` +
      `(over ${Math.round(maxShare * 100)}%), which reads as an incomplete response rather than ` +
      `cancellations — nothing deleted`;
    return out;
  }

  if (opts.dryRun) {
    out.skipped = "dry run";
    return out;
  }

  // Courses first. If the schedule cleanup below fails, the cost is a saved
  // entry that renders nothing; doing it the other way round could delete
  // someone's saved course while the section itself survives.
  for (let i = 0; i < ghosts.length; i += ID_CHUNK) {
    const ids = ghosts.slice(i, i + ID_CHUNK).map((g) => g.id);
    const { data, error } = await supabase.from("courses").delete().in("id", ids).select("id");
    if (error) {
      out.skipped = `delete failed after ${out.deletedCourses} rows: ${error.message}`;
      return out;
    }
    out.deletedCourses += data?.length ?? 0;
  }

  // A saved schedule entry is matched by name, not by a foreign key, so
  // deleting the course leaves the entry behind — invisible on the calendar
  // (the lookup finds nothing) but still counted in the schedule picker, which
  // would show "3 courses" over two blocks. The section no longer exists, so
  // the entry goes with it.
  for (let i = 0; i < ghosts.length; i += KEY_CHUNK) {
    const orFilter = ghosts
      .slice(i, i + KEY_CHUNK)
      .map((g) => `and(offering_name.eq.${g.offering_name},section_name.eq.${g.section_name})`)
      .join(",");
    const { data, error } = await supabase
      .from("schedules")
      .delete()
      .eq("term", term)
      .or(orFilter)
      .select("id");
    if (error) {
      out.skipped = `courses removed, but saved schedules could not be cleaned up: ${error.message}`;
      return out;
    }
    out.deletedScheduleRows += data?.length ?? 0;
  }

  return out;
}
