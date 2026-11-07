"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_NAME_LEN,
  inputValueToMinutes,
  minutesToInputValue,
  normalizeDays,
  validateActivity,
} from "@/lib/activities";

const DAY_CODES = ["M", "T", "W", "Th", "F"] as const;
const DAY_LABEL: Record<string, string> = { M: "M", T: "T", W: "W", Th: "Th", F: "F" };

export interface ActivityDraftState {
  /** Absent while creating; present when editing an existing row. */
  id?: number;
  name: string;
  days: string;
  start_min: number;
  end_min: number;
}

/**
 * The card for naming a new time block or editing one that exists. The parent
 * positions it; this only draws and validates.
 *
 * Save is deliberately gated on the same `validateActivity` the HTTP route and
 * the chat tool use, so the three can't drift into disagreeing about what is
 * storable.
 */
export function ActivityEditor({
  draft,
  onSave,
  onDelete,
  onCancel,
  saving,
}: {
  draft: ActivityDraftState;
  onSave: (value: ActivityDraftState) => void;
  onDelete?: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [name, setName] = useState(draft.name);
  const [days, setDays] = useState(draft.days);
  const [start, setStart] = useState(minutesToInputValue(draft.start_min));
  const [end, setEnd] = useState(minutesToInputValue(draft.end_min));
  const nameRef = useRef<HTMLInputElement>(null);

  // The fields start from the draft and are the user's from then on. Opening
  // the editor on a different block is a remount, not a sync: the caller keys
  // this component by the block it belongs to, which is what keeps a half-typed
  // name from leaking onto the next one.
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const startMin = inputValueToMinutes(start);
  const endMin = inputValueToMinutes(end);
  const checked =
    startMin === null || endMin === null
      ? { ok: false as const, error: "Enter a start and end time." }
      : validateActivity({ name, days, start_min: startMin, end_min: endMin });

  // Toggle on the day list, not the raw string: removing "T" from "TTh" by
  // string surgery eats the "T" of "Th" and leaves a stray "h".
  const toggleDay = (d: string) =>
    setDays((prev) => {
      const current = splitDays(prev);
      const next = current.includes(d) ? current.filter((x) => x !== d) : [...current, d];
      return normalizeDays(next.join(""));
    });

  const submit = () => {
    if (!checked.ok || saving) return;
    onSave({ id: draft.id, ...checked.value });
  };

  return (
    <div
      className="w-64 rounded-lg border border-slate-200 bg-white shadow-xl p-3"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <input
        ref={nameRef}
        value={name}
        maxLength={MAX_NAME_LEN}
        onChange={(e) => setName(e.target.value)}
        placeholder="Chess Club"
        aria-label="Activity name"
        className="w-full px-2 py-1.5 text-[12px] font-medium rounded-md border border-slate-200 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-200"
      />

      <div className="flex gap-1 mt-2" role="group" aria-label="Days">
        {DAY_CODES.map((d) => {
          const active = splitDays(days).includes(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              aria-pressed={active}
              className={`flex-1 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                active
                  ? "bg-violet-100 text-violet-700 border border-violet-300"
                  : "bg-slate-50 text-slate-400 border border-slate-200 hover:bg-slate-100"
              }`}
            >
              {DAY_LABEL[d]}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 mt-2">
        <input
          type="time"
          value={start}
          step={900}
          onChange={(e) => setStart(e.target.value)}
          aria-label="Start time"
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] rounded-md border border-slate-200 focus:border-violet-400 focus:outline-none"
        />
        <span className="text-[11px] text-slate-400">to</span>
        <input
          type="time"
          value={end}
          step={900}
          onChange={(e) => setEnd(e.target.value)}
          aria-label="End time"
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] rounded-md border border-slate-200 focus:border-violet-400 focus:outline-none"
        />
      </div>

      {!checked.ok && (
        <p className="mt-2 text-[10px] text-amber-600 leading-snug">{checked.error}</p>
      )}

      <div className="flex items-center gap-1.5 mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={!checked.ok || saving}
          className="flex-1 py-1.5 rounded-md text-[11px] font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
        >
          {saving ? "Saving…" : draft.id ? "Save" : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1.5 rounded-md text-[11px] text-slate-500 hover:bg-slate-100 transition-colors"
        >
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete activity"
            aria-label="Delete activity"
            className="px-2 py-1.5 rounded-md text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            &#10005;
          </button>
        )}
      </div>
    </div>
  );
}

/** "TTh" -> ["T","Th"], so a day button knows whether it is on. */
function splitDays(days: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < days.length) {
    if (days[i] === "T" && days[i + 1] === "h") {
      out.push("Th");
      i += 2;
    } else {
      out.push(days[i]);
      i += 1;
    }
  }
  return out;
}
