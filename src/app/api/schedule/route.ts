import { supabase } from "@/lib/supabase";
import { NextResponse, NextRequest } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";
import { resolveSessionId } from "@/lib/session";
import { SCHEDULE_SLOTS, parseScheduleSlot } from "@/lib/schedule-slots";

const COURSE_COLS =
  "offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status, school_name, level";

export async function GET(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;
  const slot = parseScheduleSlot(req.nextUrl.searchParams.get("slot"));

  // Read every slot in one go and split locally. The counts drive the schedule
  // picker, and a second query to total them would cost another round trip —
  // round trips are the expense against Supabase, not rows. The two tables go
  // out together for the same reason.
  const [{ data: allRows }, { data: allActivities }] = await Promise.all([
    supabase
      .from("schedules")
      .select("offering_name, section_name, schedule_slot")
      .eq("session_id", sessionId)
      .eq("term", term),
    supabase
      .from("activities")
      .select("id, name, days, start_min, end_min, schedule_slot")
      .eq("session_id", sessionId)
      .eq("term", term)
      .order("start_min"),
  ]);

  const counts: Record<number, number> = Object.fromEntries(SCHEDULE_SLOTS.map((s) => [s, 0]));
  for (const row of allRows ?? []) {
    counts[row.schedule_slot] = (counts[row.schedule_slot] ?? 0) + 1;
  }
  // Activities count toward "what's in this schedule" too, or a slot holding
  // nothing but a club meeting would read as empty in the picker.
  for (const row of allActivities ?? []) {
    counts[row.schedule_slot] = (counts[row.schedule_slot] ?? 0) + 1;
  }

  const activities = (allActivities ?? [])
    .filter((a) => a.schedule_slot === slot)
    .map(({ schedule_slot: _slot, ...a }) => a);

  const scheduleRows = (allRows ?? []).filter((r) => r.schedule_slot === slot);
  if (scheduleRows.length === 0) {
    return NextResponse.json({ courses: [], activities, counts });
  }

  // PLAN/TAKEN entries are no longer created: the planner is pinned to a
  // single term, so there is no past-term "courses taken" flow and no
  // section-less plan rows. Older rows of that shape simply do not render.
  const orFilter = scheduleRows
    .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
    .join(",");

  const { data: courses } = await supabase
    .from("courses")
    .select(COURSE_COLS)
    .eq("term", term)
    .or(orFilter);

  return NextResponse.json({ courses: courses ?? [], activities, counts });
}

export async function POST(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const { offering_name, section_name, term = CURRENT_TERM, slot } = await req.json();
  const scheduleSlot = parseScheduleSlot(slot);

  // The conflict target must name the slot. Without it this upsert matches the
  // copy already sitting in another schedule and updates that row, moving the
  // class between schedules rather than adding it to this one.
  const { error } = await supabase.from("schedules").upsert(
    { session_id: sessionId, schedule_slot: scheduleSlot, offering_name, section_name, term },
    { onConflict: "session_id,schedule_slot,offering_name,section_name,term" }
  );

  // resolveSessionId has already issued the cookie if this caller arrived
  // without one, so there is nothing to attach here.
  return NextResponse.json({ success: !error, message: error?.message || "Added" });
}

export async function DELETE(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const { offering_name, section_name, term = CURRENT_TERM, slot } = await req.json();
  const scheduleSlot = parseScheduleSlot(slot);

  let query = supabase
    .from("schedules")
    .delete()
    .eq("session_id", sessionId)
    .eq("schedule_slot", scheduleSlot)
    .eq("offering_name", offering_name)
    .eq("term", term);

  // If section_name provided, match exactly; otherwise delete all sections for this course+term
  if (section_name) {
    query = query.eq("section_name", section_name);
  }

  await query;

  return NextResponse.json({ removed: true });
}
