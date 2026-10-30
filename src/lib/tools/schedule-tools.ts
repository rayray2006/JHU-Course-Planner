import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";
import { CURRENT_TERM } from "../terms";

// Session ID is passed via a global that the API route sets before each request
let _sessionId = "default";
export function setSessionId(id: string) { _sessionId = id; }
export function getSessionId() { return _sessionId; }

// Active term for this request
let _activeTerm = CURRENT_TERM;
export function setActiveTerm(term: string) { _activeTerm = term; }
export function getActiveTerm() { return _activeTerm; }

// --- Time parsing helpers ---
function expandDays(dayStr: string): string[] {
  const days: string[] = [];
  let i = 0;
  while (i < dayStr.length) {
    if (dayStr[i] === "T" && dayStr[i + 1] === "h") {
      days.push("Th");
      i += 2;
    } else if (dayStr[i] === "S" && dayStr[i + 1] === "a") {
      days.push("Sa");
      i += 2;
    } else if (dayStr[i] === "S" && dayStr[i + 1] !== "a") {
      days.push("S");
      i += 1;
    } else {
      days.push(dayStr[i]);
      i += 1;
    }
  }
  return days;
}

function parseMeetingTime(meetings: string): { days: string[]; startMin: number; endMin: number }[] {
  if (!meetings) return [];
  return meetings.split(",").map((part) => {
    const match = part.trim().match(/^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)$/);
    if (!match) return null;
    const [, dayStr, sh, sm, sap, eh, em, eap] = match;
    let startH = parseInt(sh);
    if (sap === "PM" && startH !== 12) startH += 12;
    if (sap === "AM" && startH === 12) startH = 0;
    let endH = parseInt(eh);
    if (eap === "PM" && endH !== 12) endH += 12;
    if (eap === "AM" && endH === 12) endH = 0;
    return { days: expandDays(dayStr), startMin: startH * 60 + parseInt(sm), endMin: endH * 60 + parseInt(em) };
  }).filter((b): b is NonNullable<typeof b> => b !== null);
}

function hasConflict(meetingsA: string, meetingsB: string): boolean {
  const blocksA = parseMeetingTime(meetingsA);
  const blocksB = parseMeetingTime(meetingsB);
  for (const a of blocksA) {
    for (const b of blocksB) {
      if (a.days.some((d) => b.days.includes(d)) && a.startMin < b.endMin && a.endMin > b.startMin) {
        return true;
      }
    }
  }
  return false;
}

export const addCourseToSchedule = tool({
  description: "Add a course to the user's schedule for the current semester.",
  inputSchema: z.object({
    offering_name: z.string().describe("Course offering name, e.g. 'EN.601.226'"),
    section_name: z.string().describe("Section number, e.g. '01'"),
  }),
  execute: async ({ offering_name, section_name }) => {
    const { data: course } = await supabase
      .from("courses")
      .select("offering_name, title")
      .eq("offering_name", offering_name)
      .eq("section_name", section_name)
      .eq("term", _activeTerm)
      .limit(1)
      .single();

    if (!course) return { success: false, message: `Course ${offering_name} section ${section_name} not found in ${_activeTerm}.` };

    const { error } = await supabase.from("schedules").upsert(
      { session_id: _sessionId, offering_name, section_name, term: _activeTerm },
      { onConflict: "session_id,offering_name,section_name,term" }
    );

    if (error) return { success: false, message: error.message };
    return { success: true, message: `Added ${offering_name} (${course.title}) section ${section_name} to your ${_activeTerm} schedule.` };
  },
});

export const removeCourseFromSchedule = tool({
  description: "Remove a course from the user's schedule for the current semester.",
  inputSchema: z.object({
    offering_name: z.string().describe("Course offering name"),
    section_name: z.string().describe("Section number"),
  }),
  execute: async ({ offering_name, section_name }) => {
    const { count } = await supabase
      .from("schedules")
      .delete()
      .eq("session_id", _sessionId)
      .eq("offering_name", offering_name)
      .eq("section_name", section_name)
      .eq("term", _activeTerm);

    if (count === 0) return { success: false, message: `${offering_name} section ${section_name} is not in your ${_activeTerm} schedule.` };
    return { success: true, message: `Removed ${offering_name} section ${section_name} from your ${_activeTerm} schedule.` };
  },
});

export const viewSchedule = tool({
  description: "View all courses currently in the user's schedule for the current semester.",
  inputSchema: z.object({}),
  execute: async () => {
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId)
      .eq("term", _activeTerm);

    if (!scheduleRows || scheduleRows.length === 0) return { courses: [], message: `Your ${_activeTerm} schedule is empty.` };

    const orFilter = scheduleRows
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");

    const { data: courses } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, instructors_full_name")
      .eq("term", _activeTerm)
      .or(orFilter);

    const totalCredits = (courses || []).reduce((sum, c) => {
      const n = parseFloat(c.credits);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);

    return { courses: courses || [], totalCredits, count: (courses || []).length, term: _activeTerm };
  },
});

export const clearMySchedule = tool({
  description: "Clear all courses from the user's schedule for the current semester. Ask for confirmation first.",
  inputSchema: z.object({}),
  execute: async () => {
    await supabase.from("schedules").delete().eq("session_id", _sessionId).eq("term", _activeTerm);
    return { success: true, message: `${_activeTerm} schedule cleared.` };
  },
});

export const findNonConflictingCourses = tool({
  description: "Find courses that don't conflict with the user's schedule. Works with empty schedules too.",
  inputSchema: z.object({
    department: z.string().optional(),
    courseNumber: z.string().optional().describe("Course code, e.g. 'EN.601.226'"),
    school: z.string().optional().describe("School, e.g. 'Whiting'"),
    level: z.enum(["Lower Level Undergraduate", "Upper Level Undergraduate", "Graduate"]).optional(),
    titleKeyword: z.string().optional(),
    descriptionKeyword: z.string().optional(),
    instructor: z.string().optional().describe("Instructor name"),
    writingIntensive: z.boolean().optional(),
    areas: z.string().optional().describe("Area codes comma-separated: E,H,N,Q,S"),
    foundationalAbility: z.string().optional().describe("JHU Foundational Ability. Accepts name or FA1-FA9: FA1=Citizens and Society, FA2=Creative Expression, FA3=Culture and Aesthetics, FA4=Engagement with Society, FA5=Ethical Reflection, FA6=Ethics and Foundations, FA7=Projects and Methods, FA8=Science and Data, FA9=Writing and Communication"),
    posTag: z.string().optional().describe("POS tag filter, e.g. 'CSCI-SOFT', 'BMED', 'HIST-US'"),
    status: z.enum(["Open", "Closed", "Waitlist Only", "Approval Required"]).optional(),
    hasOpenSeats: z.boolean().optional(),
    instructionMethod: z.enum(["in-person", "online", "blended"]).optional(),
    credits: z.string().optional(),
    daysOfWeek: z.string().optional().describe("e.g. 'MWF', 'TTh'"),
    excludeDays: z.string().optional().describe("Exclude courses on these days, e.g. 'MWF'"),
    timeOfDay: z.enum(["Morning", "Afternoon", "Evening"]).optional(),
    beforeTime: z.string().optional().describe("Courses ending before this, e.g. '12:00PM'"),
    afterTime: z.string().optional().describe("Courses starting at/after this"),
    hasPrerequisites: z.boolean().optional(),
    prerequisiteKeyword: z.string().optional().describe("Find courses requiring this prereq"),
    excludePrerequisiteKeyword: z.string().optional().describe("Exclude courses requiring this prereq"),
    hasEvaluations: z.boolean().optional(),
    minOverallQuality: z.number().optional().describe("Min quality rating 1-5"),
    maxOverallQuality: z.number().optional().describe("Max quality rating 1-5"),
    minInstructorEffectiveness: z.number().optional(),
    minIntellectualChallenge: z.number().optional(),
    maxIntellectualChallenge: z.number().optional(),
    minWorkload: z.number().optional().describe("Min workload 1-5"),
    maxWorkload: z.number().optional().describe("Max workload 1-5"),
    minRespondents: z.number().optional(),
    sortBy: z.enum(["overall_quality","workload","num_respondents","instructor_effectiveness","intellectual_challenge","credits","title"]).optional(),
    sortOrder: z.enum(["asc","desc"]).optional(),
    limit: z.number().optional(),
    ignoreCourses: z.array(z.string()).optional().describe("Courses to ignore from schedule for hypotheticals"),
    extraMeetings: z.array(z.string()).optional().describe("Extra busy times, e.g. 'TTh 1:30PM - 2:45PM'"),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => findNonConflictingExecute(input),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findNonConflictingExecute(input: any) {
    // 1. Get user's current schedule for this term
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId)
      .eq("term", _activeTerm);

    const scheduleEmpty = !scheduleRows || scheduleRows.length === 0;

    let scheduledMeetings: string[] = [];
    let scheduledCodes = new Set<string>();

    if (!scheduleEmpty) {
      const orFilter = scheduleRows
        .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
        .join(",");
      const { data: scheduledCourses } = await supabase
        .from("courses")
        .select("offering_name, meetings")
        .eq("term", _activeTerm)
        .or(orFilter);

      const ignoreCodes = new Set(input.ignoreCourses || []);
      scheduledMeetings = (scheduledCourses || [])
        .filter((c) => !ignoreCodes.has(c.offering_name))
        .map((c) => c.meetings)
        .filter(Boolean) as string[];

      scheduledCodes = new Set(
        scheduleRows
          .filter((r) => !ignoreCodes.has(r.offering_name))
          .map((r) => r.offering_name)
      );
    }

    if (input.extraMeetings) {
      scheduledMeetings.push(...input.extraMeetings);
    }

    // 2. Search for candidate courses in current term
    let query = supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, instructors_full_name, overall_quality, workload, is_writing_intensive, areas, pos_tags, school_name, open_seats, prerequisites, instructor_effectiveness, intellectual_challenge, num_respondents, status")
      .eq("term", _activeTerm)
      .neq("status", "Canceled")
      .neq("meetings", "");

    // Skip alphabetical ordering + increase limit when area/time/exclude post-filtering is active
    const hasShortArea = input.areas && input.areas.split(",").some((a: string) => /^[EHNQS]{1,2}$/.test(a.trim()));
    const hasTimeFilter = input.beforeTime || input.afterTime;
    const hasExcludePostFilter = input.excludePrerequisiteKeyword || input.excludeDays;
    if (!hasShortArea && !hasTimeFilter && !hasExcludePostFilter) {
      if (input.sortBy) {
        query = query.order(input.sortBy, { ascending: input.sortOrder === "asc", nullsFirst: false });
      } else {
        query = query.order("offering_name").order("section_name");
      }
      query = query.limit(200);
    } else {
      if (input.sortBy) {
        query = query.order(input.sortBy, { ascending: input.sortOrder === "asc", nullsFirst: false });
      }
      query = query.limit(3000);
    }

    if (input.department) query = query.or(`all_departments.ilike.%${input.department}%,department.ilike.%${input.department}%`);
    if (input.courseNumber) query = query.ilike("offering_name", `%${input.courseNumber}%`);
    if (input.school) query = query.ilike("school_name", `%${input.school}%`);
    if (input.level) query = query.eq("level", input.level);
    if (input.titleKeyword) {
      for (const word of input.titleKeyword.split(/\s+/).filter(Boolean)) {
        query = query.ilike("title", `%${word}%`);
      }
    }
    if (input.descriptionKeyword) {
      for (const word of input.descriptionKeyword.split(/\s+/).filter(Boolean)) {
        query = query.ilike("description", `%${word}%`);
      }
    }
    if (input.instructor) {
      for (const word of input.instructor.split(/\s+/).filter(Boolean)) {
        query = query.ilike("instructors_full_name", `%${word}%`);
      }
    }
    if (input.writingIntensive) query = query.eq("is_writing_intensive", "Yes");
    // Areas pre-filter: only use ilike for long names, not short codes which match too broadly
    if (input.areas) {
      const areaList = input.areas.split(",").map((a: string) => a.trim()).filter(Boolean);
      const longNames = areaList.filter((a: string) => a.length > 2);
      if (longNames.length > 0 && longNames.length === areaList.length) {
        if (longNames.length === 1) query = query.ilike("areas", `%${longNames[0]}%`);
        else query = query.or(longNames.map((a: string) => `areas.ilike.%${a}%`).join(","));
      } else {
        query = query.not("areas", "is", null).neq("areas", "None").neq("areas", "");
      }
    }
    if (input.status) query = query.eq("status", input.status);
    if (input.hasOpenSeats === true) query = query.gt("open_seats", "0");
    else if (input.hasOpenSeats === false) query = query.eq("open_seats", "0");
    if (input.credits) query = query.or(`credits.eq.${input.credits},credits.ilike.%${input.credits}%`);
    if (input.daysOfWeek) query = query.ilike("meetings", `${input.daysOfWeek} %`);
    if (input.timeOfDay) query = query.eq("time_of_day", input.timeOfDay);
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }

    if (input.posTag) query = query.ilike("pos_tags", `%${input.posTag}%`);
    if (input.foundationalAbility) {
      const FA_MAP: Record<string, string> = {
        "fa1": "Citizens and Society", "fa2": "Creative Expression", "fa3": "Culture and Aesthetics",
        "fa4": "Engagement with Society", "fa5": "Ethical Reflection", "fa6": "Ethics and Foundations",
        "fa7": "Projects and Methods", "fa8": "Science and Data", "fa9": "Writing and Communication",
      };
      const key = input.foundationalAbility.toLowerCase().replace(/\s+/g, "");
      const name = FA_MAP[key] || input.foundationalAbility;
      query = query.ilike("areas", `%${name}%`);
    }

    // Prerequisites
    if (input.hasPrerequisites === true) query = query.neq("prerequisites", "");
    else if (input.hasPrerequisites === false) query = query.or("prerequisites.eq.,prerequisites.is.null");
    if (input.prerequisiteKeyword) {
      const keyword = input.prerequisiteKeyword.trim();
      const looksLikeCode = /^[A-Z]{2}\.\d{3}\.\d{3}$/.test(keyword);
      if (looksLikeCode) {
        query = query.ilike("prerequisites", `%${keyword}%`);
      } else {
        const titleWords = keyword.split(/\s+/).filter((w: string) => w.length > 0);
        let lookupQuery = supabase.from("courses").select("offering_name");
        for (const word of titleWords) {
          lookupQuery = lookupQuery.ilike("title", `%${word}%`);
        }
        const { data: matchingCourses } = await lookupQuery.limit(20);
        const codes = [...new Set((matchingCourses || []).map((r) => r.offering_name))];
        if (codes.length > 0) {
          const orFilter = codes.map((code) => `prerequisites.ilike.%${code}%`).join(",");
          query = query.or(orFilter);
        } else {
          for (const word of titleWords) {
            query = query.ilike("prerequisites", `%${word}%`);
          }
        }
      }
    }

    // Evaluation filters
    if (input.hasEvaluations === true) query = query.not("overall_quality", "is", null);
    else if (input.hasEvaluations === false) query = query.is("overall_quality", null);
    if (input.minOverallQuality) query = query.gte("overall_quality", input.minOverallQuality);
    if (input.maxOverallQuality) query = query.lte("overall_quality", input.maxOverallQuality);
    if (input.minInstructorEffectiveness) query = query.gte("instructor_effectiveness", input.minInstructorEffectiveness);
    if (input.minIntellectualChallenge) query = query.gte("intellectual_challenge", input.minIntellectualChallenge);
    if (input.maxIntellectualChallenge) query = query.lte("intellectual_challenge", input.maxIntellectualChallenge);
    if (input.minWorkload) query = query.gte("workload", input.minWorkload);
    if (input.maxWorkload) query = query.lte("workload", input.maxWorkload);
    if (input.minRespondents) query = query.gte("num_respondents", input.minRespondents);

    const { data: rawCandidates } = await query;
    if (!rawCandidates || rawCandidates.length === 0) return { count: 0, courses: [] };

    // Post-filter: exclude courses with specific prerequisite
    const excludePrereqKeyword = input.excludePrerequisiteKeyword?.trim();
    if (excludePrereqKeyword && rawCandidates) {
      const looksLikeCode = /^[A-Z]{2}\.\d{3}\.\d{3}$/.test(excludePrereqKeyword);
      let excludeCodes: string[] = [];
      if (looksLikeCode) {
        excludeCodes = [excludePrereqKeyword];
      } else {
        const titleWords = excludePrereqKeyword.split(/\s+/).filter((w: string) => w.length > 0);
        let lookupQuery = supabase.from("courses").select("offering_name");
        for (const word of titleWords) {
          lookupQuery = lookupQuery.ilike("title", `%${word}%`);
        }
        const { data: matchingCourses } = await lookupQuery.limit(20);
        excludeCodes = [...new Set((matchingCourses || []).map((r) => r.offering_name))];
      }
      const excludeTerms = excludeCodes.length > 0 ? excludeCodes : [excludePrereqKeyword];
      const filtered = rawCandidates.filter((r) => {
        const prereqs = (r.prerequisites || "").toLowerCase();
        return !excludeTerms.some((t) => prereqs.includes(t.toLowerCase()));
      });
      rawCandidates.length = 0;
      rawCandidates.push(...filtered);
    }

    // Post-filter areas (short codes like H,S need precise matching)
    let candidates = rawCandidates;
    if (input.areas) {
      const areaList = input.areas.split(",").map((a: string) => a.trim()).filter(Boolean);
      const shortCodes = areaList.filter((a: string) => /^[EHNQS]{1,2}$/.test(a));
      const longNames = areaList.filter((a: string) => !/^[EHNQS]{1,2}$/.test(a));
      if (shortCodes.length > 0 || longNames.length > 0) {
        candidates = candidates.filter((r) => {
          const parts = (r.areas || "").split(",").map((a: string) => a.trim());
          return shortCodes.some((code: string) => parts.includes(code)) || longNames.some((name: string) => parts.some((p: string) => p.toLowerCase().includes(name.toLowerCase())));
        });
      }
    }

    function parseTimeToMin(t: string): number | null {
      const m = t.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
      if (!m) return null;
      let h = parseInt(m[1]);
      if (m[3] === "PM" && h !== 12) h += 12;
      if (m[3] === "AM" && h === 12) h = 0;
      return h * 60 + parseInt(m[2]);
    }
    const beforeMin = input.beforeTime ? parseTimeToMin(input.beforeTime) : null;
    const afterMin = input.afterTime ? parseTimeToMin(input.afterTime) : null;

    // Helper to expand day strings
    function expandDaysLocal(dayStr: string): string[] {
      const days: string[] = [];
      let i = 0;
      while (i < dayStr.length) {
        if (dayStr[i] === "T" && dayStr[i + 1] === "h") { days.push("Th"); i += 2; }
        else if (dayStr[i] === "S" && dayStr[i + 1] === "a") { days.push("Sa"); i += 2; }
        else { days.push(dayStr[i]); i += 1; }
      }
      return days;
    }
    const excludeDaysExpanded = input.excludeDays ? expandDaysLocal(input.excludeDays) : null;

    // 3. Filter out conflicts
    const maxResults = Math.min(input.limit || 20, 50);
    const nonConflicting = candidates.filter((course) => {
      if (scheduledCodes.has(course.offering_name)) return false;
      if (!course.meetings) return false;
      if (scheduledMeetings.some((sm) => hasConflict(sm, course.meetings))) return false;

      const parsed = parseMeetingTime(course.meetings);

      if (beforeMin !== null || afterMin !== null) {
        if (!parsed || parsed.length === 0) return false;
        for (const b of parsed) {
          if (beforeMin !== null && b.endMin > beforeMin) return false;
          if (afterMin !== null && b.startMin < afterMin) return false;
        }
      }

      if (excludeDaysExpanded && parsed && parsed.length > 0) {
        const courseDays = parsed.flatMap((b) => b.days);
        if (courseDays.some((d) => excludeDaysExpanded.includes(d))) return false;
      }

      return true;
    }).slice(0, maxResults);

    // If 0 results and keyword filters were used, retry without them
    if (nonConflicting.length === 0 && (input.titleKeyword || input.descriptionKeyword)) {
      const { titleKeyword, descriptionKeyword, ...rest } = input;
      return findNonConflictingExecute(rest);
    }

    return {
      count: nonConflicting.length,
      scheduledCount: scheduleEmpty ? 0 : scheduleRows!.length,
      courses: nonConflicting,
    };
}
