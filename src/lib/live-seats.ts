/**
 * Reading seats straight from SIS, and folding what comes back into the table.
 *
 * The stored numbers come from a cron that can only run once a day on Hobby,
 * so during registration week they can be hours old. This is shared by the
 * `/api/seats` route, which the UI calls for the course someone is looking at,
 * and by the chat agent, which is asked things like "how many people are
 * waitlisted in my classes" and should not answer those from yesterday.
 *
 * SIS has no batch endpoint — repeated params return one course, comma-joining
 * them returns none — so this is one upstream request per course, run in
 * parallel and capped. A single course is ~250ms.
 */
import { fetchCourse, toCourseRow, SISApiError, type SISCourse } from "@/lib/sis-api";
import { createClient } from "@supabase/supabase-js";

/** Seats for one section. Strings, exactly as SIS and the `courses` table hold them. */
export type LiveSection = {
  open_seats: string | null;
  max_seats: string | null;
  waitlisted: string | null;
  status: string | null;
};

/**
 * A seat count as a number, or nothing.
 *
 * SIS sends these as strings and sends the literal "N/A" for a section with no
 * waitlist, so `Number()` alone yields NaN and a bare null check lets "N/A"
 * through. Anything that is not a finite number comes back as null, because
 * the caller's job is then to say nothing rather than to print a 0 — a 0 reads
 * as "nobody waiting" when it may mean "not published".
 */
export function seatNumber(v?: number | string | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How many courses one call may ask about — the ceiling on what it costs SIS. */
export const MAX_CODES = 12;

/** Upstream requests in flight at once, so a 12-code ask does not open 12 sockets. */
const CONCURRENCY = 6;

/**
 * How long a fetched course stays good.
 *
 * Fluid Compute reuses a function instance across requests, so this really
 * does spare SIS repeat lookups of whatever course everyone is looking at —
 * but an instance can be recycled at any moment, which makes it a best-effort
 * saving and never something correctness depends on. A minute is short enough
 * that a seat taken while someone reads a card shows up on their next click.
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

/** Keep the map from growing without bound on a long-lived instance. */
function cacheSet(key: string, entry: Entry) {
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  }
  cache.set(key, entry);
}

/**
 * How long to wait on one course before giving up on it.
 *
 * `fetch` has no timeout of its own, so without this a SIS that accepts the
 * connection and then stalls would hold the caller open until the platform
 * killed it — and one of those callers is the chat agent, mid-answer. Giving
 * up is cheap here: the course keeps the numbers the table already holds.
 */
const TIMEOUT_MS = 4_000;

function withTimeout<T>(work: Promise<T>, code: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`SIS timed out for ${code}`)), TIMEOUT_MS),
    ),
  ]);
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

export type LiveSeatsResult = {
  /** Course code -> section name -> seats. Only courses SIS answered for. */
  courses: Record<string, Record<string, LiveSection>>;
  /** Codes SIS would not answer for; their stored numbers still stand. */
  failed: string[];
  /** Everything SIS returned, for the caller to write back. */
  rows: SISCourse[];
};

export async function fetchLiveSeats(codes: string[], term: string): Promise<LiveSeatsResult> {
  const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].slice(0, MAX_CODES);
  const out: LiveSeatsResult = { courses: {}, failed: [], rows: [] };
  if (wanted.length === 0) return out;

  const apiKey = process.env.JHU_API_KEY;
  // No key is not an error the caller should care about: it just means there
  // is nothing fresher than what the table already holds.
  if (!apiKey) {
    out.failed = wanted;
    return out;
  }

  await mapLimit(wanted, async (code) => {
    const key = `${term}|${code}`;
    const hit = cacheGet(key);
    if (hit) {
      out.courses[code] = hit.sections;
      return;
    }
    try {
      const rows = await withTimeout(fetchCourse(code, term, apiKey), code);
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
      out.courses[code] = sections;
      out.rows.push(...rows);
    } catch (err) {
      // A course SIS will not answer for simply keeps its stored numbers.
      out.failed.push(code);
      if (!(err instanceof SISApiError)) console.error(`live-seats: ${code}`, err);
    }
  });

  return out;
}

/**
 * Write what SIS just returned into `courses`.
 *
 * Deliberately the same shape the nightly sync writes, rather than an update
 * of the three seat columns: a section SIS lists that the table has not seen
 * yet then lands as a complete row instead of a stub with nothing but seats.
 * Columns the sync does not own — description, evaluations, POS tags — are not
 * in the payload, so `on conflict do update` leaves them untouched.
 *
 * Callers running inside a request should hand this to `after` from
 * next/server: the function can be frozen the moment it responds, which would
 * leave a bare floating promise unfinished.
 */
export async function persistLiveSeats(rows: SISCourse[]) {
  if (rows.length === 0) return;
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
  if (error) console.error("live-seats: upsert failed", error.message);
}
