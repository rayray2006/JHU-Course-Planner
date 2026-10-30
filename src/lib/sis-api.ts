/**
 * Client for the SIS Course Search Web API (the Typesense-backed rewrite of
 * https://sis.jhu.edu/api). Shared by the ingest scripts and the seat-sync cron
 * so every caller builds URLs, handles errors, and maps fields the same way.
 *
 * Endpoints (all need ?key=):
 *   GET /classes?Term=..&School=..        query-string search (>=1 filter required)
 *   GET /classes/{school}/{term}          everything for a school + term
 *   GET /classes/{courseId}/{term}        one course (EN.601.226 or EN601226)
 *   GET /classes/codes/{schools|terms}    lookup lists
 *
 * Errors come back as JSON `{ "Message": "..." }` with a 400/401 status.
 * Search results are one record per section per term and now carry the full
 * SectionDetails array inline (description, prereqs, PosTags, ...), so payloads
 * are much larger than before.
 */

/** Overridable so the cutover to the new host is a config change, not a deploy. */
export const SIS_API_BASE = (process.env.JHU_SIS_API_BASE || "https://sis.jhu.edu/api").replace(/\/+$/, "");

export interface SISMeeting {
  Building: string;
  Dates: string;
  DOW: string;
  /** @deprecated no longer supplied by the new API; always "" */
  Location: string;
  /** @deprecated no longer supplied by the new API; always "" */
  Room: string;
  Times: string;
}

export interface SISSectionDetails {
  CoRequisites: { Description: string; Expression: string; TermName: string }[];
  Credits: string;
  CreditType: string;
  Departments: string;
  DepartmentID: string;
  Description: string;
  EvaluationUrls: { URL: string; ValidFrom: string; ValidTo: string }[];
  Fees: { Amount: number; FeeType: string }[];
  Meetings: SISMeeting[];
  PosTags: { Tag: string }[];
  Prerequisites: { Description: string; Expression: string; IsNegative: boolean }[];
  Restrictions: { Description: string; RestrictionName: string }[];
  WebNotes: string;
  IsCrossListed: boolean;
  Instructors: { HopkinsID: string }[];
  Equivalencies: { CourseName: string; ValidFrom: string; ValidTo: string }[];
}

/** One section record as returned by every search endpoint. */
export interface SISCourse {
  OfferingName: string;
  SectionName: string;
  Title: string;
  Credits: string;
  Department: string;
  /** Caret-separated, e.g. "AS History^AS International Studies" */
  AllDepartments: string;
  SubDepartment: string;
  CoursePrefix: string;
  SchoolName: string;
  Level: string;
  Status: string;
  DOW: string;
  DOWSort: string;
  TimeOfDay: string;
  Meetings: string;
  Location: string;
  Building: string;
  InstructionMethod: string;
  Instructors: string;
  InstructorsFullName: string;
  HasBio: string | null;
  MaxSeats: string;
  OpenSeats: string;
  SeatsAvailable: string;
  Waitlisted: string;
  IsWritingIntensive: string;
  /** Caret-separated area descriptions with codes, e.g. "Humanities (H)^Science and Data (FA2)", or "None" */
  Areas: string;
  Repeatable: string;
  Term: string;
  Term_IDR: string;
  Term_JSS: string;
  TermStartDate: string;
  SSS_SectionsID: string;
  SectionCoReqNotes: string;
  SectionCoRequisites: string;
  SectionRegRestrictions: string;
  SectionDetails: SISSectionDetails[];
}

export class SISApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly url: string) {
    super(`SIS API ${status}: ${message}`);
    this.name = "SISApiError";
  }
}

function buildUrl(path: string, key: string, params?: Record<string, string | string[]>): string {
  const url = new URL(`${SIS_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, value);
    }
  }
  url.searchParams.set("key", key);
  return url.toString();
}

async function sisFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let message = res.statusText || "request failed";
    try {
      const body = (await res.json()) as { Message?: string };
      if (body?.Message) message = body.Message;
    } catch {
      /* non-JSON error body */
    }
    throw new SISApiError(res.status, message, url.replace(/([?&]key=)[^&]*/, "$1***"));
  }
  return (await res.json()) as T;
}

/** GET /classes/{school}/{term} — every section a school offers in a term. */
export async function fetchSchoolTerm(school: string, term: string, key: string): Promise<SISCourse[]> {
  const url = buildUrl(`/classes/${encodeURIComponent(school)}/${encodeURIComponent(term)}`, key);
  const rows = await sisFetch<unknown>(url);
  if (!Array.isArray(rows)) throw new SISApiError(200, "expected a JSON array of sections", url);
  return (rows as SISCourse[]).map(normalizeCourse);
}

/** GET /classes/{courseId}/{term} — accepts EN.601.226 or EN601226, optionally with a section suffix. */
export async function fetchCourse(courseId: string, term: string, key: string): Promise<SISCourse[]> {
  const url = buildUrl(`/classes/${encodeURIComponent(courseId)}/${encodeURIComponent(term)}`, key);
  return (await sisFetch<SISCourse[]>(url)).map(normalizeCourse);
}

/** GET /classes?... — at least one filter is required by the API. */
export async function searchClasses(params: Record<string, string | string[]>, key: string): Promise<SISCourse[]> {
  return (await sisFetch<SISCourse[]>(buildUrl("/classes", key, params))).map(normalizeCourse);
}

export async function fetchSchools(key: string): Promise<string[]> {
  const rows = await sisFetch<{ Name: string }[]>(buildUrl("/classes/codes/schools", key));
  return rows.map((r) => r.Name);
}

export async function fetchTerms(key: string): Promise<string[]> {
  const rows = await sisFetch<{ Name: string }[]>(buildUrl("/classes/codes/terms", key));
  return rows.map((r) => r.Name);
}

const DISTRIBUTION_CODES = new Set(["E", "H", "N", "Q", "S"]);

/**
 * Convert the new Areas format to the one already stored in the database and
 * expected by the search tools, degree-progress checker, and course detail UI.
 *
 *   new: "Humanities (H)^Social & Behavioral Sciences (S)^Science and Data (FA2)"
 *   old: "HS, Science and Data"
 *
 * Distribution letters (E/H/N/Q/S) collapse into one token; foundational
 * abilities keep their name and drop the code. Values already in the old
 * format (or "None") pass through unchanged, so re-ingesting old-API data or
 * running against the legacy host is safe.
 */
export function normalizeAreas(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (!s.includes("^") && !/\([A-Z][A-Z0-9.]*(eP)?\)$/.test(s)) return s;

  const letters = new Set<string>();
  const names = new Set<string>();
  for (const part of s.split("^")) {
    const p = part.trim();
    if (!p || p === "None") continue;
    const m = p.match(/^(.*?)\s*\(([A-Z][A-Za-z0-9.]*)\)$/);
    if (!m) {
      names.add(p);
      continue;
    }
    const [, name, code] = m;
    if (DISTRIBUTION_CODES.has(code)) letters.add(code);
    else names.add(name.trim());
  }
  const tokens = [...names];
  if (letters.size) tokens.push([...letters].sort().join(""));
  if (tokens.length === 0) return "None";
  return tokens.sort((a, b) => a.localeCompare(b)).join(", ");
}

/** The search tool exposes a fixed status enum; keep the stored values inside it. */
export function normalizeStatus(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (/^wait ?list$/i.test(s)) return "Waitlist Only";
  return s;
}

/** Apply every format shim in one place so callers can treat records uniformly. */
export function normalizeCourse(c: SISCourse): SISCourse {
  return { ...c, Areas: normalizeAreas(c.Areas), Status: normalizeStatus(c.Status) };
}

/** Column mapping for the `courses` table (SQLite and Supabase share it). */
export function toCourseRow(c: SISCourse) {
  return {
    offering_name: c.OfferingName,
    section_name: c.SectionName,
    title: c.Title,
    credits: c.Credits,
    department: c.Department,
    school_name: c.SchoolName,
    level: c.Level,
    status: c.Status,
    dow: c.DOW,
    time_of_day: c.TimeOfDay,
    meetings: c.Meetings,
    location: c.Location,
    building: c.Building,
    instruction_method: c.InstructionMethod,
    instructors: c.Instructors,
    instructors_full_name: c.InstructorsFullName,
    max_seats: c.MaxSeats,
    open_seats: c.OpenSeats,
    waitlisted: c.Waitlisted,
    is_writing_intensive: c.IsWritingIntensive,
    areas: c.Areas,
    repeatable: c.Repeatable,
    term: c.Term,
    term_start_date: c.TermStartDate,
  };
}

/** "AS History^AS International Studies" -> "AS History, AS International Studies" */
export function formatAllDepartments(raw: string | null | undefined): string {
  return (raw ?? "").split("^").map((d) => d.trim()).filter(Boolean).join(", ");
}
