/**
 * Data access layer that works with both SQLite (dev) and Supabase (prod).
 * In dev, uses SQLite for fast local queries.
 * In prod (Vercel), uses Supabase since SQLite file isn't available.
 */
import { supabase } from "./supabase";
import type DatabaseType from "better-sqlite3";

// Native module (better-sqlite3) loaded lazily so the bundle can run on
// Vercel where the sqlite binary isn't available — fall back to Supabase.
let _db: DatabaseType.Database | null = null;
let _hasDb = true;

function getDb(): DatabaseType.Database | null {
  if (!_hasDb) return null;
  if (_db) return _db;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof DatabaseType;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    _db = new Database(path.join(process.cwd(), "courses.db"));
    _db.pragma("journal_mode = WAL");
    return _db;
  } catch {
    _hasDb = false;
    return null;
  }
}

/** Get POS tags for a list of course codes */
export async function getPosTags(codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();

  const db = getDb();
  if (db) {
    const rows = db
      .prepare(`SELECT offering_name, pos_tags FROM courses WHERE offering_name IN (${codes.map(() => "?").join(",")}) AND pos_tags != '' GROUP BY offering_name`)
      .all(...codes) as { offering_name: string; pos_tags: string }[];
    return new Map(rows.map((r) => [r.offering_name, r.pos_tags]));
  }

  const { data } = await supabase
    .from("courses")
    .select("offering_name, pos_tags")
    .in("offering_name", codes)
    .neq("pos_tags", "")
    .limit(1000);

  const map = new Map<string, string>();
  if (data) {
    for (const r of data) {
      if (r.pos_tags && !map.has(r.offering_name)) {
        map.set(r.offering_name, r.pos_tags);
      }
    }
  }
  return map;
}

/** Get POS tags for a single course */
export async function getCoursePosTags(code: string): Promise<string[]> {
  const db = getDb();
  if (db) {
    const row = db
      .prepare("SELECT pos_tags FROM courses WHERE offering_name = ? AND pos_tags != '' LIMIT 1")
      .get(code) as { pos_tags: string } | undefined;
    return row?.pos_tags ? row.pos_tags.split(",") : [];
  }

  const { data } = await supabase
    .from("courses")
    .select("pos_tags")
    .eq("offering_name", code)
    .neq("pos_tags", "")
    .limit(1);

  return data?.[0]?.pos_tags ? data[0].pos_tags.split(",") : [];
}

/** Get POS tags from the catalogue table */
export async function getCataloguePosTags(codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();

  const db = getDb();
  if (db) {
    const rows = db
      .prepare(`SELECT offering_name, pos_tags FROM catalogue WHERE offering_name IN (${codes.map(() => "?").join(",")}) AND pos_tags != ''`)
      .all(...codes) as { offering_name: string; pos_tags: string }[];
    return new Map(rows.map((r) => [r.offering_name, r.pos_tags]));
  }

  const { data } = await supabase
    .from("catalogue")
    .select("offering_name, pos_tags")
    .in("offering_name", codes)
    .neq("pos_tags", "")
    .limit(1000);

  const map = new Map<string, string>();
  if (data) {
    for (const r of data) {
      if (r.pos_tags && !map.has(r.offering_name)) {
        map.set(r.offering_name, r.pos_tags);
      }
    }
  }
  return map;
}

/** Get program schema */
export async function getProgramSchema(name: string): Promise<{ schema: string; program_url: string } | null> {
  const db = getDb();
  if (db) {
    return db
      .prepare("SELECT schema, program_url FROM program_schemas WHERE program_name = ?")
      .get(name) as { schema: string; program_url: string } | null;
  }

  const { data } = await supabase
    .from("program_schemas")
    .select("schema, program_url")
    .eq("program_name", name)
    .limit(1)
    .single();

  return data;
}

/** Get full program schema row (including school) */
export async function getProgramSchemaFull(name: string): Promise<{ program_name: string; program_url: string; school: string; schema: string } | null> {
  const db = getDb();
  if (db) {
    return db
      .prepare("SELECT program_name, program_url, school, schema FROM program_schemas WHERE program_name = ?")
      .get(name) as { program_name: string; program_url: string; school: string; schema: string } | null;
  }

  const { data } = await supabase
    .from("program_schemas")
    .select("program_name, program_url, school, schema")
    .eq("program_name", name)
    .limit(1)
    .single();

  return data;
}

/** List visible programs */
export async function getVisiblePrograms(): Promise<{ program_name: string; school: string }[]> {
  const db = getDb();
  if (db) {
    return db
      .prepare("SELECT program_name, school FROM program_schemas WHERE visible = 1 ORDER BY school, program_name")
      .all() as { program_name: string; school: string }[];
  }

  const { data } = await supabase
    .from("program_schemas")
    .select("program_name, school")
    .eq("visible", 1)
    .order("program_name");

  return data || [];
}

/**
 * Whether a term has SIS section data, or only catalogue entries.
 *
 * Cached briefly: the chat route needs this before it can call the model, and
 * `available_terms` only changes when an ingest runs.
 */
const SIS_DATA_CACHE_MS = 300_000;
const sisDataCache = new Map<string, { value: boolean; at: number }>();

export async function termHasSisData(term: string): Promise<boolean> {
  const hit = sisDataCache.get(term);
  if (hit && Date.now() - hit.at < SIS_DATA_CACHE_MS) return hit.value;

  const value = await fetchTermHasSisData(term);
  sisDataCache.set(term, { value, at: Date.now() });
  return value;
}

async function fetchTermHasSisData(term: string): Promise<boolean> {
  const db = getDb();
  if (db) {
    const row = db
      .prepare("SELECT has_sis_data FROM available_terms WHERE term = ?")
      .get(term) as { has_sis_data: number } | undefined;
    return row ? row.has_sis_data === 1 : false;
  }

  const { data } = await supabase
    .from("available_terms")
    .select("has_sis_data")
    .eq("term", term)
    .maybeSingle();

  return data?.has_sis_data ?? false;
}

/** Get program tags for a specific program */
export async function getProgramTags(programName: string) {
  const db = getDb();
  if (db) {
    return db
      .prepare(`SELECT offering_name, course_title, credits, requirement_type, is_alternative, notes, section_h2, section_h3, level, is_placeholder, pos_tag
         FROM program_tags WHERE program_name = ? ORDER BY id`)
      .all(programName) as {
      section_h2: string;
      section_h3: string;
      level: number;
      offering_name: string | null;
      course_title: string;
      credits: string;
      requirement_type: string;
      is_alternative: number;
      is_placeholder: number;
      pos_tag: string;
      notes: string;
    }[];
  }

  const { data } = await supabase
    .from("program_tags")
    .select("offering_name, course_title, credits, requirement_type, is_alternative, notes, section_h2, section_h3, level, is_placeholder, pos_tag")
    .eq("program_name", programName)
    .order("id");

  return (data || []) as {
    section_h2: string;
    section_h3: string;
    level: number;
    offering_name: string | null;
    course_title: string;
    credits: string;
    requirement_type: string;
    is_alternative: number;
    is_placeholder: number;
    pos_tag: string;
    notes: string;
  }[];
}

/** Get the program URL from program_tags */
export async function getProgramTagUrl(programName: string): Promise<string | null> {
  const db = getDb();
  if (db) {
    const row = db
      .prepare("SELECT program_url FROM program_tags WHERE program_name = ? LIMIT 1")
      .get(programName) as { program_url: string } | undefined;
    return row?.program_url || null;
  }

  const { data } = await supabase
    .from("program_tags")
    .select("program_url")
    .eq("program_name", programName)
    .limit(1)
    .single();

  return data?.program_url || null;
}

/** Search programs by name */
export async function searchPrograms(query: string): Promise<{ program_name: string; school: string }[]> {
  const db = getDb();
  if (db) {
    return db
      .prepare("SELECT DISTINCT program_name, school FROM program_tags WHERE program_name LIKE ? ORDER BY program_name")
      .all(`%${query}%`) as { program_name: string; school: string }[];
  }

  const { data } = await supabase
    .from("program_tags")
    .select("program_name, school")
    .ilike("program_name", `%${query}%`)
    .order("program_name");

  // Deduplicate
  const seen = new Set<string>();
  return (data || []).filter((r) => {
    if (seen.has(r.program_name)) return false;
    seen.add(r.program_name);
    return true;
  });
}

/** Search programs with course counts */
export async function searchProgramsWithCounts(query: string) {
  const db = getDb();
  if (db) {
    return db
      .prepare(`SELECT DISTINCT program_name, school, COUNT(offering_name) as course_count
         FROM program_tags WHERE program_name LIKE ? GROUP BY program_name ORDER BY program_name`)
      .all(`%${query}%`) as { program_name: string; school: string; course_count: number }[];
  }

  const { data } = await supabase
    .from("program_tags")
    .select("program_name, school, offering_name")
    .ilike("program_name", `%${query}%`);

  if (!data) return [];

  const map = new Map<string, { program_name: string; school: string; course_count: number }>();
  for (const r of data) {
    if (!map.has(r.program_name)) {
      map.set(r.program_name, { program_name: r.program_name, school: r.school, course_count: 0 });
    }
    if (r.offering_name) map.get(r.program_name)!.course_count++;
  }
  return [...map.values()];
}

/** Get program tag rows for loading as requirements */
export async function getProgramTagCodes(programName: string): Promise<{ offering_name: string; requirement_type: string }[]> {
  const db = getDb();
  if (db) {
    return db
      .prepare("SELECT offering_name, requirement_type FROM program_tags WHERE program_name = ? AND offering_name IS NOT NULL ORDER BY id")
      .all(programName) as { offering_name: string; requirement_type: string }[];
  }

  const { data } = await supabase
    .from("program_tags")
    .select("offering_name, requirement_type")
    .eq("program_name", programName)
    .not("offering_name", "is", null)
    .order("id");

  return data || [];
}

/** List all programs with tags */
export async function listProgramsWithTags() {
  const db = getDb();
  if (db) {
    return db
      .prepare(`SELECT program_name, school, COUNT(*) as req_count, COUNT(DISTINCT offering_name) as course_count
       FROM program_tags GROUP BY program_name ORDER BY school, program_name`)
      .all() as { program_name: string; school: string; req_count: number; course_count: number }[];
  }

  const { data } = await supabase
    .from("program_tags")
    .select("program_name, school, offering_name");

  if (!data) return [];

  const map = new Map<string, { program_name: string; school: string; req_count: number; course_count: Set<string> }>();
  for (const r of data) {
    if (!map.has(r.program_name)) {
      map.set(r.program_name, { program_name: r.program_name, school: r.school, req_count: 0, course_count: new Set() });
    }
    const m = map.get(r.program_name)!;
    m.req_count++;
    if (r.offering_name) m.course_count.add(r.offering_name);
  }

  return [...map.values()].map((r) => ({
    program_name: r.program_name,
    school: r.school,
    req_count: r.req_count,
    course_count: r.course_count.size,
  }));
}
