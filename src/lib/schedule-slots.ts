/**
 * Each visitor gets a few parallel schedules to try alternatives in.
 *
 * A slot is just a number on the `schedules` row. The column defaults to 1, so
 * every row that existed before slots were introduced is already Schedule 1 —
 * nobody's schedule had to be moved or rewritten to add this feature.
 *
 * Uniqueness in the database includes the slot, which is what lets the same
 * class sit in Schedule 1 and Schedule 2 at once. Without that, the upsert
 * would match the existing row on the old key and quietly move it between
 * slots instead of adding a second copy.
 */
export const SCHEDULE_SLOTS = [1, 2, 3] as const;
export const DEFAULT_SCHEDULE_SLOT = 1;

export const scheduleSlotLabel = (slot: number) => `Schedule ${slot}`;

/**
 * Coerce anything that arrived from a client into a real slot.
 *
 * Callers pass query strings, JSON bodies and tool arguments, none of which are
 * trustworthy: an out-of-range slot would write rows the UI can never show
 * again, and the database CHECK would reject it anyway.
 */
export function parseScheduleSlot(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return SCHEDULE_SLOTS.includes(n as (typeof SCHEDULE_SLOTS)[number]) ? n : DEFAULT_SCHEDULE_SLOT;
}
