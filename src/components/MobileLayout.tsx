"use client";

import { useEffect, useRef, useState } from "react";
import { isToolUIPart } from "ai";
import { SCHEDULE_SLOTS, scheduleSlotLabel } from "@/lib/schedule-slots";
import type { CourseAgentUIMessage } from "@/lib/agents/course-agent";
import {
  type ScheduledCourse,
  DAYS_LONG,
  parseMeetings,
  formatTime,
  colorFor,
  md,
} from "@/lib/schedule-utils";
import { MessageContent } from "./MessageContent";
import { ThemeToggle } from "@/components/ThemeToggle";

type Tab = "schedule" | "chat";

interface SearchResult {
  offering_name: string;
  section_name: string;
  title: string;
  credits: string;
  meetings: string;
  instructors_full_name: string;
  department?: string;
}

interface MobileLayoutProps {
  // Term (display only — the planner is pinned to one term)
  activeTerm: string;

  // Which parallel schedule is open, and how to switch it. Owned by the page
  // so mobile and desktop always act on the same one.
  activeSlot: number;
  slotCounts: Record<number, number>;
  selectSlot: (slot: number) => void;

  // Schedule
  schedule: ScheduledCourse[];
  scheduleLoaded: boolean;
  totalCredits: number;
  fetchSchedule: () => void;
  selected: ScheduledCourse | null;
  setSelected: (c: ScheduledCourse | null) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: SearchResult[];
  searchLoading: boolean;

  // Chat
  messages: CourseAgentUIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: (msg: any) => void;
  setMessages: (m: CourseAgentUIMessage[]) => void;
  input: string;
  setInput: (s: string) => void;
  isLoading: boolean;
  validCourses: Set<string>;
  courseSections: { code: string; section: string }[];
  handlePreview: (code: string, section: string) => void;
  clearPreview: () => void;
}

const STARTERS = [
  "Add Data Structures section 01 to my schedule and find CS classes that don't conflict",
  "Find upper level CS courses rated above 4.0 that don't require Data Structures",
  "Which CS professors have the highest RMP ratings and what are they teaching?",
  "Find me easy writing intensives on TTh before noon",
];

export function MobileLayout(props: MobileLayoutProps) {
  const [tab, setTab] = useState<Tab>("schedule");

  return (
    <div className="mobile-screen flex flex-col bg-white text-slate-900 overflow-hidden">
      <MobileHeader activeTerm={props.activeTerm} activeSlot={props.activeSlot} slotCounts={props.slotCounts} selectSlot={props.selectSlot} />

      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "schedule" && <ScheduleTab {...props} />}
        {tab === "chat" && <ChatTab {...props} />}
      </main>

      <BottomTabs tab={tab} setTab={setTab} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────

function MobileHeader({ activeTerm, activeSlot, slotCounts, selectSlot }: {
  activeTerm: string;
  activeSlot: number;
  slotCounts: Record<number, number>;
  selectSlot: (slot: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <header className="shrink-0 flex items-center justify-between px-4 h-12 border-b border-slate-200 bg-white safe-pt">
      <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">JHU Planner</h1>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <span className="text-[12px] font-medium text-slate-500">{activeTerm}</span>
        <div className="relative" ref={ref}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`${scheduleSlotLabel(activeSlot)}. Switch schedule`}
            className="flex items-center gap-1 pl-2.5 pr-2 py-1 rounded-full border border-slate-200 bg-slate-50 text-[12px] font-medium text-slate-600 active:bg-slate-100"
          >
            {scheduleSlotLabel(activeSlot)}
            <svg className={`w-3 h-3 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
          {open && (
            <div role="listbox" aria-label="Schedules" className="absolute right-0 top-full mt-1 w-44 rounded-md border border-slate-200 bg-white shadow-lg py-1 z-[200]">
              {SCHEDULE_SLOTS.map((slotNo) => {
                const n = slotCounts[slotNo] ?? 0;
                return (
                  <button
                    key={slotNo}
                    type="button"
                    role="option"
                    aria-selected={slotNo === activeSlot}
                    onClick={() => { selectSlot(slotNo); setOpen(false); }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[12px] ${slotNo === activeSlot ? "font-semibold text-blue-600" : "text-slate-600"}`}
                  >
                    <span>{scheduleSlotLabel(slotNo)}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {n === 0 ? "empty" : `${n} course${n === 1 ? "" : "s"}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Bottom tab bar
// ─────────────────────────────────────────────────────────────────────────

function BottomTabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: "schedule",
      label: "Schedule",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      ),
    },
    {
      id: "chat",
      label: "Assistant",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
  ];

  return (
    <nav className="shrink-0 grid grid-cols-2 border-t border-slate-200 bg-white/95 backdrop-blur-md safe-pb">
      {items.map((it) => {
        const active = tab === it.id;
        return (
          <button
            key={it.id}
            onClick={() => setTab(it.id)}
            className={`flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
              active ? "text-blue-600" : "text-slate-400 active:text-slate-600"
            }`}
          >
            {it.icon}
            <span className="text-[10px] font-medium">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SCHEDULE TAB
// ─────────────────────────────────────────────────────────────────────────

function ScheduleTab(props: MobileLayoutProps) {
  const { schedule, scheduleLoaded, totalCredits, selected, setSelected, fetchSchedule, activeTerm, activeSlot } = props;
  const [searchOpen, setSearchOpen] = useState(false);

  // Group courses by day
  const byDay: ScheduledCourse[][] = [[], [], [], [], []];
  const noTime: ScheduledCourse[] = [];

  for (const c of schedule) {
    const blocks = parseMeetings(c.meetings);
    if (blocks.length === 0) {
      noTime.push(c);
      continue;
    }
    const seenDays = new Set<number>();
    for (const b of blocks) for (const d of b.days) if (d <= 4) seenDays.add(d);
    if (seenDays.size === 0) noTime.push(c);
    else for (const d of seenDays) byDay[d].push(c);
  }

  // Sort each day by start time
  for (const day of byDay) {
    day.sort((a, b) => {
      const aFirst = parseMeetings(a.meetings)[0];
      const bFirst = parseMeetings(b.meetings)[0];
      if (!aFirst || !bFirst) return 0;
      return aFirst.startHour * 60 + aFirst.startMin - (bFirst.startHour * 60 + bFirst.startMin);
    });
  }

  const removeCourse = async (c: ScheduledCourse) => {
    await fetch("/api/schedule", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offering_name: c.offering_name,
        section_name: c.section_name,
        term: activeTerm,
        slot: activeSlot,
      }),
    });
    fetchSchedule();
    setSelected(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar — only when schedule has content (the empty state is the CTA) */}
      {scheduleLoaded && schedule.length > 0 && (
        <div className="shrink-0 px-4 py-2.5 flex items-center justify-between border-b border-slate-100 bg-white">
          <div className="text-[12px] text-slate-500">
            <span className="font-semibold text-slate-700">{schedule.length}</span> course
            {schedule.length === 1 ? "" : "s"}
            <span className="mx-1.5 text-slate-300">·</span>
            <span className="font-semibold text-slate-700">{totalCredits}</span> credits
          </div>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 text-white text-[12px] font-medium active:bg-blue-700"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!scheduleLoaded ? (
          <div className="px-4 py-12 text-center text-[12px] text-slate-400">Loading schedule…</div>
        ) : schedule.length === 0 ? (
          <ScheduleEmpty onAdd={() => setSearchOpen(true)} />
        ) : (
          <div className="px-4 py-4 space-y-5">
            {byDay.map((day, idx) => {
              if (day.length === 0) return null;
              return (
                <DaySection
                  key={idx}
                  dayName={DAYS_LONG[idx]}
                  dayIdx={idx}
                  courses={day}
                  onSelect={setSelected}
                />
              );
            })}
            {noTime.length > 0 && (
              <NoTimeSection courses={noTime} onSelect={setSelected} />
            )}
          </div>
        )}
      </div>

      {/* Course detail sheet */}
      {selected && (
        <CourseSheet
          course={selected}
          onClose={() => setSelected(null)}
          onRemove={() => removeCourse(selected)}
        />
      )}

      {/* Add-course modal */}
      {searchOpen && (
        <SearchSheet
          activeTerm={activeTerm}
          searchQuery={props.searchQuery}
          setSearchQuery={props.setSearchQuery}
          searchResults={props.searchResults}
          searchLoading={props.searchLoading}
          onClose={() => setSearchOpen(false)}
          onAdd={async (r) => {
            await fetch("/api/schedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                offering_name: r.offering_name,
                section_name: r.section_name,
                term: activeTerm,
                slot: activeSlot,
              }),
            });
            fetchSchedule();
            setSearchOpen(false);
            props.setSearchQuery("");
          }}
        />
      )}
    </div>
  );
}

function ScheduleEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 pt-20 pb-12 text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-blue-600" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </div>
      <h2 className="text-[15px] font-semibold text-slate-800 mb-1">No courses yet</h2>
      <p className="text-[12px] text-slate-500 mb-5">Add your first class to start building a schedule.</p>
      <button
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 text-white text-[13px] font-medium active:bg-blue-700"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add a course
      </button>
    </div>
  );
}

function DaySection({
  dayName,
  dayIdx,
  courses,
  onSelect,
}: {
  dayName: string;
  dayIdx: number;
  courses: ScheduledCourse[];
  onSelect: (c: ScheduledCourse) => void;
}) {
  return (
    <section>
      <h3 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {dayName}
        <span className="ml-1.5 text-slate-300 normal-case font-medium">· {courses.length}</span>
      </h3>
      <div className="space-y-2">
        {courses.map((c) => (
          <CourseCard key={`${c.offering_name}-${c.section_name}-${dayIdx}`} course={c} dayIdx={dayIdx} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

function NoTimeSection({
  courses,
  onSelect,
}: {
  courses: ScheduledCourse[];
  onSelect: (c: ScheduledCourse) => void;
}) {
  return (
    <section>
      <h3 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        No scheduled time
        <span className="ml-1.5 text-slate-300 normal-case font-medium">· {courses.length}</span>
      </h3>
      <div className="space-y-2">
        {courses.map((c) => (
          <CourseCard key={`${c.offering_name}-${c.section_name}-tba`} course={c} dayIdx={-1} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

function CourseCard({
  course,
  dayIdx,
  onSelect,
}: {
  course: ScheduledCourse;
  dayIdx: number;
  onSelect: (c: ScheduledCourse) => void;
}) {
  const blocks = parseMeetings(course.meetings);
  const block = dayIdx >= 0 ? blocks.find((b) => b.days.includes(dayIdx)) : null;
  const color = colorFor(`${course.offering_name}::${course.section_name}`);

  return (
    <button
      onClick={() => onSelect(course)}
      className="w-full text-left rounded-xl border bg-white px-3.5 py-3 active:bg-slate-50 transition-colors flex gap-3"
      style={{ borderColor: color.border }}
    >
      <span
        className="w-1 self-stretch rounded-full shrink-0"
        style={{ background: color.border }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className="text-[13px] font-semibold text-slate-900 truncate">{course.title}</span>
          <span className="text-[11px] font-mono text-slate-400 shrink-0">{course.offering_name}</span>
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {block ? (
            <>
              <span className="font-medium text-slate-700">
                {formatTime(block.startHour, block.startMin)} – {formatTime(block.endHour, block.endMin)}
              </span>
              {course.location && course.location !== "TBA" && (
                <>
                  <span className="mx-1.5 text-slate-300">·</span>
                  <span>{course.location}</span>
                </>
              )}
            </>
          ) : (
            <span className="italic text-slate-400">No scheduled time</span>
          )}
          {course.instructors_full_name && course.instructors_full_name !== "Staff" && (
            <>
              <span className="mx-1.5 text-slate-300">·</span>
              <span>{course.instructors_full_name}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function CourseSheet({
  course,
  onClose,
  onRemove,
}: {
  course: ScheduledCourse;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-h-[80%] bg-white rounded-t-2xl shadow-xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-center pt-2.5 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="px-5 pb-3 pt-1 border-b border-slate-100">
          <div className="text-[11px] font-mono text-slate-400 mb-0.5">
            {course.offering_name} · Section {course.section_name}
          </div>
          <h2 className="text-[16px] font-semibold text-slate-900">{course.title}</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 text-[13px]">
          <DetailRow label="Credits" value={course.credits} />
          <DetailRow label="Meetings" value={course.meetings || "TBA"} />
          {course.location && course.location !== "TBA" && (
            <DetailRow label="Location" value={`${course.location}${course.building ? `, ${course.building}` : ""}`} />
          )}
          <DetailRow label="Instructor" value={course.instructors_full_name || "Staff"} />
          {course.instruction_method && <DetailRow label="Method" value={course.instruction_method} />}
          {course.department && <DetailRow label="Department" value={course.department} />}
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-slate-100 safe-pb flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-[13px] font-medium active:bg-slate-200"
          >
            Close
          </button>
          <button
            onClick={onRemove}
            className="flex-1 py-2.5 rounded-xl bg-red-50 text-red-600 text-[13px] font-medium active:bg-red-100"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-wider text-slate-400 pt-0.5">{label}</span>
      <span className="flex-1 text-slate-800">{value}</span>
    </div>
  );
}

function SearchSheet({
  activeTerm,
  searchQuery,
  setSearchQuery,
  searchResults,
  searchLoading,
  onClose,
  onAdd,
}: {
  activeTerm: string;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: SearchResult[];
  searchLoading: boolean;
  onClose: () => void;
  onAdd: (r: SearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="shrink-0 flex items-center gap-2 px-3 h-14 border-b border-slate-200 safe-pt">
        <button onClick={onClose} className="p-2 -ml-1 text-slate-500 active:text-slate-700">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Search courses in ${activeTerm}`}
          className="flex-1 px-3 py-2 rounded-lg bg-slate-100 text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </header>
      <div className="flex-1 overflow-y-auto">
        {searchQuery.length < 2 && (
          <div className="px-6 py-12 text-center text-[12px] text-slate-400">
            Type at least 2 characters to search.
          </div>
        )}
        {searchQuery.length >= 2 && searchLoading && (
          <div className="px-6 py-12 text-center text-[12px] text-slate-400">Searching…</div>
        )}
        {searchQuery.length >= 2 && !searchLoading && searchResults.length === 0 && (
          <div className="px-6 py-12 text-center text-[12px] text-slate-400">No courses found.</div>
        )}
        <ul className="divide-y divide-slate-100">
          {searchResults.map((r) => (
            <li key={`${r.offering_name}-${r.section_name}`} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-slate-900 truncate">{r.title}</div>
                <div className="text-[11px] text-slate-500 truncate">
                  <span className="font-mono">{r.offering_name}.{r.section_name}</span>
                  {r.meetings && (
                    <>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span>{r.meetings}</span>
                    </>
                  )}
                  {r.instructors_full_name && (
                    <>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span>{r.instructors_full_name}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={() => onAdd(r)}
                className="shrink-0 px-3 py-1.5 rounded-full bg-blue-600 text-white text-[12px] font-medium active:bg-blue-700"
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// CHAT TAB
// ─────────────────────────────────────────────────────────────────────────

function ChatTab(props: MobileLayoutProps) {
  const {
    activeSlot,
    messages,
    sendMessage,
    setMessages,
    input,
    setInput,
    isLoading,
    validCourses,
    courseSections,
    handlePreview,
    clearPreview,
    activeTerm,
    fetchSchedule,
  } = props;

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const showLoading =
    isLoading &&
    (() => {
      const last = messages[messages.length - 1];
      if (!last) return true;
      if (last.role === "user") return true;
      const hasText = last.parts.some((p) => p.type === "text" && p.text.trim());
      return !hasText;
    })();

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 py-2 border-b border-slate-100 flex items-center justify-between">
        <span className="text-[12px] font-medium text-slate-500">Course Assistant</span>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="text-[11px] text-slate-400 active:text-slate-600"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {messages.length === 0 && !isLoading && (
          <div className="px-1 pt-3 space-y-3">
            <p className="text-[13px] text-slate-500 leading-relaxed px-1">
              Ask me anything about JHU courses, professors, schedules, or prerequisites.
            </p>
            <div className="space-y-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage({ text: s })}
                  className="block w-full text-left px-3.5 py-2.5 rounded-xl text-[12.5px] text-slate-700 bg-slate-50 active:bg-blue-50 active:text-blue-700 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          if (message.role === "assistant") {
            const hasVisible = message.parts.some((p) => p.type === "text" && p.text.trim());
            if (!hasVisible) return null;
          }
          return (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                  message.role === "user"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-800"
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    if (message.role === "user") {
                      return (
                        <div
                          key={i}
                          className="text-[13px] leading-[1.55] [&>strong]:font-semibold"
                          dangerouslySetInnerHTML={{ __html: md(part.text) }}
                        />
                      );
                    }
                    return (
                      <div
                        key={i}
                        className="text-[13px] leading-[1.55] [&>strong]:font-semibold"
                      >
                        <MessageContent
                          html={md(part.text)}
                          validCourses={validCourses}
                          courseSections={courseSections}
                          size="lg"
                          onAdd={async (code, section) => {
                            await fetch("/api/schedule", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                offering_name: code,
                                section_name: section,
                                term: activeTerm,
                                slot: activeSlot,
                              }),
                            });
                            fetchSchedule();
                            clearPreview();
                          }}
                          onPreview={handlePreview}
                          onPreviewEnd={clearPreview}
                        />
                      </div>
                    );
                  }
                  if (isToolUIPart(part)) return null;
                  return null;
                })}
              </div>
            </div>
          );
        })}

        {showLoading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 rounded-2xl px-3.5 py-2.5">
              <span className="flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2.5 border-t border-slate-100 bg-white">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !isLoading) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
          className="flex items-end gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="Ask about courses…"
            className="flex-1 px-3.5 py-2.5 rounded-2xl bg-slate-100 border border-transparent text-[14px] placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-300 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 transition-all"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="shrink-0 w-10 h-10 rounded-full bg-blue-600 text-white disabled:bg-slate-200 disabled:text-slate-400 active:bg-blue-700 transition-colors flex items-center justify-center"
            aria-label="Send"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
