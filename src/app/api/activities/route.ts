import { supabase } from "@/lib/supabase";
import { NextResponse, NextRequest } from "next/server";
import { CURRENT_TERM } from "@/lib/terms";
import { resolveSessionId } from "@/lib/session";
import { parseScheduleSlot } from "@/lib/schedule-slots";
import { validateActivity } from "@/lib/activities";

const COLS = "id, name, days, start_min, end_min";

/**
 * Activities are scoped the same way schedule rows are: session, slot, term.
 * Every write below filters on the session as well as the id, so an id from
 * another visitor's calendar matches nothing rather than editing their row.
 */
export async function POST(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const body = await req.json();
  const term = body.term || CURRENT_TERM;
  const slot = parseScheduleSlot(body.slot);

  const checked = validateActivity(body);
  if (!checked.ok) return NextResponse.json({ success: false, message: checked.error }, { status: 400 });

  const { data, error } = await supabase
    .from("activities")
    .insert({ session_id: sessionId, schedule_slot: slot, term, ...checked.value })
    .select(COLS)
    .single();

  if (error) return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  return NextResponse.json({ success: true, activity: data });
}

export async function PATCH(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const body = await req.json();
  const term = body.term || CURRENT_TERM;
  const slot = parseScheduleSlot(body.slot);
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ success: false, message: "Missing activity id." }, { status: 400 });
  }

  const checked = validateActivity(body);
  if (!checked.ok) return NextResponse.json({ success: false, message: checked.error }, { status: 400 });

  const { data, error } = await supabase
    .from("activities")
    .update(checked.value)
    .eq("id", id)
    .eq("session_id", sessionId)
    .eq("schedule_slot", slot)
    .eq("term", term)
    .select(COLS)
    .maybeSingle();

  if (error) return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ success: false, message: "Activity not found." }, { status: 404 });
  return NextResponse.json({ success: true, activity: data });
}

export async function DELETE(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const body = await req.json();
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ success: false, message: "Missing activity id." }, { status: 400 });
  }

  const { count, error } = await supabase
    .from("activities")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("session_id", sessionId);

  if (error) return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  return NextResponse.json({ success: true, removed: count ?? 0 });
}
