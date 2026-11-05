/**
 * Meeting-time parsing shared by the search filters and the conflict checker.
 *
 * SIS packs a section's whole week into one string: comma-separated blocks like
 * "MWF 9:00AM - 9:50AM, Th 5:00PM - 6:15PM", where the later blocks are usually
 * a lab, section or discussion. Anything that asks a time question about a
 * course has to consider every block, not just the first.
 */

/** Day codes SIS uses. "Th" and "Sa" are two letters; a lone "S" is Sunday. */
const VALID_DAYS = new Set(["M", "T", "W", "Th", "F", "Sa", "S"]);

export interface MeetingTimeBlock {
  days: string[];
  startMin: number;
  endMin: number;
}

/**
 * Split a day string into day codes, matching "Th" and "Sa" before the single
 * letters so they win over "T" and Sunday's "S".
 *
 * Deliberately lenient: it is also used on day filters coming from the model,
 * where something like "Friday" should still yield a usable "F".
 */
export function expandDays(dayStr: string): string[] {
  const days: string[] = [];
  let i = 0;
  while (i < dayStr.length) {
    if (dayStr[i] === "T" && dayStr[i + 1] === "h") {
      days.push("Th");
      i += 2;
    } else if (dayStr[i] === "S" && dayStr[i + 1] === "a") {
      days.push("Sa");
      i += 2;
    } else {
      days.push(dayStr[i]);
      i += 1;
    }
  }
  return days;
}

/** Strict form for course data: rejects "None", "TBA" and other non-day text. */
function parseDays(dayStr: string): string[] | null {
  const days = expandDays(dayStr);
  if (days.length === 0) return null;
  if (!days.every((d) => VALID_DAYS.has(d))) return null;
  return days;
}

// A trailing label is allowed and ignored: SIS writes things like
// "Th 7:30PM - 10:00PM Screenings" for film sections.
const BLOCK_RE =
  /^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)(?:\s+\S.*)?$/;

function parseBlock(part: string): MeetingTimeBlock | null {
  const match = part.trim().match(BLOCK_RE);
  if (!match) return null;
  const [, dayStr, sh, sm, sap, eh, em, eap] = match;
  const days = parseDays(dayStr);
  if (!days) return null;
  let startH = parseInt(sh);
  if (sap === "PM" && startH !== 12) startH += 12;
  if (sap === "AM" && startH === 12) startH = 0;
  let endH = parseInt(eh);
  if (eap === "PM" && endH !== 12) endH += 12;
  if (eap === "AM" && endH === 12) endH = 0;
  return { days, startMin: startH * 60 + parseInt(sm), endMin: endH * 60 + parseInt(em) };
}

/** Every meeting block in a SIS meetings string. Unparseable blocks are dropped. */
export function parseMeetingTimes(meetings: string | null | undefined): MeetingTimeBlock[] {
  if (!meetings) return [];
  return meetings
    .split(",")
    .map(parseBlock)
    .filter((b): b is MeetingTimeBlock => b !== null);
}

/** True when the course meets at a real time (so research/independent study is false). */
export function hasScheduledTime(meetings: string | null | undefined): boolean {
  return parseMeetingTimes(meetings).length > 0;
}

export function daysOverlap(a: string[], b: string[]): boolean {
  return a.some((d) => b.includes(d));
}

export function timesOverlap(a: MeetingTimeBlock, b: MeetingTimeBlock): boolean {
  return a.startMin < b.endMin && a.endMin > b.startMin;
}

export function blocksOverlap(a: MeetingTimeBlock, b: MeetingTimeBlock): boolean {
  return daysOverlap(a.days, b.days) && timesOverlap(a, b);
}

/** True if any block of one section collides with any block of the other. */
export function hasConflict(
  meetingsA: string | null | undefined,
  meetingsB: string | null | undefined
): boolean {
  const blocksA = parseMeetingTimes(meetingsA);
  const blocksB = parseMeetingTimes(meetingsB);
  return blocksA.some((a) => blocksB.some((b) => blocksOverlap(a, b)));
}
