import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";
import { getSessionId, getScheduleSlot } from "./schedule-tools";
import { searchProgramsWithCounts, getProgramTagCodes } from "../data";

export const saveRequirements = tool({
  description:
    "Save or update the user's program requirements. Parse the user's natural language description of their degree requirements into structured format. Use this when a user describes their major, required courses, elective groups, area requirements, etc.",
  inputSchema: z.object({
    program_name: z.string().describe("Name of the program, e.g. 'Computer Science BS'"),
    total_credits: z.number().optional().describe("Total credits required for the degree"),
    required_courses: z
      .array(z.string())
      .optional()
      .describe("List of required course codes, e.g. ['EN.601.226', 'EN.601.229']"),
    elective_groups: z
      .array(
        z.object({
          name: z.string().describe("Group name, e.g. 'CS Electives'"),
          pick: z.number().optional().describe("Number of courses to pick from this group"),
          department: z.string().optional().describe("Department filter for this group"),
          level: z.string().optional().describe("Level filter, e.g. 'Upper Level Undergraduate'"),
          min_credits: z.number().optional().describe("Minimum credits from this group"),
          course_codes: z.array(z.string()).optional().describe("Specific course codes in this group"),
        })
      )
      .optional()
      .describe("Groups of elective requirements"),
    area_requirements: z
      .array(
        z.object({
          area: z.string().describe("Distribution area name, e.g. 'Humanities'"),
          min_credits: z.number().describe("Minimum credits in this area"),
        })
      )
      .optional()
      .describe("Distribution area credit requirements"),
    completed_courses: z
      .array(z.string())
      .optional()
      .describe("Courses already completed outside the schedule (e.g. AP credit, transfer credit)"),
    notes: z.string().optional().describe("Additional notes about the program"),
  }),
  execute: async (input) => {
    const requirements = {
      total_credits: input.total_credits,
      required_courses: input.required_courses || [],
      elective_groups: input.elective_groups || [],
      area_requirements: input.area_requirements || [],
      completed_courses: input.completed_courses || [],
      notes: input.notes || "",
    };

    const { error } = await supabase.from("program_requirements").upsert(
      {
        session_id: getSessionId(),
        program_name: input.program_name,
        requirements,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,program_name" }
    );

    if (error) return { success: false, message: error.message };
    return {
      success: true,
      message: `Saved requirements for "${input.program_name}".`,
      summary: {
        required_courses: (input.required_courses || []).length,
        elective_groups: (input.elective_groups || []).length,
        area_requirements: (input.area_requirements || []).length,
        total_credits: input.total_credits,
      },
    };
  },
});

export const getRequirements = tool({
  description: "Retrieve the user's saved program requirements.",
  inputSchema: z.object({
    program_name: z.string().optional().describe("Specific program name. If omitted, returns all programs."),
  }),
  execute: async (input) => {
    let query = supabase
      .from("program_requirements")
      .select("program_name, requirements, updated_at")
      .eq("session_id", getSessionId());

    if (input.program_name) {
      query = query.eq("program_name", input.program_name);
    }

    const { data, error } = await query;
    if (error) return { success: false, message: error.message };
    if (!data || data.length === 0) return { success: false, message: "No program requirements saved yet." };

    return {
      success: true,
      programs: data.map((r) => ({
        program_name: r.program_name,
        requirements: r.requirements,
        updated_at: r.updated_at,
      })),
    };
  },
});

export const checkRequirements = tool({
  description:
    "Check the user's progress toward their program requirements. Analyzes scheduled courses across ALL semesters plus completed courses to determine what requirements are fulfilled and what remains.",
  inputSchema: z.object({
    program_name: z.string().optional().describe("Program to check. If omitted, checks the first saved program."),
  }),
  execute: async (input) => {
    let reqQuery = supabase
      .from("program_requirements")
      .select("program_name, requirements")
      .eq("session_id", getSessionId());

    if (input.program_name) reqQuery = reqQuery.eq("program_name", input.program_name);

    const { data: reqData } = await reqQuery.limit(1);
    if (!reqData || reqData.length === 0) {
      return { success: false, message: "No program requirements saved. Tell me about your degree requirements first." };
    }

    const program = reqData[0];
    const reqs = program.requirements as {
      total_credits?: number;
      required_courses?: string[];
      elective_groups?: {
        name: string;
        pick?: number;
        department?: string;
        level?: string;
        min_credits?: number;
        course_codes?: string[];
      }[];
      area_requirements?: { area: string; min_credits: number }[];
      completed_courses?: string[];
      notes?: string;
    };

    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name, term")
      .eq("session_id", getSessionId())
      .eq("schedule_slot", getScheduleSlot());

    const allScheduledCodes = new Set(
      (scheduleRows || []).map((r) => r.offering_name)
    );

    const completedCodes = new Set(reqs.completed_courses || []);
    const allCodes = new Set([...allScheduledCodes, ...completedCodes]);

    let courseDetails: {
      offering_name: string;
      title: string;
      credits: string;
      department: string;
      level: string;
      areas: string;
      term: string;
    }[] = [];

    if (allScheduledCodes.size > 0) {
      const { data } = await supabase
        .from("courses")
        .select("offering_name, title, credits, department, level, areas, term")
        .in("offering_name", [...allScheduledCodes]);

      if (data) {
        const seen = new Set<string>();
        courseDetails = data.filter((c) => {
          if (seen.has(c.offering_name)) return false;
          seen.add(c.offering_name);
          return true;
        });
      }
    }

    const requiredStatus = (reqs.required_courses || []).map((code) => ({
      code,
      fulfilled: allCodes.has(code),
      source: completedCodes.has(code)
        ? "completed"
        : allScheduledCodes.has(code)
        ? "scheduled"
        : "missing",
    }));

    const electiveStatus = (reqs.elective_groups || []).map((group) => {
      const matching = courseDetails.filter((c) => {
        if (group.course_codes && group.course_codes.length > 0) {
          return group.course_codes.includes(c.offering_name);
        }
        let matches = true;
        if (group.department) matches = matches && c.department?.toLowerCase().includes(group.department.toLowerCase());
        if (group.level) matches = matches && c.level === group.level;
        return matches;
      });

      const credits = matching.reduce((sum, c) => sum + (parseFloat(c.credits) || 0), 0);

      return {
        name: group.name,
        required: group.pick || 0,
        fulfilled: matching.length,
        courses: matching.map((c) => c.offering_name),
        credits,
        min_credits: group.min_credits,
        credits_met: group.min_credits ? credits >= group.min_credits : true,
      };
    });

    const areaStatus = (reqs.area_requirements || []).map((area) => {
      const matching = courseDetails.filter(
        (c) => c.areas && c.areas.toLowerCase().includes(area.area.toLowerCase())
      );
      const credits = matching.reduce((sum, c) => sum + (parseFloat(c.credits) || 0), 0);
      return {
        area: area.area,
        min_credits: area.min_credits,
        current_credits: credits,
        fulfilled: credits >= area.min_credits,
        courses: matching.map((c) => `${c.offering_name} (${parseFloat(c.credits) || 0} cr)`),
      };
    });

    const totalCredits = courseDetails.reduce((sum, c) => sum + (parseFloat(c.credits) || 0), 0);

    const termBreakdown: Record<string, number> = {};
    for (const row of scheduleRows || []) {
      const course = courseDetails.find((c) => c.offering_name === row.offering_name);
      const credits = course ? parseFloat(course.credits) || 0 : 0;
      termBreakdown[row.term] = (termBreakdown[row.term] || 0) + credits;
    }

    return {
      success: true,
      program_name: program.program_name,
      required_courses: {
        total: requiredStatus.length,
        fulfilled: requiredStatus.filter((r) => r.fulfilled).length,
        remaining: requiredStatus.filter((r) => !r.fulfilled).map((r) => r.code),
        details: requiredStatus,
      },
      elective_groups: electiveStatus,
      area_requirements: areaStatus,
      credits: {
        scheduled: totalCredits,
        target: reqs.total_credits || null,
        remaining: reqs.total_credits ? Math.max(0, reqs.total_credits - totalCredits) : null,
      },
      term_breakdown: termBreakdown,
      total_unique_courses: allCodes.size,
    };
  },
});

export const updateRequirements = tool({
  description:
    "Partially update program requirements — add or remove specific required courses, add completed courses, or modify specific fields without replacing everything.",
  inputSchema: z.object({
    program_name: z.string().describe("Program to update"),
    add_required_courses: z.array(z.string()).optional().describe("Course codes to ADD to required list"),
    remove_required_courses: z.array(z.string()).optional().describe("Course codes to REMOVE from required list"),
    add_completed_courses: z.array(z.string()).optional().describe("Course codes to mark as completed"),
    remove_completed_courses: z.array(z.string()).optional().describe("Course codes to unmark as completed"),
    total_credits: z.number().optional().describe("Update total credit requirement"),
  }),
  execute: async (input) => {
    const { data: existing } = await supabase
      .from("program_requirements")
      .select("requirements")
      .eq("session_id", getSessionId())
      .eq("program_name", input.program_name)
      .single();

    if (!existing) return { success: false, message: `No requirements found for "${input.program_name}".` };

    const reqs = existing.requirements as {
      required_courses?: string[];
      completed_courses?: string[];
      total_credits?: number;
      [key: string]: unknown;
    };

    if (input.add_required_courses) {
      reqs.required_courses = [...new Set([...(reqs.required_courses || []), ...input.add_required_courses])];
    }
    if (input.remove_required_courses) {
      const toRemove = new Set(input.remove_required_courses);
      reqs.required_courses = (reqs.required_courses || []).filter((c) => !toRemove.has(c));
    }
    if (input.add_completed_courses) {
      reqs.completed_courses = [...new Set([...(reqs.completed_courses || []), ...input.add_completed_courses])];
    }
    if (input.remove_completed_courses) {
      const toRemove = new Set(input.remove_completed_courses);
      reqs.completed_courses = (reqs.completed_courses || []).filter((c) => !toRemove.has(c));
    }
    if (input.total_credits !== undefined) {
      reqs.total_credits = input.total_credits;
    }

    const { error } = await supabase
      .from("program_requirements")
      .update({ requirements: reqs, updated_at: new Date().toISOString() })
      .eq("session_id", getSessionId())
      .eq("program_name", input.program_name);

    if (error) return { success: false, message: error.message };
    return { success: true, message: `Updated "${input.program_name}" requirements.` };
  },
});

export const lookupProgramRequirements = tool({
  description:
    "Look up official JHU degree requirements for a program (major, minor, master's, PhD). Has data for 285 programs from Krieger and Whiting schools. Use when a user asks about requirements for a specific major/minor, or when they want to load requirements automatically.",
  inputSchema: z.object({
    programName: z.string().optional().describe("Exact or partial program name, e.g. 'Computer Science, Bachelor of Science' or 'French'"),
    search: z.string().optional().describe("Search query to find programs. Use when user says 'CS major' or 'French minor'."),
  }),
  execute: async (input) => {
    if (input.search) {
      const rows = await searchProgramsWithCounts(input.search);
      if (rows.length === 0) return { found: false, message: `No programs found matching "${input.search}".` };
      return { found: true, programs: rows };
    }

    if (!input.programName) return { found: false, message: "Provide a program name or search query." };

    const { data: rows } = await supabase
      .from("program_tags")
      .select("section_h2, offering_name, course_title, credits, requirement_type, is_alternative, notes")
      .eq("program_name", input.programName)
      .order("id");

    if (!rows || rows.length === 0) {
      const partial = await searchProgramsWithCounts(input.programName);
      if (partial.length > 0) {
        return { found: false, message: `Exact match not found. Did you mean: ${partial.map((p) => p.program_name).join(", ")}?` };
      }
      return { found: false, message: `No program found matching "${input.programName}".` };
    }

    const groups: Record<string, { courses: { code: string; title: string; credits: string; isAlt: boolean }[]; notes: string[] }> = {};
    const allRequiredCodes: string[] = [];

    for (const r of rows) {
      const groupKey = r.section_h2 || "General";
      if (!groups[groupKey]) groups[groupKey] = { courses: [], notes: [] };
      if (r.offering_name) {
        groups[groupKey].courses.push({
          code: r.offering_name,
          title: r.course_title,
          credits: r.credits,
          isAlt: r.is_alternative === 1,
        });
        if (r.requirement_type === "required") allRequiredCodes.push(r.offering_name);
      }
      if (r.notes && r.requirement_type === "comment") {
        groups[groupKey].notes.push(r.notes);
      }
    }

    return {
      found: true,
      program_name: input.programName,
      groups,
      required_course_codes: allRequiredCodes,
      total_courses: rows.filter((r) => r.offering_name).length,
    };
  },
});

export const loadProgramAsRequirements = tool({
  description:
    "Load an official JHU program's requirements and save them as the user's requirements. Use when the user says 'load CS major requirements' or 'I'm a CS major, load my requirements'.",
  inputSchema: z.object({
    programName: z.string().describe("Exact program name from lookupProgramRequirements, e.g. 'Computer Science, Bachelor of Science'"),
  }),
  execute: async ({ programName }) => {
    const rows = await getProgramTagCodes(programName);

    if (rows.length === 0) return { success: false, message: `No requirements found for "${programName}".` };

    const requiredCourses = [...new Set(rows.filter((r) => r.requirement_type === "required").map((r) => r.offering_name))];
    const electiveCourses = [...new Set(rows.filter((r) => r.requirement_type === "elective").map((r) => r.offering_name))];

    const requirements = {
      required_courses: requiredCourses,
      elective_groups: electiveCourses.length > 0
        ? [{ name: "Electives / Alternatives", course_codes: electiveCourses }]
        : [],
      completed_courses: [],
      notes: `Auto-loaded from JHU e-catalogue for ${programName}`,
    };

    const { error } = await supabase.from("program_requirements").upsert(
      {
        session_id: getSessionId(),
        program_name: programName,
        requirements,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,program_name" }
    );

    if (error) return { success: false, message: error.message };
    return {
      success: true,
      message: `Loaded ${requiredCourses.length} required courses and ${electiveCourses.length} elective options for "${programName}".`,
      required_courses: requiredCourses.length,
      elective_options: electiveCourses.length,
    };
  },
});
