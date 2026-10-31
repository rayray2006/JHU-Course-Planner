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

  // PLAN/TAKEN entries are no longer created: the planner is pinned to a
  // single term, so there is no past-term "courses taken" flow and no
  // section-less plan rows. Older rows of that shape simply do not render.
  const results: Record<string, unknown>[] = [];

  const orFilter = scheduleRows
    .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
    .join(",");

  const { data: courses } = await supabase
    .from("courses")
    .select("offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status, school_name, level")
    .eq("term", term)
    .or(orFilter);

  if (courses) results.push(...courses);

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
