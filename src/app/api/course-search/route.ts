import { supabase } from "@/lib/supabase";
import { getPosTags, getCataloguePosTags } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";

const COURSE_COLS =
  "offering_name, section_name, title, credits, meetings, instructors_full_name, department";

/**
 * Merge code matches ahead of title matches, dropping duplicates.
 *
 * The old route picked one column to search by testing the query against
 * /^[A-Z]{2}[.\d]/ — so "EN.601.226" searched offering_name but a bare
 * "601.226" fell through to title, where no course is named after its number,
 * and the search came back empty. Guessing the column was the mistake: search
 * both and merge. The two queries run in parallel, so this costs no extra
 * latency — round trips are the expense here and these overlap.
 */
function merge<T extends { offering_name: string; section_name?: string }>(
  byCode: T[],
  byTitle: T[],
  limit: number
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...byCode, ...byTitle]) {
    const key = `${r.offering_name}::${r.section_name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || "";
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;
  const mode = req.nextUrl.searchParams.get("mode") || "term"; // "term" | "past" | "catalogue"

  if (q.length < 2) return NextResponse.json([]);

  const pattern = `%${q}%`;

  // For past terms: search across ALL terms, deduplicate by offering_name, show one result per course
  if (mode === "past") {
    const base = () =>
      supabase.from("courses").select(`${COURSE_COLS}, term`).order("offering_name").limit(50);
    const [{ data: codeHits }, { data: titleHits }] = await Promise.all([
      base().ilike("offering_name", pattern),
      base().ilike("title", pattern),
    ]);
    const data = merge(codeHits ?? [], titleHits ?? [], 100);

    if (data.length > 0) {
      // Deduplicate by offering_name — prefer the requested term, fall back to any
      const byCode = new Map<string, (typeof data)[0]>();
      for (const r of data) {
        if (!byCode.has(r.offering_name) || r.term === term) {
          byCode.set(r.offering_name, r);
        }
      }
      const deduped = [...byCode.values()].slice(0, 12);

      const codes = [...new Set(deduped.map((r) => r.offering_name))];
      const tagMap = await getPosTags(codes);

      return NextResponse.json(
        deduped.map((r) => ({ ...r, pos_tags: tagMap.get(r.offering_name) || null }))
      );
    }

    // Fall through to catalogue if nothing found
  }

  // For catalogue mode (future terms) or fallback
  if (mode === "catalogue") {
    const base = () =>
      supabase
        .from("catalogue")
        .select("offering_name, title, credits, department")
        .order("offering_name")
        .limit(12);
    const [{ data: codeHits }, { data: titleHits }] = await Promise.all([
      base().ilike("offering_name", pattern),
      base().ilike("title", pattern),
    ]);
    const catData = merge(codeHits ?? [], titleHits ?? [], 12);

    if (catData.length > 0) {
      const codes = [...new Set(catData.map((r) => r.offering_name))];
      const tagMap = await getCataloguePosTags(codes);

      return NextResponse.json(
        catData.map((r) => ({
          ...r, section_name: "", meetings: "", instructors_full_name: "",
          source: "catalogue", pos_tags: tagMap.get(r.offering_name) || null,
        }))
      );
    }
    return NextResponse.json([]);
  }

  // Default: search within the specific term
  const base = () =>
    supabase.from("courses").select(COURSE_COLS).eq("term", term).order("offering_name").limit(12);
  const [{ data: codeHits }, { data: titleHits }] = await Promise.all([
    base().ilike("offering_name", pattern),
    base().ilike("title", pattern),
  ]);
  const data = merge(codeHits ?? [], titleHits ?? [], 12);

  if (data.length > 0) {
    const codes = [...new Set(data.map((r) => r.offering_name))];
    const tagMap = await getPosTags(codes);

    return NextResponse.json(
      data.map((r) => ({ ...r, pos_tags: tagMap.get(r.offering_name) || null }))
    );
  }

  // No catalogue fallback for term mode — only return courses actually offered this term
  return NextResponse.json([]);
}
