import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";
import { getActiveTerm } from "./schedule-tools";

const COURSE_COLUMNS = "offering_name, section_name, title, credits, department, school_name, level, status, meetings, location, building, instruction_method, instructors_full_name, max_seats, open_seats, waitlisted, is_writing_intensive, areas, pos_tags, time_of_day, description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents, all_departments";

// Parse "TTh 10:30AM - 11:45AM" into { days: string, startMin: number, endMin: number }
function parseMeetingTime(meetings: string): { days: string; startMin: number; endMin: number } | null {
  // Handle comma-separated (take first part)
  const part = meetings.split(",")[0].trim();
  const match = part.match(/^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)$/);
  if (!match) return null;
  const [, days, sh, sm, sap, eh, em, eap] = match;
  let startH = parseInt(sh);
  if (sap === "PM" && startH !== 12) startH += 12;
  if (sap === "AM" && startH === 12) startH = 0;
  let endH = parseInt(eh);
  if (eap === "PM" && endH !== 12) endH += 12;
  if (eap === "AM" && endH === 12) endH = 0;
  return { days, startMin: startH * 60 + parseInt(sm), endMin: endH * 60 + parseInt(em) };
}

function expandDays(dayStr: string): string[] {
  const days: string[] = [];
  let i = 0;
  while (i < dayStr.length) {
    if (dayStr[i] === "T" && dayStr[i + 1] === "h") { days.push("Th"); i += 2; }
    else if (dayStr[i] === "S" && dayStr[i + 1] === "a") { days.push("Sa"); i += 2; }
    else if (dayStr[i] === "S" && dayStr[i + 1] !== "a") { days.push("S"); i += 1; }
    else { days.push(dayStr[i]); i += 1; }
  }
  return days;
}

function daysOverlap(a: string, b: string): boolean {
  const aDays = expandDays(a);
  const bDays = expandDays(b);
  return aDays.some((d) => bDays.includes(d));
}

function timesOverlap(a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }): boolean {
  return a.startMin < b.endMin && a.endMin > b.startMin;
}

function hasScheduledTime(meetings: string | undefined | null): boolean {
  if (!meetings) return false;
  const m = meetings.trim();
  if (!m) return false;
  if (/^(TBA|TBD|TBR|None|Hours Arranged|Arranged)$/i.test(m)) return false;
  return parseMeetingTime(m) !== null;
}

export const searchCourses = tool({
  description: "Search courses for the selected term. Returns up to 20 results.",
  inputSchema: z.object({
    titleKeyword: z.string().optional().describe("Title keyword (substring match)"),
    descriptionKeyword: z.string().optional().describe("Description keyword"),
    courseNumber: z.string().optional().describe("Course code, e.g. 'EN.601.226'"),
    department: z.string().optional().describe("Department, e.g. 'Computer Science'"),
    school: z.string().optional().describe("School, e.g. 'Whiting'"),
    level: z.enum(["Lower Level Undergraduate", "Upper Level Undergraduate", "Graduate"]).optional(),
    instructor: z.string().optional().describe("Instructor name"),
    daysOfWeek: z.string().optional().describe("Day pattern: 'MWF', 'TTh', etc."),
    excludeDays: z.string().optional().describe("Exclude courses on these days, e.g. 'MWF' to find non-MWF courses"),
    timeOfDay: z.enum(["Morning", "Afternoon", "Evening"]).optional(),
    meetingsExact: z.string().optional().describe("Exact time match, e.g. 'TTh 10:30AM - 11:45AM'"),
    meetingsOverlap: z.string().optional().describe("Find overlapping times"),
    beforeTime: z.string().optional().describe("Courses ending before this time, e.g. '4:00PM'"),
    afterTime: z.string().optional().describe("Courses starting at/after this time, e.g. '1:00PM'"),
    credits: z.string().optional().describe("Credit amount, e.g. '3.00'"),
    minCredits: z.number().optional(),
    maxCredits: z.number().optional(),
    status: z.enum(["Open", "Closed", "Waitlist Only", "Canceled", "Approval Required"]).optional(),
    instructionMethod: z.enum(["in-person", "online", "blended"]).optional(),
    writingIntensive: z.boolean().optional(),
    areas: z.string().optional().describe("Area codes comma-separated: E(Engineering),H(Humanities),N(NatSci),Q(Quant),S(Social). e.g. 'H,S'"),
    foundationalAbility: z.string().optional().describe("JHU Foundational Ability (FA). Accepts name or number: FA1=Citizens and Society, FA2=Creative Expression, FA3=Culture and Aesthetics, FA4=Engagement with Society, FA5=Ethical Reflection, FA6=Ethics and Foundations, FA7=Projects and Methods, FA8=Science and Data, FA9=Writing and Communication"),
    building: z.string().optional(),
    posTag: z.string().optional().describe("POS (Program of Study) tag, e.g. 'CSCI-THRY', 'BMED-BDS', 'HIST-US'. Use a prefix for a broad match, e.g. 'CSCI' for all CS tags. These are examples, not the full set — call listPosTags to see which tags exist this term."),
    hasOpenSeats: z.boolean().optional(),
    hasPrerequisites: z.boolean().optional(),
    prerequisiteKeyword: z.string().optional().describe("Find courses requiring this prereq (code or name)"),
    excludePrerequisiteKeyword: z.string().optional().describe("Exclude courses requiring this prereq"),
    hasEvaluations: z.boolean().optional(),
    minOverallQuality: z.number().optional(),
    maxOverallQuality: z.number().optional(),
    minInstructorEffectiveness: z.number().optional(),
    minIntellectualChallenge: z.number().optional(),
    maxIntellectualChallenge: z.number().optional(),
    minWorkload: z.number().optional().describe("Min workload 1-5 (1=light)"),
    maxWorkload: z.number().optional().describe("Max workload 1-5"),
    minRespondents: z.number().optional(),
    sortBy: z.enum(["overall_quality","workload","num_respondents","instructor_effectiveness","intellectual_challenge","credits","open_seats","title"]).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional(),
    limit: z.number().optional().describe("Max results (default 20, max 50)"),
    offset: z.number().optional().describe("Skip this many results. Use with limit for pagination (e.g. 'show me more' → offset: 20)."),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => searchCoursesExecute(input),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchCoursesExecute(input: any) {
    const activeTerm = getActiveTerm();
    let query = supabase.from("courses").select(COURSE_COLUMNS).eq("term", activeTerm);

    // Sort — skip default alphabetical ordering when area post-filtering is active
    // (alphabetical order puts all AS.* before EN.*, and Supabase caps at 1000 rows)
    const hasShortAreaCode = input.areas && input.areas.split(",").some((a: string) => /^[EHNQS]{1,2}$/.test(a.trim()));
    if (input.sortBy) {
      query = query.order(input.sortBy, { ascending: input.sortOrder === "asc", nullsFirst: false });
    } else if (!hasShortAreaCode) {
      query = query.order("offering_name").order("section_name");
    }

    const limit = Math.min(input.limit || 20, 50);
    const offset = input.offset || 0;

    // ── Text search ──
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
    if (input.courseNumber) query = query.ilike("offering_name", `%${input.courseNumber}%`);

    // ── Department / school / level ──
    // Search all_departments (cross-listed) with fallback to department
    if (input.department) query = query.or(`all_departments.ilike.%${input.department}%,department.ilike.%${input.department}%`);
    if (input.school) query = query.ilike("school_name", `%${input.school}%`);
    if (input.level) query = query.eq("level", input.level);

    // ── Instructor ──
    if (input.instructor) {
      for (const word of input.instructor.split(/\s+/).filter(Boolean)) {
        query = query.ilike("instructors_full_name", `%${word}%`);
      }
    }

    // ── Schedule ──
    if (input.daysOfWeek) query = query.ilike("meetings", `${input.daysOfWeek} %`);
    if (input.timeOfDay) query = query.eq("time_of_day", input.timeOfDay);
    if (input.meetingsExact) query = query.ilike("meetings", input.meetingsExact);

    // ── Logistics ──
    if (input.credits) query = query.or(`credits.eq.${input.credits},credits.ilike.%${input.credits}%`);
    if (input.status) query = query.eq("status", input.status);
    if (input.writingIntensive) query = query.eq("is_writing_intensive", "Yes");
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }
    // Areas pre-filter: only use ilike for long area names (not short codes like E,H which match everything)
    if (input.areas) {
      const areaList = input.areas.split(",").map((a: string) => a.trim()).filter(Boolean);
      const longNames = areaList.filter((a: string) => a.length > 2);
      if (longNames.length > 0 && longNames.length === areaList.length) {
        // All entries are long names — safe to pre-filter
        if (longNames.length === 1) {
          query = query.ilike("areas", `%${longNames[0]}%`);
        } else {
          query = query.or(longNames.map((a: string) => `areas.ilike.%${a}%`).join(","));
        }
      } else {
        // Has short codes — filter out empty/none areas, post-filter handles precise matching
        query = query.not("areas", "is", null).neq("areas", "None").neq("areas", "");
      }
    }
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
    if (input.building) {
      const bld = input.building.replace(/\s+(hall|building|bldg|center)$/i, "").trim();
      query = query.ilike("building", `%${bld}%`);
    }
    if (input.posTag) query = query.ilike("pos_tags", `%${input.posTag}%`);

    // ── Seats ──
    if (input.hasOpenSeats === true) query = query.gt("open_seats", "0");
    else if (input.hasOpenSeats === false) query = query.eq("open_seats", "0");

    // ── Prerequisites ──
    if (input.hasPrerequisites === true) query = query.neq("prerequisites", "");
    else if (input.hasPrerequisites === false) query = query.or("prerequisites.eq.,prerequisites.is.null");

    // ── Evaluation filters ──
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

    if (input.prerequisiteKeyword) {
      const keyword = input.prerequisiteKeyword.trim();
      const looksLikeCode = /^[A-Z]{2}\.\d{3}\.\d{3}$/.test(keyword);

      if (looksLikeCode) {
        query = query.ilike("prerequisites", `%${keyword}%`);
      } else {
        // Resolve name to course codes
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

    // Fetch more rows when post-filtering is needed (areas, time range, prereq exclusion).
    // Also widen the window when no explicit sortBy is given, so the no-meeting JS sort
    // has rows from both buckets to reorder (offering_name asc tends to cluster one type).
    const hasAreaPostFilter = input.areas && input.areas.split(",").some((a: string) => /^[EHNQS]{1,2}$/.test(a.trim()));
    const hasTimePostFilter = input.beforeTime || input.afterTime;
    const hasExcludePostFilter = input.excludePrerequisiteKeyword;
    const needsWideFetch = hasAreaPostFilter || hasTimePostFilter || hasExcludePostFilter;
    if (needsWideFetch) {
      query = query.limit(3000);
    } else if (!input.sortBy) {
      query = query.range(offset, offset + Math.min(limit * 10, 200) - 1);
    } else {
      query = query.range(offset, offset + limit - 1);
    }

    // Exclude prerequisite filter — must be done post-query since Supabase doesn't support NOT ILIKE well in .or()
    const excludePrereqKeyword = input.excludePrerequisiteKeyword?.trim();

    const { data: rawRows, error } = await query;
    if (error) return { count: 0, courses: [], error: error.message };

    // Post-filter: exclude courses with specific prerequisite
    if (excludePrereqKeyword && rawRows) {
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
      const beforeLen = rawRows.length;
      const filtered = rawRows.filter((r) => {
        const prereqs = (r.prerequisites || "").toLowerCase();
        return !excludeTerms.some((t) => prereqs.includes(t.toLowerCase()));
      });
      rawRows.length = 0;
      rawRows.push(...filtered);
    }

    // Post-filter: area codes (short codes like H,S need precise matching to avoid false positives)
    let rows = rawRows || [];
    if (input.areas) {
      const areaList = input.areas.split(",").map((a: string) => a.trim()).filter(Boolean);
      const shortCodes = areaList.filter((a: string) => /^[EHNQS]{1,2}$/.test(a));
      const longNames = areaList.filter((a: string) => !/^[EHNQS]{1,2}$/.test(a));
      if (shortCodes.length > 0 || longNames.length > 0) {
        rows = rows.filter((r) => {
          const parts = (r.areas || "").split(",").map((a: string) => a.trim());
          const matchesShort = shortCodes.some((code: string) => parts.includes(code));
          const matchesLong = longNames.some((name: string) => parts.some((p: string) => p.toLowerCase().includes(name.toLowerCase())));
          return matchesShort || matchesLong;
        });
      }
    }

    // Post-filter: credit ranges (can't do in Supabase since credits is TEXT with ranges like "1.00 - 3.00")
    if (input.minCredits || input.maxCredits) {
      rows = rows.filter((r) => {
        const c = r.credits || "";
        const rangeMatch = c.match(/([\d.]+)\s*-\s*([\d.]+)/);
        const lo = rangeMatch ? parseFloat(rangeMatch[1]) : parseFloat(c);
        const hi = rangeMatch ? parseFloat(rangeMatch[2]) : lo;
        if (isNaN(lo)) return false;
        if (input.minCredits && hi < input.minCredits) return false;
        if (input.maxCredits && lo > input.maxCredits) return false;
        return true;
      });
    }

    // Resolve course codes in prerequisites to include course names
    const codePattern = /[A-Z]{2}\.\d{3}\.\d{3}/g;
    const allCodes = new Set<string>();
    for (const row of rows || []) {
      if (row.prerequisites) {
        const matches = row.prerequisites.match(codePattern);
        if (matches) matches.forEach((c: string) => allCodes.add(c));
      }
    }

    let titleMap = new Map<string, string>();
    if (allCodes.size > 0) {
      const { data: titleRows } = await supabase
        .from("courses")
        .select("offering_name, title")
        .in("offering_name", [...allCodes]);
      if (titleRows) {
        titleMap = new Map(titleRows.map((r) => [r.offering_name, r.title]));
      }
    }

    const resolvedRows = (rows || []).map((row) => {
      // Resolve prereq codes to names
      let prereqs = row.prerequisites || "";
      if (prereqs && titleMap.size > 0) {
        const codes = [...new Set(prereqs.match(codePattern) || [])] as string[];
        for (const code of codes) {
          const name = titleMap.get(code);
          if (name) {
            prereqs = prereqs.replace(
              new RegExp(code.replace(/\./g, "\\."), "g"),
              `${code} (${name})`
            );
          }
        }
      }

      // Compact result — only include fields that have values
      const r: Record<string, unknown> = {
        offering_name: row.offering_name,
        section_name: row.section_name,
        title: row.title,
        credits: row.credits,
        meetings: row.meetings,
        instructors_full_name: row.instructors_full_name,
      };
      // Only include optional fields when they have values
      if (row.status !== "Open") r.status = row.status;
      if (row.open_seats !== undefined) r.open_seats = row.open_seats;
      if (row.is_writing_intensive === "Yes") r.writing_intensive = true;
      if (row.areas) r.areas = row.areas;
      if (row.pos_tags) r.pos_tags = row.pos_tags;
      if (row.description) r.description = row.description.slice(0, 150);
      if (prereqs) r.prerequisites = prereqs;
      if (row.overall_quality) r.quality = row.overall_quality;
      if (row.workload) r.workload = row.workload;
      if (row.num_respondents) r.respondents = row.num_respondents;
      return {
        ...r,
      };
    });

    // Apply overlap filter client-side (can't do time parsing in Supabase)
    let finalRows = resolvedRows;
    if (input.meetingsOverlap) {
      const target = parseMeetingTime(input.meetingsOverlap);
      if (target) {
        finalRows = finalRows.filter((row) => {
          const m = row.meetings as string | undefined;
          if (!m) return false;
          return m.split(",").some((part: string) => {
            const parsed = parseMeetingTime(part.trim());
            if (!parsed) return false;
            return daysOverlap(target.days, parsed.days) && timesOverlap(target, parsed);
          });
        });
      }
    }

    // Time range filtering (beforeTime / afterTime)
    if (input.beforeTime || input.afterTime) {
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
      finalRows = finalRows.filter((row) => {
        const meetings = row.meetings as string | undefined;
        if (!meetings) return false;
        const parsed = parseMeetingTime(meetings);
        if (!parsed) return false;
        if (beforeMin !== null && parsed.endMin > beforeMin) return false;
        if (afterMin !== null && parsed.startMin < afterMin) return false;
        return true;
      });
    }

    // Exclude specific days — no-meeting courses don't conflict with any day, so they pass.
    if (input.excludeDays) {
      const excludeExpanded = expandDays(input.excludeDays);
      finalRows = finalRows.filter((row) => {
        const meetings = row.meetings as string | undefined;
        const parsed = meetings ? parseMeetingTime(meetings) : null;
        if (!parsed) return true;
        const courseDays = expandDays(parsed.days);
        return !courseDays.some((d: string) => excludeExpanded.includes(d));
      });
    }

    // Stable sort: courses with a scheduled meeting time first, no-meeting (research,
    // independent study, etc.) at the bottom. Preserves prior ordering within each bucket.
    finalRows.sort((a, b) => {
      const aHas = hasScheduledTime(a.meetings as string);
      const bHas = hasScheduledTime(b.meetings as string);
      return (aHas ? 0 : 1) - (bHas ? 0 : 1);
    });

    // Truncate to requested limit after all post-filters
    const trimmed = finalRows.slice(0, limit);
    // If 0 results and keyword filters were used, retry without them
    if (trimmed.length === 0 && (input.titleKeyword || input.descriptionKeyword)) {
      const { titleKeyword, descriptionKeyword, ...rest } = input;
      return searchCoursesExecute(rest);
    }

    return { count: trimmed.length, courses: trimmed };
}

export const getCourseStats = tool({
  description:
    "Get statistics about courses for the current semester — total count, breakdowns by school, level, status, etc.",
  inputSchema: z.object({
    groupBy: z
      .enum(["school_name", "department", "level", "status", "time_of_day", "instruction_method", "is_writing_intensive"])
      .describe("Field to group statistics by"),
  }),
  execute: async ({ groupBy }) => {
    const activeTerm = getActiveTerm();
    let allData: Record<string, string>[] = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("courses")
        .select(groupBy)
        .eq("term", activeTerm)
        .range(offset, offset + pageSize - 1);
      if (error || !data || data.length === 0) break;
      allData = allData.concat(data as Record<string, string>[]);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    const data = allData;
    if (data.length === 0) return { total: 0, breakdown: [], term: activeTerm };

    const counts = new Map<string, number>();
    for (const row of data) {
      const val = (row as Record<string, string>)[groupBy] || "(none)";
      counts.set(val, (counts.get(val) || 0) + 1);
    }

    const breakdown = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    return { total: data.length, breakdown, term: activeTerm };
  },
});

export const searchCatalogue = tool({
  description:
    "Search the full JHU course catalogue (all courses regardless of semester). Use this for future semesters where schedule data isn't populated yet, or to find courses that may not be offered in the current term. Returns course info without sections, seats, or schedule data.",
  inputSchema: z.object({
    titleKeyword: z.string().optional().describe("Keywords to search in course title (case-insensitive, substring match)."),
    descriptionKeyword: z.string().optional().describe("Keywords to search in course description."),
    courseNumber: z.string().optional().describe("Course number or partial, e.g. 'EN.601' or '601.226'."),
    department: z.string().optional().describe("Department name or partial match."),
    hasPrerequisites: z.boolean().optional().describe("If true, only courses with prerequisites."),
    prerequisiteKeyword: z.string().optional().describe("Find courses that require a specific prerequisite."),
    limit: z.number().optional().describe("Max results (default 20, max 50)."),
    offset: z.number().optional().describe("Skip this many results for pagination."),
  }),
  execute: async (input) => {
    let query = supabase
      .from("catalogue")
      .select("offering_name, title, credits, department, description, prerequisites, corequisites, restrictions")
      .order("offering_name");

    const limit = Math.min(input.limit || 20, 50);
    const offset = input.offset || 0;
    query = query.range(offset, offset + limit - 1);

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
    if (input.courseNumber) query = query.ilike("offering_name", `%${input.courseNumber}%`);
    if (input.department) query = query.ilike("department", `%${input.department}%`);
    if (input.hasPrerequisites === true) query = query.neq("prerequisites", "");
    else if (input.hasPrerequisites === false) query = query.or("prerequisites.eq.,prerequisites.is.null");
    if (input.prerequisiteKeyword) query = query.ilike("prerequisites", `%${input.prerequisiteKeyword}%`);

    const { data, error } = await query;
    if (error) return { count: 0, courses: [], error: error.message };

    return {
      count: (data || []).length,
      courses: (data || []).map((r) => ({
        ...r,
        description: r.description ? r.description.slice(0, 200) + (r.description.length > 200 ? "..." : "") : undefined,
      })),
      source: "catalogue",
      note: "These are from the full course catalogue. Section, schedule, and seat data are not available.",
    };
  },
});

export const getCourseHistory = tool({
  description:
    "Check when a course was offered across semesters. Use for questions like 'when is EN.601.433 typically offered?' or 'has this course been offered every fall?'",
  inputSchema: z.object({
    courseNumber: z.string().describe("Course offering name, e.g. 'EN.601.226'"),
  }),
  execute: async ({ courseNumber }) => {
    const { data } = await supabase
      .from("courses")
      .select("offering_name, title, term, instructors_full_name, meetings, status, max_seats, open_seats")
      .ilike("offering_name", `%${courseNumber}%`)
      .order("term");

    if (!data || data.length === 0) return { found: false, message: `No history found for ${courseNumber}.` };

    const terms = [...new Set(data.map((r) => r.term))];
    const byTerm = terms.map((term) => {
      const sections = data.filter((r) => r.term === term);
      return {
        term,
        sections: sections.length,
        instructors: [...new Set(sections.map((s) => s.instructors_full_name).filter(Boolean))],
        meetings: [...new Set(sections.map((s) => s.meetings).filter(Boolean))],
      };
    });

    return {
      found: true,
      courseNumber: data[0].offering_name,
      title: data[0].title,
      termsOffered: terms,
      history: byTerm,
    };
  },
});

export const getPrerequisiteChain = tool({
  description:
    "Recursively resolve the full prerequisite chain for a course. Returns the dependency tree with AND/OR structure preserved. Use for questions like 'what do I need to take before EN.601.443?'",
  inputSchema: z.object({
    courseNumber: z.string().describe("Course offering name, e.g. 'EN.601.443'"),
  }),
  execute: async ({ courseNumber }) => {
    const codePattern = /[A-Z]{2}\.\d{3}\.\d{3}/g;
    const visited = new Set<string>();
    const titleCache = new Map<string, string>();

    async function lookupCourse(code: string): Promise<{ title: string; prerequisites: string } | null> {
      const { data: catRow } = await supabase
        .from("catalogue")
        .select("title, prerequisites")
        .eq("offering_name", code)
        .limit(1)
        .single();
      if (catRow) return catRow;
      const { data: courseRow } = await supabase
        .from("courses")
        .select("title, prerequisites")
        .eq("offering_name", code)
        .limit(1)
        .single();
      return courseRow;
    }

    async function getTitle(code: string): Promise<string> {
      if (titleCache.has(code)) return titleCache.get(code)!;
      const row = await lookupCourse(code);
      const title = row?.title || "";
      titleCache.set(code, title);
      return title;
    }

    // Parse prerequisite string into structured AND/OR groups
    function parsePrereqs(prereqStr: string): { type: "and" | "or"; courses: string[] }[] {
      if (!prereqStr) return [];
      // Split on top-level AND (handling parenthesized OR groups)
      const groups: { type: "and" | "or"; courses: string[] }[] = [];
      // Normalize semicolons and "Students may receive credit for only one of" notes away
      const cleaned = prereqStr.replace(/;.*/g, "").replace(/Students may.*$/i, "").trim();
      // Split by AND at the top level
      const andParts = cleaned.split(/\s+AND\s+/i);
      for (const part of andParts) {
        const codes = part.match(codePattern) || [];
        if (codes.length === 0) continue;
        const hasOr = /\bOR\b/i.test(part);
        if (hasOr || (part.includes("(") && codes.length > 1)) {
          groups.push({ type: "or", courses: [...new Set(codes)] });
        } else {
          for (const code of new Set(codes)) {
            groups.push({ type: "and", courses: [code] });
          }
        }
      }
      return groups;
    }

    interface PrereqNode {
      code: string;
      title: string;
      prereqText: string;
      prereqGroups: { type: "and" | "or"; courses: { code: string; title: string }[] }[];
      depth: number;
    }

    const chain: PrereqNode[] = [];

    async function resolve(code: string, depth: number) {
      if (visited.has(code) || depth > 5) return;
      visited.add(code);

      const row = await lookupCourse(code);
      if (!row) return;
      titleCache.set(code, row.title);

      const groups = parsePrereqs(row.prerequisites || "");
      // Resolve titles for all codes in groups
      const resolvedGroups: PrereqNode["prereqGroups"] = [];
      for (const g of groups) {
        const courses = await Promise.all(g.courses.map(async (c) => ({ code: c, title: await getTitle(c) })));
        resolvedGroups.push({ type: g.type, courses });
      }

      chain.push({
        code,
        title: row.title,
        prereqText: row.prerequisites || "",
        prereqGroups: resolvedGroups,
        depth,
      });

      // Recurse into required (AND) prereqs, and first of each OR group
      for (const g of groups) {
        const toResolve = g.type === "and" ? g.courses : [g.courses[0]];
        for (const c of toResolve) {
          await resolve(c, depth + 1);
        }
      }
    }

    await resolve(courseNumber, 0);

    if (chain.length === 0) return { found: false, message: `Course ${courseNumber} not found.` };

    return {
      found: true,
      root: courseNumber,
      chain,
      totalPrerequisites: chain.length - 1,
    };
  },
});

/**
 * The agent had no way to find out which POS tags exist, so asked "what are
 * the POS tags?" it could only recite the handful named in the posTag
 * description — which reads as an authoritative list and is not one. Tags are
 * per-term data, so they have to be read from the term being browsed.
 */
const POS_TAG_CACHE_MS = 300_000;
const posTagCache = new Map<string, { at: number; groups: PosTagGroup[] }>();

type PosTagGroup = { prefix: string; tags: { tag: string; courses: number }[] };

async function loadPosTagGroups(term: string): Promise<PosTagGroup[]> {
  const hit = posTagCache.get(term);
  if (hit && Date.now() - hit.at < POS_TAG_CACHE_MS) return hit.groups;

  // Count distinct courses, not section rows: six sections of one course is
  // one course that carries the tag.
  const byTag = new Map<string, Set<string>>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("courses")
      .select("offering_name, pos_tags")
      .eq("term", term)
      .neq("pos_tags", "")
      .range(offset, offset + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as { offering_name: string; pos_tags: string }[]) {
      for (const raw of (row.pos_tags || "").split(",")) {
        const tag = raw.trim();
        if (!tag) continue;
        if (!byTag.has(tag)) byTag.set(tag, new Set());
        byTag.get(tag)!.add(row.offering_name);
      }
    }
    if (data.length < pageSize) break;
  }

  const byPrefix = new Map<string, { tag: string; courses: number }[]>();
  for (const [tag, codes] of byTag) {
    const prefix = tag.split("-")[0];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push({ tag, courses: codes.size });
  }

  const groups = [...byPrefix.entries()]
    .map(([prefix, tags]) => ({ prefix, tags: tags.sort((a, b) => b.courses - a.courses) }))
    .sort((a, b) => b.tags.length - a.tags.length || a.prefix.localeCompare(b.prefix));

  posTagCache.set(term, { at: Date.now(), groups });
  return groups;
}

export const listPosTags = tool({
  description:
    "List the Program of Study (POS) tags that actually exist for the active term, with how many courses carry each. Use this whenever asked which tags, POS codes or program areas are available, and to confirm a tag exists before filtering searchCourses by posTag. Never guess a tag — read it from here.",
  inputSchema: z.object({
    prefix: z
      .string()
      .optional()
      .describe("Only tags starting with this, e.g. 'BMED', 'CSCI', 'ROBO'. Omit to list every tag grouped by prefix."),
  }),
  execute: async ({ prefix }) => {
    const activeTerm = getActiveTerm();
    const all = await loadPosTagGroups(activeTerm);

    const groups = prefix
      ? all
          .map((g) => ({
            prefix: g.prefix,
            tags: g.tags.filter((t) => t.tag.toUpperCase().startsWith(prefix.toUpperCase())),
          }))
          .filter((g) => g.tags.length > 0)
      : all;

    const totalTags = groups.reduce((n, g) => n + g.tags.length, 0);

    if (totalTags === 0) {
      return {
        term: activeTerm,
        totalTags: 0,
        note: prefix
          ? `No POS tag starts with "${prefix}" in ${activeTerm}. Call listPosTags without a prefix to see which prefixes exist.`
          : `No POS tags are recorded for ${activeTerm}.`,
      };
    }

    return { term: activeTerm, totalTags, totalPrefixes: groups.length, groups };
  },
});
