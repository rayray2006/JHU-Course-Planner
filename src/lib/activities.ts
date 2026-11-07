/**
 * Custom time blocks — club meetings, work shifts, practice, anything that
 * isn't a course but still takes up the week.
 *
 * Stored structurally (days + minutes from midnight) rather than as a SIS
 * meetings string, because these are edited: a time picker wants numbers, and
 * re-parsing "MW 10:00AM - 11:00AM" on every edit would be a round trip
 * through a format that exists only because SIS hands it to us.
 *
 * For rendering, `activityMeetings` converts back, which lets an activity ride
 * through the calendar as an ordinary scheduled entry and reuse the same
 * parser, layout and overlap handling as courses.
 */

import { expandDays } from "./meeting-time";

export interface Activity {
  id: number;
  name: string;
  /** SIS-style day string: "M", "TTh", "MWF". */
  days: string;
  /** Minutes from midnight. */
  start_min: number;
  end_min: number;
}

/** The grid runs 8am to 10pm; nothing outside it can be drawn. */
export const GRID_START_MIN = 8 * 60;
export const GRID_END_MIN = 22 * 60;

/** Dragging and the time pickers both land on quarter hours. */
export const SNAP_MIN = 15;

export const MIN_DURATION_MIN = 15;
export const MAX_NAME_LEN = 60;

const DAY_ORDER = ["M", "T", "W", "Th", "F", "Sa", "S"];

export function minutesToLabel(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")}${h24 >= 12 ? "PM" : "AM"}`;
}

/** "09:30" — what <input type="time"> expects and returns. */
export function minutesToInputValue(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export function inputValueToMinutes(value: string): number | null {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return mins >= 0 && mins <= 24 * 60 ? mins : null;
}

/** The SIS-shaped string the calendar's meeting parser already understands. */
export function activityMeetings(a: Pick<Activity, "days" | "start_min" | "end_min">): string {
  return `${a.days} ${minutesToLabel(a.start_min)} - ${minutesToLabel(a.end_min)}`;
}

/**
 * Normalise a day string to the canonical codes in week order, dropping
 * anything that isn't a weekday. Returns "" when nothing survives, which
 * callers treat as invalid — a block on no days cannot be drawn.
 */
export function normalizeDays(raw: string): string {
  const seen = new Set(
    expandDays(raw.replace(/[\s,]/g, ""))
      .map((d) => {
        // Tolerate what a model is likely to emit: "Mon", "TUE", "thursday".
        const lower = d.toLowerCase();
        if (lower.startsWith("th")) return "Th";
        if (lower.startsWith("sa")) return "Sa";
        if (lower.startsWith("su")) return "S";
        const first = d[0]?.toUpperCase();
        return DAY_ORDER.includes(first) ? first : "";
      })
      .filter(Boolean)
  );
  return DAY_ORDER.filter((d) => seen.has(d)).join("");
}

/**
 * Accept a model's or a form's idea of a time: "3pm", "15:00", "3:30 PM".
 * Returns minutes from midnight, or null.
 */
export function parseTimeInput(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else if (h > 23) return null;
  return h * 60 + min;
}

export interface ActivityDraft {
  name: string;
  days: string;
  start_min: number;
  end_min: number;
}

/**
 * One place that decides whether a draft is storable, so the HTTP route, the
 * chat tool and the editor all reject the same things for the same reasons.
 */
export function validateActivity(draft: {
  name?: unknown;
  days?: unknown;
  start_min?: unknown;
  end_min?: unknown;
}): { ok: true; value: ActivityDraft } | { ok: false; error: string } {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) return { ok: false, error: "Give the activity a name." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.` };
  }

  const days = normalizeDays(typeof draft.days === "string" ? draft.days : "");
  if (!days) return { ok: false, error: "Give at least one weekday, e.g. 'MW' or 'TTh'." };

  const start = Number(draft.start_min);
  const end = Number(draft.end_min);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, error: "Start and end must be times." };
  }
  if (end - start < MIN_DURATION_MIN) {
    return { ok: false, error: `An activity has to last at least ${MIN_DURATION_MIN} minutes.` };
  }
  if (start < GRID_START_MIN || end > GRID_END_MIN) {
    return {
      ok: false,
      error: `The calendar only shows ${minutesToLabel(GRID_START_MIN)} to ${minutesToLabel(GRID_END_MIN)}.`,
    };
  }

  return { ok: true, value: { name, days, start_min: Math.round(start), end_min: Math.round(end) } };
}

export function snap(mins: number): number {
  return Math.round(mins / SNAP_MIN) * SNAP_MIN;
}
