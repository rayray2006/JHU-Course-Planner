import { supabase } from "@/lib/supabase";
import { NextResponse, NextRequest } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";
import { resolveSessionId } from "@/lib/session";

export async function GET(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;

  // Get scheduled course keys for this term
  const { data: scheduleRows } = await supabase
    .from("schedules")
    .select("offering_name, section_name")
    .eq("session_id", sessionId)
    .eq("term", term);

  if (!scheduleRows || scheduleRows.length === 0) {
    return NextResponse.json([]);
  }

  // Check if any are PLAN/TAKEN entries (future planning or past courses recorded without section)
  const planEntries = scheduleRows.filter((r) => r.section_name === "PLAN" || r.section_name === "TAKEN");
  const scheduleEntries = scheduleRows.filter((r) => r.section_name !== "PLAN" && r.section_name !== "TAKEN");

  const results: Record<string, unknown>[] = [];

  // Fetch regular schedule entries from courses table
  if (scheduleEntries.length > 0) {
    const orFilter = scheduleEntries
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");

    const { data: courses } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status, school_name, level")
      .eq("term", term)
      .or(orFilter);

    if (courses) results.push(...courses);
  }

  // Fetch PLAN/TAKEN entries — try courses table first (past terms), then catalogue
  if (planEntries.length > 0) {
    const codes = planEntries.map((r) => r.offering_name);
    const sectionMap = new Map(planEntries.map((r) => [r.offering_name, r.section_name]));
    const found = new Set<string>();

    // Try courses table first (for past terms that have SIS data)
    const { data: courseData } = await supabase
      .from("courses")
      .select("offering_name, title, credits, meetings, instructors_full_name, department")
      .in("offering_name", codes)
      .eq("term", term);

    if (courseData) {
      const seen = new Set<string>();
      for (const c of courseData) {
        if (seen.has(c.offering_name)) continue;
        seen.add(c.offering_name);
        found.add(c.offering_name);
        const sec = sectionMap.get(c.offering_name) || "TAKEN";
        results.push({
          offering_name: c.offering_name, section_name: sec, title: c.title,
          credits: c.credits, meetings: c.meetings || "", location: "", building: "",
          instructors_full_name: c.instructors_full_name || "", instruction_method: "",
          department: c.department, status: sec === "TAKEN" ? "Taken" : "Planned",
          school_name: "", level: "",
        });
      }
    }

    // Fall back to catalogue for remaining
    const remaining = codes.filter((c) => !found.has(c));
    if (remaining.length > 0) {
      const { data: catCourses } = await supabase
        .from("catalogue")
        .select("offering_name, title, credits, department")
        .in("offering_name", remaining);

      if (catCourses) {
        results.push(
          ...catCourses.map((c) => {
            const sec = sectionMap.get(c.offering_name) || "PLAN";
            return {
              offering_name: c.offering_name, section_name: sec, title: c.title,
              credits: c.credits, meetings: "", location: "", building: "",
              instructors_full_name: "", instruction_method: "",
              department: c.department, status: sec === "TAKEN" ? "Taken" : "Planned",
              school_name: "", level: "",
            };
          })
        );
      }
    }
  }

  return NextResponse.json(results);
}

export async function POST(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const { offering_name, section_name, term = CURRENT_TERM } = await req.json();

  const { error } = await supabase.from("schedules").upsert(
    { session_id: sessionId, offering_name, section_name, term },
    { onConflict: "session_id,offering_name,section_name,term" }
  );

  // resolveSessionId has already issued the cookie if this caller arrived
  // without one, so there is nothing to attach here.
  return NextResponse.json({ success: !error, message: error?.message || "Added" });
}

export async function DELETE(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const { offering_name, section_name, term = CURRENT_TERM } = await req.json();

  let query = supabase
    .from("schedules")
    .delete()
    .eq("session_id", sessionId)
    .eq("offering_name", offering_name)
    .eq("term", term);

  // If section_name provided, match exactly; otherwise delete all sections for this course+term
  if (section_name) {
    query = query.eq("section_name", section_name);
  }

  await query;

  return NextResponse.json({ removed: true });
}
