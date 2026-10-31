import { supabase } from "@/lib/supabase";
import { getProgramSchema, getPosTags } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionId } from "@/lib/session";

interface ScheduledCourse {
  offering_name: string;
  term: string;
  title: string;
  credits: number;
  areas: string;
  pos_tags: string;
  is_writing_intensive: string;
}

interface CourseRef { code: string; alternatives?: string[] }

interface Section {
  name: string;
  description?: string;
  type: "all" | "choose_one" | "choose_n" | "credit_min" | "reference_only" | "info_only";
  n?: number;
  credits_required?: number;
  exclusive?: boolean;
  courses?: CourseRef[];
  pos_tags?: string[];
  area_tags?: string[];
  course_prefixes?: string[];
  min_course_level?: number;
  match_all?: boolean;
  min_subsections_complete?: number;
  required_areas?: number;
  area_labels?: string[];
  areas_covered?: string[];
  placeholders?: string[];
  subsections?: Section[];
  is_chooseable_group?: boolean;
  status?: "complete" | "in_progress" | "incomplete";
  fulfilled?: number;
  total?: number;
  matched_courses?: { code: string; title: string; term: string; credits: number; matched_by: string }[];
}

function getCourseLevel(code: string): number {
  const parts = code.split(".");
  return parseInt(parts[parts.length - 1]) || 0;
}

function evaluateSection(section: Section, scheduled: ScheduledCourse[], usedCodes: Set<string>): void {
  if (section.type === "reference_only") {
    section.status = "complete";
    return;
  }
  if (section.type === "info_only") {
    if (section.subsections) {
      for (const sub of section.subsections) evaluateSection(sub, scheduled, usedCodes);
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      section.status = subComplete === section.subsections.length ? "complete" : subComplete > 0 ? "in_progress" : "incomplete";
      section.fulfilled = subComplete;
      section.total = section.subsections.length;
    } else {
      section.status = "complete";
    }
    return;
  }

  if ((section.type === "choose_n" || section.type === "all") && section.subsections && section.subsections.length > 0 && !section.courses?.length) {
    for (const sub of section.subsections) evaluateSection(sub, scheduled, usedCodes);
    const subComplete = section.subsections.filter((s) => s.status === "complete").length;
    const needed = section.type === "choose_n" ? (section.n || 1) : section.subsections.length;
    section.fulfilled = subComplete;
    section.total = needed;
    section.status = subComplete >= needed ? "complete" : subComplete > 0 ? "in_progress" : "incomplete";
    return;
  }

  if (section.is_chooseable_group && section.subsections) {
    let bestSub: Section | null = null;
    let bestCredits = 0;
    for (const sub of section.subsections) {
      const subUsed = new Set(usedCodes);
      evaluateSection(sub, scheduled, subUsed);
      let subCredits = (sub.matched_courses || []).reduce((s, m) => s + m.credits, 0);
      if (sub.subsections) {
        for (const ss of sub.subsections) {
          subCredits += (ss.matched_courses || []).reduce((s, m) => s + m.credits, 0);
        }
      }
      if (subCredits > bestCredits) { bestCredits = subCredits; bestSub = sub; }
    }
    const needed = section.credits_required || 0;
    const bestSubComplete = bestSub?.status === "complete";
    const creditsMetIfRequired = needed > 0 && bestCredits >= needed;
    section.status = bestSubComplete || creditsMetIfRequired
      ? "complete" : bestCredits > 0 ? "in_progress" : "incomplete";
    section.matched_courses = bestSub?.matched_courses || [];
    section.fulfilled = Math.min(bestCredits, needed || bestCredits);
    section.total = needed || (bestSub?.total || 1);
    return;
  }

  const matches: ScheduledCourse[] = [];
  const matchReasons = new Map<string, string>();
  const addsToUsed = section.exclusive;

  if (section.courses) {
    for (const ref of section.courses) {
      const allCodes = [ref.code, ...(ref.alternatives || [])];
      for (const code of allCodes) {
        const course = scheduled.find((s) => s.offering_name === code && !usedCodes.has(s.offering_name));
        if (course) {
          matches.push(course);
          matchReasons.set(course.offering_name, `Required: ${ref.code}`);
          if (section.exclusive) usedCodes.add(course.offering_name);
          break;
        }
      }
    }
  }

  const posMinLevel = section.min_course_level || 0;
  if (section.pos_tags) {
    for (const tag of section.pos_tags) {
      const tagMatches = scheduled.filter(
        (s) => s.pos_tags.split(",").includes(tag)
          && !usedCodes.has(s.offering_name)
          && !matches.some((m) => m.offering_name === s.offering_name)
          && (posMinLevel === 0 || getCourseLevel(s.offering_name) >= posMinLevel)
      );
      for (const course of tagMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `POS: ${tag}`);
        if (section.exclusive) usedCodes.add(course.offering_name);
      }
    }
  }

  if (section.course_prefixes) {
    const minLevel = section.min_course_level || 0;
    const checkUsed = addsToUsed;
    for (const prefix of section.course_prefixes) {
      const prefixMatches = scheduled.filter(
        (s) => s.offering_name.startsWith(prefix)
          && (!checkUsed || !usedCodes.has(s.offering_name))
          && !matches.some((m) => m.offering_name === s.offering_name)
          && (minLevel === 0 || getCourseLevel(s.offering_name) >= minLevel)
      );
      for (const course of prefixMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `Prefix: ${prefix}${minLevel ? ` (${minLevel}+)` : ""}`);
        if (section.exclusive) usedCodes.add(course.offering_name);
      }
    }
  }

  if (section.match_all) {
    const allMinLevel = section.min_course_level || 0;
    for (const course of scheduled) {
      if (!matches.some((m) => m.offering_name === course.offering_name)) {
        if (allMinLevel > 0 && getCourseLevel(course.offering_name) < allMinLevel) continue;
        matches.push(course);
        matchReasons.set(course.offering_name, "All courses");
      }
    }
  }

  if (section.area_tags && !section.match_all) {
    const areaMinLevel = section.min_course_level || 0;
    for (const area of section.area_tags) {
      const areaMatches = scheduled.filter((s) => {
        if (usedCodes.has(s.offering_name) || matches.some((m) => m.offering_name === s.offering_name)) return false;
        if (areaMinLevel > 0 && getCourseLevel(s.offering_name) < areaMinLevel) return false;
        if (area === "W") return s.is_writing_intensive === "Yes";
        const parts = s.areas.split(",").map((a) => a.trim());
        return parts.some((p) => p === area || (p.length <= 3 && p.includes(area)));
      });
      for (const course of areaMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `Area: ${area}`);
      }
    }
  }

  const cappedMatches = (section.type === "choose_n" || section.type === "choose_one")
    ? matches.slice(0, section.n || 1)
    : matches;

  section.matched_courses = cappedMatches.map((m) => ({
    code: m.offering_name,
    title: m.title,
    term: m.term,
    credits: m.credits,
    matched_by: matchReasons.get(m.offering_name) || "",
  }));

  const matchedCredits = matches.reduce((sum, m) => sum + m.credits, 0);
  const courseGroupCount = section.courses?.length || 0;
  const matchedCourseCount = section.courses
    ? section.courses.filter((ref) => {
        const allCodes = [ref.code, ...(ref.alternatives || [])];
        return matches.some((m) => allCodes.includes(m.offering_name));
      }).length
    : 0;

  switch (section.type) {
    case "all":
      section.total = courseGroupCount;
      section.fulfilled = matchedCourseCount;
      section.status = matchedCourseCount >= courseGroupCount ? "complete" : matchedCourseCount > 0 ? "in_progress" : "incomplete";
      break;
    case "choose_one":
      section.total = 1;
      section.fulfilled = matches.length > 0 ? 1 : 0;
      section.status = matches.length > 0 ? "complete" : "incomplete";
      break;
    case "choose_n":
      section.total = section.n || 1;
      section.fulfilled = Math.min(matches.length, section.total);
      section.status = matches.length >= (section.n || 1) ? "complete" : matches.length > 0 ? "in_progress" : "incomplete";
      break;
    case "credit_min": {
      const needed = section.credits_required || 0;
      section.total = needed;
      section.fulfilled = Math.min(matchedCredits, needed || matchedCredits);
      if (needed > 0) {
        section.status = matchedCredits >= needed ? "complete" : matchedCredits > 0 ? "in_progress" : "incomplete";
      } else {
        section.status = matches.length > 0 ? "in_progress" : "incomplete";
      }
      break;
    }
  }

  if (section.required_areas && section.area_labels) {
    const coveredAreas: string[] = [];
    for (const area of section.area_labels) {
      const hasCourse = matches.some((m) => m.pos_tags.split(",").includes(area));
      if (hasCourse) coveredAreas.push(area);
    }
    section.areas_covered = coveredAreas;
    if (coveredAreas.length < section.required_areas && section.status === "complete") {
      section.status = "in_progress";
    }
  }

  if (section.subsections && !section.is_chooseable_group) {
    for (const sub of section.subsections) {
      evaluateSection(sub, scheduled, usedCodes);
    }

    let childCredits = 0;
    let childFulfilled = 0;
    let childTotal = 0;
    for (const sub of section.subsections) {
      const subMatched = sub.matched_courses || [];
      childCredits += subMatched.reduce((s, m) => s + m.credits, 0);
      childFulfilled += sub.fulfilled || 0;
      childTotal += sub.total || 0;
      if (sub.subsections) {
        for (const ss of sub.subsections) {
          childCredits += (ss.matched_courses || []).reduce((s, m) => s + m.credits, 0);
        }
      }
    }

    if (section.type === "credit_min" && section.credits_required) {
      const ownCredits = (section.matched_courses || []).reduce((s, m) => s + m.credits, 0);
      const totalCredits = ownCredits + childCredits;
      section.fulfilled = Math.min(totalCredits, section.credits_required);
      section.total = section.credits_required;
      section.status = totalCredits >= section.credits_required ? "complete" : totalCredits > 0 ? "in_progress" : "incomplete";
    } else if (!section.courses?.length && section.subsections.length > 0) {
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      const subAny = section.subsections.filter((s) => s.status !== "incomplete").length;
      section.fulfilled = (section.fulfilled || 0) + childFulfilled;
      section.total = (section.total || 0) + childTotal;
      if (subComplete === section.subsections.length && (section.status === "incomplete" || !section.status)) {
        section.status = "complete";
      } else if (subAny > 0 && section.status === "incomplete") {
        section.status = "in_progress";
      }
    }

    if (section.min_subsections_complete) {
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      const needed = section.min_subsections_complete;
      if (subComplete < needed && section.status === "complete") {
        section.status = "in_progress";
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const otherPrograms = req.nextUrl.searchParams.get("others")?.split("|").filter(Boolean) || [];
  const maxShared = 2;

  // Check if we have a schema for this program
  const schemaRow = await getProgramSchema(name);

  if (!schemaRow) {
    const baseUrl = req.nextUrl.origin;
    const res = await fetch(`${baseUrl}/api/programs?name=${encodeURIComponent(name)}`);
    return NextResponse.json(await res.json());
  }

  const schema = (typeof schemaRow.schema === "string" ? JSON.parse(schemaRow.schema) : schemaRow.schema) as { total_credits?: number; sections: Section[] };

  const isGrad = /Master|PhD|Doctoral|MSE|MS\b/i.test(name);
  const otherIsGrad = otherPrograms.some((p) => /Master|PhD|Doctoral|MSE|MS\b/i.test(p));

  const sessionId = await resolveSessionId();

  // Fetch ALL scheduled courses across all terms
  const { data: scheduleRows } = await supabase
    .from("schedules")
    .select("offering_name, term")
    .eq("session_id", sessionId);

  const scheduled: ScheduledCourse[] = [];
  if (scheduleRows && scheduleRows.length > 0) {
    const codes = [...new Set(scheduleRows.map((r) => r.offering_name))];
    const { data: courseData } = await supabase
      .from("courses")
      .select("offering_name, title, credits, areas, is_writing_intensive, term")
      .in("offering_name", codes);

    // Get POS tags via data layer (works in both dev and prod)
    const posMap = await getPosTags(codes);

    if (courseData) {
      const seen = new Set<string>();
      for (const c of courseData) {
        if (seen.has(c.offering_name)) continue;
        seen.add(c.offering_name);
        scheduled.push({
          offering_name: c.offering_name,
          term: c.term,
          title: c.title,
          credits: parseFloat(c.credits) || 0,
          areas: c.areas || "",
          pos_tags: posMap.get(c.offering_name) || "",
          is_writing_intensive: c.is_writing_intensive || "No",
        });
      }
    }
  }

  // Cross-program exclusivity
  let crossProgramExcluded = new Set<string>();
  let sharedCourses: string[] = [];

  if (otherPrograms.length > 0 && (isGrad !== otherIsGrad)) {
    const otherClaimed = new Set<string>();
    for (const otherName of otherPrograms) {
      const otherRow = await getProgramSchema(otherName);
      if (!otherRow) continue;
      const otherSchema = (typeof otherRow.schema === "string" ? JSON.parse(otherRow.schema) : otherRow.schema) as { sections: Section[] };
      const otherUsed = new Set<string>();
      for (const s of otherSchema.sections) evaluateSection(s, scheduled, otherUsed);
      function collectMatched(sections: Section[]): string[] {
        const codes: string[] = [];
        for (const s of sections) {
          if (s.matched_courses) codes.push(...s.matched_courses.map((m) => m.code));
          if (s.subsections) codes.push(...collectMatched(s.subsections));
        }
        return codes;
      }
      for (const code of collectMatched(otherSchema.sections)) otherClaimed.add(code);
    }

    const thisCodes = new Set(scheduled.map((s) => s.offering_name));
    const overlap = [...otherClaimed].filter((c) => thisCodes.has(c));

    if (overlap.length > maxShared) {
      const scored = overlap.map((code) => {
        const course = scheduled.find((s) => s.offering_name === code);
        let score = 0;
        if (!course) return { code, score: 0 };
        for (const sec of schema.sections) {
          if (sec.pos_tags?.some((tag) => course.pos_tags.split(",").includes(tag))) score += 3;
          if (sec.course_prefixes?.some((p) => code.startsWith(p))) score += 2;
          if (sec.courses?.some((c) => c.code === code || c.alternatives?.includes(code))) score += 5;
        }
        score += course.credits;
        return { code, score };
      }).sort((a, b) => b.score - a.score);

      sharedCourses = scored.slice(0, maxShared).map((s) => s.code);
      const excluded = scored.slice(maxShared).map((s) => s.code);
      crossProgramExcluded = new Set(excluded);
    } else {
      sharedCourses = overlap;
    }
  }

  const effectiveScheduled = crossProgramExcluded.size > 0
    ? scheduled.filter((s) => !crossProgramExcluded.has(s.offering_name))
    : scheduled;

  const usedCodes = new Set<string>();
  for (const section of schema.sections) {
    evaluateSection(section, effectiveScheduled, usedCodes);
  }

  const realSections = schema.sections.filter((s) => s.type !== "reference_only" && s.type !== "info_only");
  const allComplete = realSections.every((s) => s.status === "complete");
  const anyProgress = realSections.some((s) => s.status === "complete" || s.status === "in_progress");

  return NextResponse.json({
    program_name: name,
    url: schemaRow.program_url ? `https://e-catalogue.jhu.edu${schemaRow.program_url}` : null,
    total_credits: schema.total_credits,
    sections: schema.sections,
    crossProgram: crossProgramExcluded.size > 0 ? {
      sharedCourses,
      excludedCourses: [...crossProgramExcluded],
      maxShared,
      otherPrograms,
    } : undefined,
    scheduledCount: scheduled.length,
    totalScheduledCredits: scheduled.reduce((s, c) => s + c.credits, 0),
    overallStatus: allComplete ? "complete" : anyProgress ? "in_progress" : "incomplete",
    hasSchema: true,
  });
}
