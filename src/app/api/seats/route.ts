/**
 * Live seat counts, straight from SIS, for courses already on screen.
 *
 * The stored numbers come from a cron that can only run once a day on Hobby,
 * so during registration week what the page paints is a 3am snapshot — a
 * section listed as having seats may have been full since breakfast. This
 * route exists to correct that one number without putting SIS in front of the
 * whole page: the UI paints from Supabase immediately and patches these values
 * in when they land, so a slow or unreachable SIS degrades to the stored data
 * rather than an empty card.
 *
 * SIS has no batch endpoint — passing several codes as repeated params returns
 * one course, comma-joining them returns none — so this is one upstream
 * request per course, run in parallel and capped. A single course is ~250ms.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchCourse, toCourseRow, SISApiError, type SISCourse } from "@/lib/sis-api";
import { CURRENT_TERM } from "@/lib/terms";

export const dynamic = "force-dynamic";

/** Seats for one section. Strings, exactly as SIS and the `courses` table hold them. */
export type LiveSection = {
  open_seats: string | null;
  max_seats: string | null;
  waitlisted: string | null;
  status: string | null;
};

/**
 * How many courses one request may ask about.
 *
 * Each is its own upstream request, so this is the ceiling on what a single
 * page view costs SIS. The detail card asks about one; the cap is here so a
 * future caller cannot turn one page view into fifty.
 */
const MAX_CODES = 12;

/** Upstream requests in flight at once, so a 12-code ask does not open 12 sockets. */
const CONCURRENCY = 6;

/**
 * How long a fetched course stays good.
 *
 * Fluid Compute reuses a function instance across requests, so this really
 * does spare SIS repeat lookups of whatever course everyone is looking at —
 * but an instance can also be recycled at any moment, which makes this a
 * best-effort saving and never something correctness depends on. A minute is
 * short enough that a seat taken while someone reads the card still shows up
 * on their next click.
 */
const TTL_MS = 60_000;

type Entry = { at: number; sections: Record<string, LiveSection>; rows: SISCourse[] };
const cache = new Map<string, Entry>();

function cacheGet(key: string): Entry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

/**
 * Keep the map from growing without bound on a long-lived instance. Entries
 * are tiny, but a term's worth of courses held forever is still a leak.
 */
function cacheSet(key: string, entry: Entry) {
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  }
  cache.set(key, entry);
}

/** Run `work` over `items`, at most CONCURRENCY at a time. */
async function mapLimit<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]);
    }),
  );
  return out;
}

export async function GET(req: NextRequest) {
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;
  const codes = [
    ...new Set(
      (req.nextUrl.searchParams.get("codes") || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_CODES);

  if (codes.length === 0) return NextResponse.json({ term, courses: {}, failed: [] });

  const apiKey = process.env.JHU_API_KEY;
  // No key is not an error the page should care about: it just means there is
  // nothing fresher than what it already drew.
  if (!apiKey) return NextResponse.json({ term, courses: {}, failed: codes, reason: "no api key" });

  const courses: Record<string, Record<string, LiveSection>> = {};
  const failed: string[] = [];
  const toPersist: SISCourse[] = [];

  await mapLimit(codes, async (code) => {
    const key = `${term}|${code}`;
    const hit = cacheGet(key);
    if (hit) {
      courses[code] = hit.sections;
      return;
    }
    try {
      const rows = await fetchCourse(code, term, apiKey);
      const sections: Record<string, LiveSection> = {};
      for (const r of rows) {
        sections[r.SectionName] = {
          open_seats: r.OpenSeats ?? null,
          max_seats: r.MaxSeats ?? null,
          waitlisted: r.Waitlisted ?? null,
          status: r.Status ?? null,
        };
      }
      cacheSet(key, { at: Date.now(), sections, rows });
      courses[code] = sections;
      toPersist.push(...rows);
    } catch (err) {
      // A course SIS will not answer for simply keeps its stored numbers.
      failed.push(code);
      if (!(err instanceof SISApiError)) console.error(`seats: ${code}`, err);
    }
  });

  // Everything SIS just told us is newer than what the table holds, so fold it
  // back in and the next page load starts from it — the cron stops being the
  // only thing keeping the table current.
  //
  // This has to outlive the response: the function can be frozen the moment it
  // returns, which would leave a bare floating promise unfinished. `after`
  // hands the work to the platform (waitUntil on Vercel) so it still lands,
  // while the caller gets its numbers without waiting for a database write.
  if (toPersist.length > 0) {
    after(async () => {
      try {
        await persist(toPersist);
      } catch (err) {
        console.error("seats: write-back failed", err);
      }
    });
  }

  return NextResponse.json({ term, courses, failed, fetchedAt: Date.now() });
}

/**
 * Write what SIS just returned into `courses`.
 *
 * Deliberately the same shape the nightly sync writes, rather than an update
 * of the three seat columns: a section SIS lists that the table has not seen
 * yet then lands as a complete row instead of a stub with nothing but seats.
 * Columns the sync does not own — description, evaluations, POS tags — are not
 * in the payload, so `on conflict do update` leaves them untouched.
 */
async function persist(rows: SISCourse[]) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;

  const supabase = createClient(url, key);
  const seen = new Set<string>();
  const payload = rows
    .filter((r) => {
      const k = `${r.OfferingName}|${r.SectionName}|${r.Term}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(toCourseRow);

  const { error } = await supabase
    .from("courses")
    .upsert(payload, { onConflict: "offering_name,section_name,term" });
  if (error) console.error("seats: upsert failed", error.message);
}
