import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { CURRENT_TERM } from "@/lib/terms";
import { resolveSessionId } from "@/lib/session";
import { parseScheduleSlot } from "@/lib/schedule-slots";
import { fetchCourse } from "@/lib/sis-api";

/**
 * Builds the payload SIS expects behind its "add to cart" handoff at
 * https://sis.jhu.edu/sswf/go/ — the same shape semester.ly posts:
 *
 *   {"action":"AddToCart","data":{"year":2027,"term":"Spring","sections":[
 *      {"course":"EN.601.226","section":"01","course_section_id":890669}]}}
 *
 * The browser does the actual POST as a top-level form submit, because the
 * user's own sis.jhu.edu session is what authorises it; this route only
 * assembles the body. Nothing here talks to SIS's cart.
 *
 * `course_section_id` is the SIS API's own `SSS_SectionsID`. We don't store it
 * (it is not a column on `courses`), so it is looked up live — one request per
 * distinct course, in parallel. If it is ever worth persisting, a column plus
 * an ingest mapping replaces this lookup wholesale.
 */

interface CartSection {
  course: string;
  section: string;
  course_section_id: number;
}

export async function POST(req: NextRequest) {
  const sessionId = await resolveSessionId();
  const body = await req.json().catch(() => ({}));
  const term: string = body.term || CURRENT_TERM;
  const slot = parseScheduleSlot(body.slot);

  // SIS wants the term split: {"year": 2027, "term": "Spring"}.
  const parsed = /^([A-Za-z]+)\s+(\d{4})$/.exec(term.trim());
  if (!parsed) {
    return NextResponse.json(
      { ok: false, message: `Cannot read a year out of the term "${term}".` },
      { status: 400 }
    );
  }
  const [, termName, year] = parsed;

  const key = process.env.JHU_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, message: "JHU_API_KEY is not set, so section ids cannot be looked up." },
      { status: 503 }
    );
  }

  const { data: rows, error } = await supabase
    .from("schedules")
    .select("offering_name, section_name")
    .eq("session_id", sessionId)
    .eq("schedule_slot", slot)
    .eq("term", term);

  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }
  if (!rows?.length) {
    return NextResponse.json(
      { ok: false, message: "This schedule has no courses to send." },
      { status: 400 }
    );
  }

  // One SIS request per distinct course, not per row: a course with two
  // sections on the schedule would otherwise be fetched twice.
  const codes = [...new Set(rows.map((r) => r.offering_name))];
  const results = await Promise.all(
    codes.map(async (code) => {
      try {
        return { code, sections: await fetchCourse(code, term, key) };
      } catch {
        return { code, sections: null };
      }
    })
  );

  const idOf = new Map<string, string>();
  const unreachable = new Set<string>();
  for (const { code, sections } of results) {
    if (!sections) {
      unreachable.add(code);
      continue;
    }
    for (const s of sections) {
      if (s.SSS_SectionsID) idOf.set(`${s.OfferingName}::${s.SectionName}`, s.SSS_SectionsID);
    }
  }

  const sections: CartSection[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    const id = idOf.get(`${r.offering_name}::${r.section_name}`);
    const n = Number(id);
    // A section SIS cannot identify is left out rather than sent with a blank
    // id: a partial cart the user can see is better than a rejected post.
    if (!id || !Number.isFinite(n)) {
      missing.push(`${r.offering_name} ${r.section_name}`);
      continue;
    }
    sections.push({ course: r.offering_name, section: r.section_name, course_section_id: n });
  }

  if (sections.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        message: unreachable.size
          ? "Could not reach the SIS API to look up section ids."
          : "None of these sections could be matched in SIS.",
        missing,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    endpoint: "https://sis.jhu.edu/sswf/go/",
    payload: {
      action: "AddToCart",
      data: { year: Number(year), term: termName, sections },
    },
    missing,
  });
}
