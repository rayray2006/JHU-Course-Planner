import { supabase } from "@/lib/supabase";
import { getPosTags, getCataloguePosTags } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || "";
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;
  const mode = req.nextUrl.searchParams.get("mode") || "term"; // "term" | "past" | "catalogue"

  if (q.length < 2) return NextResponse.json([]);

  const isCode = /^[A-Z]{2}[.\d]/i.test(q);
  const col = isCode ? "offering_name" : "title";

  // For past terms: search across ALL terms, deduplicate by offering_name, show one result per course
  if (mode === "past") {
    const query = supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, instructors_full_name, department, term")
      .ilike(col, `%${q}%`)
      .order("offering_name")
      .limit(50);

    const { data } = await query;
    if (data && data.length > 0) {
      // Deduplicate by offering_name — prefer the requested term, fall back to any
      const byCode = new Map<string, typeof data[0]>();
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
    const { data: catData } = await supabase
      .from("catalogue")
      .select("offering_name, title, credits, department")
      .ilike(col, `%${q}%`)
      .order("offering_name")
      .limit(12);

    if (catData && catData.length > 0) {
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
  const { data } = await supabase
    .from("courses")
    .select("offering_name, section_name, title, credits, meetings, instructors_full_name, department")
    .eq("term", term)
    .ilike(col, `%${q}%`)
    .order("offering_name")
    .limit(12);

  if (data && data.length > 0) {
    const codes = [...new Set(data.map((r) => r.offering_name))];
    const tagMap = await getPosTags(codes);

    return NextResponse.json(
      data.map((r) => ({ ...r, pos_tags: tagMap.get(r.offering_name) || null }))
    );
  }

  // No catalogue fallback for term mode — only return courses actually offered this term
  return NextResponse.json([]);
}
