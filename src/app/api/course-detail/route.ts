import { supabase } from "@/lib/supabase";
import { getCoursePosTags } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json(null);

  const section = req.nextUrl.searchParams.get("section");
  const full = req.nextUrl.searchParams.get("full");
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;

  // Full course data (for schedule preview)
  if (full && section) {
    const { data } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status")
      .eq("offering_name", code)
      .eq("section_name", section)
      .eq("term", term)
      .limit(1)
      .single();
    return NextResponse.json(data || null);
  }

  // All three are always needed and none depends on the others, so they go out
  // together — the queries are fast, it's the round trip that costs ~350ms.
  //
  // The catalogue is fetched even when the course row exists because SIS rows
  // carry seats and meeting times but almost never the prose: only 10 of the
  // 4,447 Spring 2027 rows have a description and none has prerequisites,
  // while the catalogue has descriptions for 9,513 courses. Consulting it only
  // when the course row was missing entirely meant "No description available"
  // on every course in a term that had SIS data.
  const [posTags, { data }, { data: catData }, { data: sections }] = await Promise.all([
    getCoursePosTags(code),
    supabase
      .from("courses")
      .select("description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents, areas")
      .eq("offering_name", code)
      .eq("term", term)
      .limit(1)
      .single(),
    supabase
      .from("catalogue")
      .select("description, prerequisites, corequisites, restrictions")
      .eq("offering_name", code)
      .limit(1)
      .maybeSingle(),
    // Every section of this course, so the detail card can offer the others
    // and switch between them without a second request.
    supabase
      .from("courses")
      .select("section_name, meetings, instructors_full_name, status, open_seats, max_seats, waitlisted, location, building, instruction_method")
      .eq("offering_name", code)
      .eq("term", term)
      .order("section_name"),
  ]);

  if (data) {
    // Per field, not per row: a course row may carry prerequisites but no
    // description, and the catalogue should fill only what is actually blank.
    return NextResponse.json({
      ...data,
      description: data.description || catData?.description || "",
      prerequisites: data.prerequisites || catData?.prerequisites || "",
      corequisites: data.corequisites || catData?.corequisites || "",
      restrictions: data.restrictions || catData?.restrictions || "",
      pos_tags: posTags,
      sections: sections ?? [],
    });
  }

  // No SIS section for this term — fall back to the catalogue alone.
  if (catData) {
    return NextResponse.json({
      ...catData,
      overall_quality: null,
      instructor_effectiveness: null,
      intellectual_challenge: null,
      workload: null,
      feedback_usefulness: null,
      num_evaluations: 0,
      num_respondents: 0,
      source: "catalogue",
      pos_tags: posTags,
      sections: sections ?? [],
    });
  }

  return NextResponse.json(null);
}
