"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { isToolUIPart } from "ai";
import { useState, useRef, useEffect, useCallback, useMemo, Fragment } from "react";
import type { CourseAgentUIMessage } from "@/lib/agents/course-agent";
import { useIsMobile } from "@/lib/use-is-mobile";
import { MobileLayout } from "@/components/MobileLayout";
import { CURRENT_TERM } from "@/lib/terms";
import { SCHEDULE_SLOTS, DEFAULT_SCHEDULE_SLOT, parseScheduleSlot, scheduleSlotLabel } from "@/lib/schedule-slots";
import { parseMeetings } from "@/lib/schedule-utils";
import { layoutWeek } from "@/lib/calendar-layout";
import { ActivityEditor, type ActivityDraftState } from "@/components/ActivityEditor";
import {
  GRID_END_MIN,
  GRID_START_MIN,
  MIN_DURATION_MIN,
  activityMeetings,
  minutesToLabel,
  snap,
  type Activity,
} from "@/lib/activities";


interface ScheduledCourse {
  offering_name: string;
  section_name: string;
  title: string;
  credits: string;
  meetings: string;
  location: string;
  building: string;
  instructors_full_name: string;
  instruction_method: string;
  department: string;
}

// --- Schedule grid constants ---
const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const HOURS = Array.from({ length: 14 }, (_, i) => i + 8);
const ROW_H = 52; // px per hour row

/** Turn a block's pixel geometry back into "10:30 – 11:45" for the grid's labels. */
function formatSlotTime(top: number, height: number): string {
  const clock = (px: number) => {
    const mins = Math.round((px / ROW_H) * 60) + 8 * 60;
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}:${String(m).padStart(2, "0")}${h24 >= 12 ? "pm" : "am"}`;
  };
  return `${clock(top)} – ${clock(top + height)}`;
}

// --- Color palette (softer, more distinct) ---
const PALETTE = [
  { bg: "#dbeafe", border: "#93c5fd", text: "#1e3a5f" },
  { bg: "#d1fae5", border: "#6ee7b7", text: "#064e3b" },
  { bg: "#ede9fe", border: "#c4b5fd", text: "#3b0764" },
  { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  { bg: "#fce7f3", border: "#f9a8d4", text: "#831843" },
  { bg: "#ccfbf1", border: "#5eead4", text: "#134e4a" },
  { bg: "#ffedd5", border: "#fdba74", text: "#7c2d12" },
  { bg: "#e0e7ff", border: "#a5b4fc", text: "#312e81" },
];

// --- Markdown helper ---
function md(text: string): string {
  const lines = text.split("\n");
  let inList = false;
  let listLevel = 0;
  const out: string[] = [];

  for (const raw of lines) {
    let line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Inline formatting
    line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    line = line.replace(
      /`(.*?)`/g,
      '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:0.7rem;font-family:var(--font-mono)">$1</code>'
    );

    const subBullet = line.match(/^ {2,}\* (.+)/);
    const topBullet = line.match(/^\* (.+)/);

    if (subBullet) {
      if (!inList) { inList = true; listLevel = 1; }
      listLevel = 1;
      out.push(`<div style="padding-left:20px;margin-top:2px;display:flex;gap:6px"><span style="color:#94a3b8;flex-shrink:0">↳</span><span>${subBullet[1]}</span></div>`);
    } else if (topBullet) {
      if (inList) {
        out.push('<div style="margin-top:6px"></div>');
      }
      inList = true;
      listLevel = 0;
      out.push(`<div style="margin-top:2px;display:flex;gap:6px"><span style="color:#94a3b8;flex-shrink:0">•</span><span>${topBullet[1]}</span></div>`);
    } else {
      if (inList) { inList = false; listLevel = 0; }
      line = line.replace(/\*(.*?)\*/g, "<em>$1</em>");
      if (line.trim() === "") {
        out.push('<div style="margin-top:6px"></div>');
      } else {
        out.push(`<div>${line}</div>`);
      }
    }
  }

  return out.join("");
}

// Match course codes and section lines separately
const COURSE_CODE_RE = /[A-Z]{2}\.\d{3}\.\d{3}/g;
const SECTION_RE = /Section\s+(\d{2})/g;

function MessageContent({ html, onAdd, onPreview, onPreviewEnd, validCourses, courseSections }: {
  html: string;
  onAdd: (code: string, section: string) => void;
  onPreview: (code: string, section: string) => void;
  onPreviewEnd: () => void;
  validCourses: Set<string>;
  courseSections: { code: string; section: string }[];
}) {
  // Combined regex: match either a course code or a "Section NN" pattern
  const TOKEN_RE = /([A-Z]{2}\.\d{3}\.\d{3})|Section\s+(\d{2})/g;
  const parts: { type: "html" | "code" | "section"; text: string; value?: string }[] = [];
  let lastIdx = 0;

  const matches = [...html.matchAll(TOKEN_RE)];
  for (const match of matches) {
    const idx = match.index!;
    if (idx > lastIdx) parts.push({ type: "html", text: html.slice(lastIdx, idx) });
    if (match[1]) {
      // Course code like EN.601.230 — also grab the course name that follows
      // e.g. "EN.601.226 Data Structures" or "EN.601.226</strong> Data Structures"
      let endIdx = idx + match[0].length;
      const rest = html.slice(endIdx);
      // Grab trailing text: course name up to em dash (—), HTML tag, line break, another course code, or "Section"
      // Must handle HTML entities (&amp;), hyphens, colons, parens, etc.
      const nameMatch = rest.match(/^((?:\s+(?!Section\s)(?!<)(?!—)(?!\u2014)(?![A-Z]{2}\.\d{3}\.\d{3})(?:&amp;|&lt;|&gt;|[^\s<—\u2014])+)*)/);
      const trailingName = nameMatch ? nameMatch[0] : "";
      endIdx += trailingName.length;
      parts.push({ type: "code", text: html.slice(idx, endIdx), value: match[1] });
      lastIdx = endIdx;
      continue;
    } else if (match[2]) {
      // Section NN
      parts.push({ type: "section", text: match[0], value: match[2] });
    }
    lastIdx = idx + match[0].length;
  }
  if (lastIdx < html.length) parts.push({ type: "html", text: html.slice(lastIdx) });

  if (matches.length === 0) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // Pre-compute: parent course code for each section, and section count per course code
  const sectionCourseMap = new Map<number, string>();
  const codeSectionCount = new Map<number, number>();
  const codeFirstSection = new Map<number, string>(); // for single-section courses
  let currentCode = "";
  let currentCodeIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === "code") {
      currentCode = parts[i].value!;
      currentCodeIdx = i;
      codeSectionCount.set(i, 0);
    }
    if (parts[i].type === "section" && currentCodeIdx >= 0) {
      sectionCourseMap.set(i, currentCode);
      codeSectionCount.set(currentCodeIdx, (codeSectionCount.get(currentCodeIdx) || 0) + 1);
      if (!codeFirstSection.has(currentCodeIdx)) codeFirstSection.set(currentCodeIdx, parts[i].value!);
    }
  }

  const addBtn = (code: string, section: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onAdd(code, section); }}
      onMouseEnter={() => onPreview(code, section)}
      onMouseLeave={onPreviewEnd}
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 hover:bg-emerald-200 text-[9px] font-bold leading-none transition-colors flex-shrink-0 align-middle ml-0.5"
      title={`Add ${code} section ${section}`}
    >+</button>
  );

  // Track which occurrence of each course code we're on, to match with courseSections order
  const codeOccurrence = new Map<string, number>();

  return (
    <span>
      {parts.map((p, i) => {
        if (p.type === "html") {
          return <span key={i} dangerouslySetInnerHTML={{ __html: p.text }} />;
        }
        if (p.type === "code") {
          const code = p.value!;
          const isValid = validCourses.has(code);
          const sectionCount = codeSectionCount.get(i) || 0;

          // Get the correct section for this occurrence of this code
          const occ = codeOccurrence.get(code) || 0;
          codeOccurrence.set(code, occ + 1);
          const matchingSections = courseSections.filter((s) => s.code === code);
          const resolvedSection = matchingSections[occ]?.section || codeFirstSection.get(i) || "01";

          if (sectionCount <= 1 && isValid) {
            return <strong key={i}>{p.text}{addBtn(code, resolvedSection)}</strong>;
          }
          return <strong key={i}>{p.text}</strong>;
        }
        if (p.type === "section") {
          const courseCode = sectionCourseMap.get(i) || "";
          if (!courseCode || !validCourses.has(courseCode)) return <span key={i}>{p.text}</span>;
          // Only show + button if the section appears in a list context (preceded by newline, bullet, or start of text)
          // not inline in prose like "has 1 open seat in Section 01"
          const prevPart = i > 0 ? parts[i - 1] : null;
          const prevText = prevPart?.text || "";
          const isListContext = !prevText || prevText.endsWith("\n") || /[*\-•]\s*$/.test(prevText) || /:\s*$/.test(prevText) || prevPart?.type === "code";
          if (!isListContext) return <span key={i}>{p.text}</span>;
          return <span key={i}>{p.text}{addBtn(courseCode, p.value!)}</span>;
        }
        return <span key={i}>{p.text}</span>;
      })}
    </span>
  );
}

// --- Parse prerequisites: split on ";" into restrictions vs actual prereqs ---
const RESTRICTION_PATTERNS = [
  /^students?\s+(may|can|must|should)\s+(not|only|receive|earn)/i,
  /^student\s+may\s+not\s+enroll/i,
  /^credit\s+(may|can)\s+(only|not)/i,
  /^you\s+(cannot|can\s+not|may\s+not)/i,
];

function splitPrerequisites(raw: string): { restrictions: string[]; prereqs: string[] } {
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean);
  const restrictions: string[] = [];
  const prereqs: string[] = [];
  for (const part of parts) {
    if (RESTRICTION_PATTERNS.some((p) => p.test(part))) {
      restrictions.push(part);
    } else {
      prereqs.push(part);
    }
  }
  return { restrictions, prereqs };
}

// ===================== COMPONENT =====================

export default function Home() {
  const isMobile = useIsMobile();
  // The planner is pinned to one term. The picker, the enrolment window and
  // the past-term "courses taken" flow are gone, so every derived term flag
  // that used to branch on them is now a constant. Schedules saved against
  // other terms stay in the database but are no longer reachable here.
  const activeTerm = CURRENT_TERM;

  // selectedPrograms must be declared before chatTransport
  const [selectedPrograms, setSelectedPrograms] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try { return JSON.parse(localStorage.getItem("jhu_selectedPrograms") || "[]"); } catch { return []; }
    }
    return [];
  });


  // Which of the parallel schedules is open. Remembered per browser so a
  // reload does not drop someone back into Schedule 1 mid-comparison;
  // parseScheduleSlot turns anything stale or hand-edited back into 1.
  const [activeSlot, setActiveSlot] = useState<number>(DEFAULT_SCHEDULE_SLOT);
  const [slotCounts, setSlotCounts] = useState<Record<number, number>>({});
  const [slotOpen, setSlotOpen] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);

  // Read after mount rather than in the initial state: the server renders with
  // Schedule 1, and reading localStorage during render makes the first client
  // render disagree with it.
  useEffect(() => {
    setActiveSlot(parseScheduleSlot(localStorage.getItem("jhu_scheduleSlot")));
  }, []);
  useEffect(() => {
    localStorage.setItem("jhu_scheduleSlot", String(activeSlot));
  }, [activeSlot]);

  useEffect(() => {
    if (!slotOpen) return;
    function handleClick(e: MouseEvent) {
      if (slotRef.current && !slotRef.current.contains(e.target as Node)) setSlotOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [slotOpen]);

  // Which "+N more" tile is expanded, as "<dayIdx>-<top>". Only one at a time.
  const [openCrowded, setOpenCrowded] = useState<string | null>(null);
  const crowdedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openCrowded) return;
    function handleClick(e: MouseEvent) {
      if (crowdedRef.current && !crowdedRef.current.contains(e.target as Node)) setOpenCrowded(null);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenCrowded(null);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openCrowded]);

  const chatTransport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { activeTerm, selectedPrograms, scheduleSlot: activeSlot },
      }),
    [activeTerm, selectedPrograms, activeSlot]
  );

  const { messages, sendMessage, setMessages, status, error } = useChat<CourseAgentUIMessage>({
    transport: chatTransport,
  });

  // Debug: log status transitions and errors
  useEffect(() => {
    if (error) console.error("[chat error]", error);
  }, [error]);
  useEffect(() => {
    console.log("[chat status]", status, "messages:", messages.length, "last role:", messages[messages.length - 1]?.role);
  }, [status, messages]);
  const [input, setInput] = useState("");
  const [schedule, setSchedule] = useState<ScheduledCourse[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

  // The activity editor: a draft plus where on the grid to hang the card.
  const [activityDraft, setActivityDraft] = useState<
    (ActivityDraftState & { dayIdx: number; top: number }) | null
  >(null);
  const [savingActivity, setSavingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  // While the pointer is down on empty grid, the region being swept out.
  const [drag, setDrag] = useState<{ dayIdx: number; fromMin: number; toMin: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const [selected, setSelected] = useState<ScheduledCourse | null>(null);
  const [previewCourse, setPreviewCourse] = useState<ScheduledCourse | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  // --- Direct search bar state ---
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ offering_name: string; section_name: string; title: string; credits: string; meetings: string; instructors_full_name: string; department?: string; source?: string; pos_tags?: string | null }[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expandedSearchCourse, setExpandedSearchCourse] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<typeof searchResults>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);

  // Debounced search via API
  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/course-search?q=${encodeURIComponent(q)}&term=${encodeURIComponent(activeTerm)}&mode=term`);
      if (res.ok) setSearchResults(await res.json());
      else setSearchResults([]);
    } catch { setSearchResults([]); }
    setSearchLoading(false);
  }, [activeTerm]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (searchQuery.length < 2) { setSearchResults([]); setExpandedSearchCourse(null); return; }
    searchTimerRef.current = setTimeout(() => doSearch(searchQuery), 250);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, doSearch]);

  // Close search dropdown on outside click
  useEffect(() => {
    if (!searchOpen) return;
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [searchOpen]);

  // Requirements panel state
  const [reqPanelOpen, setReqPanelOpen] = useState(false);
  const [programs, setPrograms] = useState<{ program_name: string; school: string; department: string; req_count: number; course_count: number }[]>([]);
  const [programSearch, setProgramSearch] = useState("");
  // selectedPrograms declared above before chatTransport
  interface SchemaSection {
    name: string; description?: string;
    type: "all" | "choose_one" | "choose_n" | "credit_min" | "reference_only" | "info_only";
    n?: number; credits_required?: number; exclusive?: boolean;
    courses?: { code: string; title?: string; alternatives?: string[]; alt_titles?: string[] }[];
    pos_tags?: string[]; area_tags?: string[]; course_prefixes?: string[]; min_course_level?: number; match_all?: boolean; min_subsections_complete?: number; required_areas?: number; area_labels?: string[]; areas_covered?: string[]; placeholders?: string[];
    subsections?: SchemaSection[]; is_chooseable_group?: boolean;
    status?: "complete" | "in_progress" | "incomplete";
    fulfilled?: number; total?: number;
    matched_courses?: { code: string; title: string; term: string; credits: number; matched_by: string }[];
  }
  const programDetailsRef = useRef<Record<string, unknown>>({});
  const progFetchIds = useRef<Record<string, number>>({});
  const [programDetails, setProgramDetails] = useState<Record<string, { sections?: SchemaSection[]; url: string | null; overallStatus?: string; scheduledCount?: number; totalScheduledCredits?: number; hasSchema?: boolean; crossProgram?: { sharedCourses: string[]; excludedCourses: string[]; maxShared: number } }>>({});

  // Persist selectedPrograms
  useEffect(() => { localStorage.setItem("jhu_selectedPrograms", JSON.stringify(selectedPrograms)); }, [selectedPrograms]);

  // User overrides for requirements (hidden sections, manually completed sections, added courses)
  interface ReqOverrides {
    hiddenSections: string[];      // section keys to hide
    manualComplete: string[];      // section keys marked manually complete
    addedCourses: Record<string, string[]>; // section key → added course codes
  }
  const [reqOverrides, setReqOverrides] = useState<Record<string, ReqOverrides>>(() => {
    if (typeof window !== "undefined") {
      try { return JSON.parse(localStorage.getItem("jhu_reqOverrides") || "{}"); } catch { return {}; }
    }
    return {};
  });
  useEffect(() => { localStorage.setItem("jhu_reqOverrides", JSON.stringify(reqOverrides)); }, [reqOverrides]);

  const getOverrides = useCallback((program: string): ReqOverrides => {
    return reqOverrides[program] || { hiddenSections: [], manualComplete: [], addedCourses: {} };
  }, [reqOverrides]);

  const toggleSectionHidden = useCallback((program: string, sectionKey: string) => {
    setReqOverrides((prev) => {
      const o = prev[program] || { hiddenSections: [], manualComplete: [], addedCourses: {} };
      const hidden = o.hiddenSections.includes(sectionKey)
        ? o.hiddenSections.filter((k) => k !== sectionKey)
        : [...o.hiddenSections, sectionKey];
      return { ...prev, [program]: { ...o, hiddenSections: hidden } };
    });
  }, []);

  const toggleManualComplete = useCallback((program: string, sectionKey: string) => {
    setReqOverrides((prev) => {
      const o = prev[program] || { hiddenSections: [], manualComplete: [], addedCourses: {} };
      const mc = o.manualComplete.includes(sectionKey)
        ? o.manualComplete.filter((k) => k !== sectionKey)
        : [...o.manualComplete, sectionKey];
      return { ...prev, [program]: { ...o, manualComplete: mc } };
    });
  }, []);

  // Auto-load program details for persisted selections on mount
  useEffect(() => {
    if (selectedPrograms.length > 0 && Object.keys(programDetails).length === 0) {
      for (const name of selectedPrograms) loadProgramDetail(name);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which selected program is actively showing details
  const [activeProgram, setActiveProgram] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      try {
        const progs = JSON.parse(localStorage.getItem("jhu_selectedPrograms") || "[]");
        return progs.length > 0 ? progs[0] : null;
      } catch { return null; }
    }
    return null;
  });
  // Track collapsed state for requirement groups: key = "programName::groupName"
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Fetch program list — only programs with LLM-processed schemas
  const loadPrograms = useCallback(async () => {
    const res = await fetch("/api/programs/schema");
    if (res.ok) setPrograms(await res.json());
  }, []);

  // Fetch program details with progress
  const loadProgramDetail = useCallback(async (name: string, force = false) => {
    if (!force && programDetailsRef.current[name]) return;
    // Per-program fetch ID to prevent stale data without blocking other programs
    const id = (progFetchIds.current[name] || 0) + 1;
    progFetchIds.current[name] = id;
    try {
      const others = selectedPrograms.filter((p) => p !== name);
      const othersParam = others.length > 0 ? `&others=${others.map(encodeURIComponent).join("|")}` : "";
      const res = await fetch(`/api/programs/progress?name=${encodeURIComponent(name)}${othersParam}`);
      if (progFetchIds.current[name] !== id) return;
      if (res.ok) {
        const data = await res.json();
        setProgramDetails((prev) => {
          const next = { ...prev, [name]: data };
          programDetailsRef.current = next;
          return next;
        });
      } else {
        // Set error state so UI doesn't get stuck on "Loading..."
        console.error(`Failed to load ${name}: ${res.status}`);
        setProgramDetails((prev) => {
          const next = { ...prev, [name]: { sections: [], url: null, overallStatus: "incomplete", error: true } };
          programDetailsRef.current = next;
          return next;
        });
      }
    } catch (e) {
      console.error(`Error loading ${name}:`, e);
      setProgramDetails((prev) => {
        const next = { ...prev, [name]: { sections: [], url: null, overallStatus: "incomplete", error: true } };
        programDetailsRef.current = next;
        return next;
      });
    }
  }, [selectedPrograms]);

  // Reload progress when schedule changes
  useEffect(() => {
    for (const name of selectedPrograms) {
      loadProgramDetail(name, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  // Build valid course codes + ordered section list from tool outputs
  const { validCourses, courseSections } = useMemo(() => {
    const codes = new Set<string>();
    // Ordered list of {code, section} as they appear in tool output
    const sections: { code: string; section: string }[] = [];
    for (const msg of messages) {
      for (const part of msg.parts) {
        if ("output" in part && part.output) {
          try {
            const output = part.output as Record<string, unknown>;
            const courses = (output.courses || output.results) as Record<string, string>[] | undefined;
            if (Array.isArray(courses)) {
              for (const c of courses) {
                if (c.offering_name) {
                  codes.add(c.offering_name);
                  sections.push({ code: c.offering_name, section: c.section_name || "01" });
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
    }
    return { validCourses: codes, courseSections: sections };
  }, [messages]);

  // Cache fetched course data for preview hover
  const previewCache = useRef(new Map<string, ScheduledCourse | null>());
  const previewActiveKey = useRef<string | null>(null);
  const handlePreview = useCallback(async (code: string, section: string) => {
    const key = `${code}::${section}`;
    previewActiveKey.current = key;
    if (previewCache.current.has(key)) {
      setPreviewCourse(previewCache.current.get(key) || null);
      return;
    }
    try {
      const res = await fetch(`/api/course-detail?code=${encodeURIComponent(code)}&section=${encodeURIComponent(section)}&full=1&term=${encodeURIComponent(activeTerm)}`);
      if (!res.ok) { setPreviewCourse(null); return; }
      const data = await res.json();
      if (data?.offering_name) {
        previewCache.current.set(key, data);
        // Only set if this preview is still active (user hasn't moved away)
        if (previewActiveKey.current === key) {
          setPreviewCourse(data);
        }
      }
    } catch {
      if (previewActiveKey.current === key) setPreviewCourse(null);
    }
  }, [activeTerm]);
  const clearPreview = useCallback(() => {
    previewActiveKey.current = null;
    setPreviewCourse(null);
  }, []);
  interface ProfRatingResult {
    name: string;
    rating: {
      first_name: string;
      last_name: string;
      avg_rating: number;
      avg_difficulty: number;
      num_ratings: number;
      would_take_again_pct: number | null;
    } | null;
  }
  const [profRatings, setProfRatings] = useState<ProfRatingResult[] | "loading" | null>(null);
  interface CourseSection {
    section_name: string;
    meetings: string | null;
    instructors_full_name: string | null;
    status: string | null;
    open_seats: number | null;
    max_seats: number | null;
    waitlisted: number | null;
    location: string | null;
    building: string | null;
    instruction_method: string | null;
  }

  interface CourseDetail {
    description: string | null;
    prerequisites: string | null;
    corequisites: string | null;
    restrictions: string | null;
    overall_quality: number | null;
    instructor_effectiveness: number | null;
    intellectual_challenge: number | null;
    workload: number | null;
    feedback_usefulness: number | null;
    num_evaluations: number | null;
    num_respondents: number | null;
    pos_tags?: string[];
    areas?: string | null;
    sections?: CourseSection[];
  }
  const [courseDetail, setCourseDetail] = useState<CourseDetail | "loading" | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const scheduleFetchId = useRef(0);
  const fetchSchedule = useCallback(async () => {
    const id = ++scheduleFetchId.current;
    const res = await fetch(`/api/schedule?term=${encodeURIComponent(activeTerm)}&slot=${activeSlot}`);
    if (res.ok && scheduleFetchId.current === id) {
      // Only apply if this is still the latest fetch. This already guarded
      // term switches; it now also covers clicking through the schedules
      // faster than the responses come back.
      const data = await res.json();
      setSchedule(data.courses ?? []);
      setActivities(data.activities ?? []);
      setSlotCounts(data.counts ?? {});
      setScheduleLoaded(true);
    }
  }, [activeTerm, activeSlot]);

  // Search results and the open detail panel belong to the schedule they were
  // opened from, so drop them. The grid refetches on its own: fetchSchedule is
  // keyed to activeSlot.
  const selectSlot = useCallback((slot: number) => {
    setActiveSlot(slot);
    setSlotOpen(false);
    setSelected(null);
    setPreviewCourse(null);
    setExpandedSearchCourse(null);
    setActivityDraft(null);
    setDrag(null);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (status === "ready") fetchSchedule();
  }, [status, fetchSchedule]);

  // Clear schedule immediately on term switch, then fetch new data
  useEffect(() => {
    setSchedule([]);
    setScheduleLoaded(false);
    fetchSchedule();
  }, [fetchSchedule]);

  // Click outside to dismiss detail panel (but not when clicking another course block)
  useEffect(() => {
    if (!selected) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking on another course block — let its onClick handle the swap
        const target = e.target as HTMLElement;
        if (target.closest("[data-course-block]")) return;
        setSelected(null);
        setProfRatings(null);
        setCourseDetail(null);
      }
    }
    const id = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [selected]);

  // Fetch professor ratings and course detail when a course is selected.
  // Keep old data visible until new data is ready (no flash).
  const [panelReady, setPanelReady] = useState(false);
  const loadedOffering = useRef<string | null>(null);
  const [switchingSection, setSwitchingSection] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) {
      setProfRatings(null);
      setCourseDetail(null);
      setPanelReady(false);
      loadedOffering.current = null;
      return;
    }

    let cancelled = false;
    // Switching to another section of the same course keeps the panel up:
    // tearing it down and rebuilding it makes the card jump out from under
    // the click that asked for the switch. A different course still blanks it,
    // because then everything on screen is about to be wrong.
    if (loadedOffering.current !== selected.offering_name) {
      setPanelReady(false);
      loadedOffering.current = selected.offering_name;
    }

    const profPromise: Promise<ProfRatingResult[]> = (() => {
      const name = selected.instructors_full_name;
      if (!name || name === "Staff") return Promise.resolve([]);
      return fetch(`/api/professor?name=${encodeURIComponent(name)}`)
        .then((r) => r.json())
        .catch(() => []);
    })();

    const detailPromise: Promise<CourseDetail | null> = fetch(
      `/api/course-detail?code=${encodeURIComponent(selected.offering_name)}&term=${encodeURIComponent(activeTerm)}`
    )
      .then((r) => r.json())
      .then((data: CourseDetail | null) => data || null)
      .catch(() => null);

    Promise.all([profPromise, detailPromise]).then(([prof, detail]) => {
      if (cancelled) return;
      setProfRatings(prof);
      setCourseDetail(detail);
      setPanelReady(true);
    });

    return () => { cancelled = true; };
  }, [selected, activeTerm]);

  const isActive = status === "submitted" || status === "streaming";

  const isLoading = isActive;

  // Stable color assignment: hash the course key so colors don't shift on removal
  const colorOf = useCallback(
    (c: ScheduledCourse) => {
      const key = `${c.offering_name}::${c.section_name}`;
      let hash = 0;
      for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
      return PALETTE[Math.abs(hash) % PALETTE.length];
    },
    []
  );

  const removeCourse = useCallback(
    async (c: ScheduledCourse) => {
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
      setSelected((prev) =>
        prev?.offering_name === c.offering_name && prev?.section_name === c.section_name ? null : prev
      );
    },
    [activeTerm, activeSlot, fetchSchedule]
  );

  /**
   * Move the schedule from one section of a course to another.
   *
   * Adds before removing: the two rows differ by section so they can coexist
   * for a moment, and if the add fails the user still has the section they
   * started with. The other order would drop them out of the course entirely
   * whenever the second call failed.
   */
  const switchSection = useCallback(
    async (sec: CourseSection) => {
      if (!selected || sec.section_name === selected.section_name) return;
      setSwitchingSection(sec.section_name);
      try {
        const add = await fetch("/api/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offering_name: selected.offering_name,
            section_name: sec.section_name,
            term: activeTerm,
            slot: activeSlot,
          }),
        }).then((r) => r.json());

        if (!add?.success) return;

        await fetch("/api/schedule", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offering_name: selected.offering_name,
            section_name: selected.section_name,
            term: activeTerm,
            slot: activeSlot,
          }),
        });

        setSelected({
          ...selected,
          section_name: sec.section_name,
          meetings: sec.meetings ?? "",
          instructors_full_name: sec.instructors_full_name ?? "",
          location: sec.location ?? "",
          building: sec.building ?? "",
          instruction_method: sec.instruction_method ?? "",
        });
        fetchSchedule();
      } finally {
        setSwitchingSection(null);
      }
    },
    [selected, activeTerm, activeSlot, fetchSchedule]
  );

  // Department-based color for search results
  const deptColor = useCallback((dept: string | undefined) => {
    if (!dept) return PALETTE[0];
    let hash = 0;
    for (let i = 0; i < dept.length; i++) hash = ((hash << 5) - hash + dept.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }, []);

  const totalCredits = schedule.reduce((sum, c) => {
    const n = parseFloat(c.credits);
    return sum + (isNaN(n) ? 0 : n);
  }, 0);

  // Build positioned blocks for the grid
  const blocks: {
    course: ScheduledCourse;
    dayIdx: number;
    top: number;
    height: number;
    isPreview?: boolean;
    /** Set when this block is a custom time block rather than a course. */
    activity?: Activity;
  }[] = [];
  const addBlocks = (course: ScheduledCourse, isPreview = false) => {
    const mbs = parseMeetings(course.meetings);
    mbs.forEach((mb) => {
      mb.days.forEach((dayIdx) => {
        if (dayIdx > 4) return;
        blocks.push({
          course,
          dayIdx,
          top: (mb.startHour - 8) * ROW_H + (mb.startMin / 60) * ROW_H,
          height: (mb.endHour - mb.startHour) * ROW_H + ((mb.endMin - mb.startMin) / 60) * ROW_H,
          isPreview,
        });
      });
    });
  };
  schedule.forEach((c) => addBlocks(c));

  // An activity rides through the calendar as an ordinary scheduled entry:
  // given a SIS-shaped meetings string it reuses the same parser, column
  // layout and crowded-slot handling as a course, and only the rendering
  // branch below has to know the difference.
  activities.forEach((a) => {
    const asCourse: ScheduledCourse = {
      offering_name: a.name,
      section_name: `activity-${a.id}`,
      title: "",
      credits: "0",
      meetings: activityMeetings(a),
      location: "",
      building: "",
      instructors_full_name: "",
      instruction_method: "",
      department: "",
    };
    const before = blocks.length;
    addBlocks(asCourse);
    for (let i = before; i < blocks.length; i++) blocks[i].activity = a;
  });

  if (previewCourse) addBlocks(previewCourse, true);

  // --- Drag on empty grid to carve out a new time block ---

  const DAY_CODES = ["M", "T", "W", "Th", "F"];

  /** Where in the week a pointer is, or null when it is over the hour gutter. */
  const pointToSlot = (clientX: number, clientY: number) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    if (x < 52) return null;
    const colW = (rect.width - 52) / 5;
    const dayIdx = Math.min(4, Math.max(0, Math.floor((x - 52) / colW)));
    const y = Math.min(HOURS.length * ROW_H, Math.max(0, clientY - rect.top));
    return { dayIdx, min: GRID_START_MIN + (y / ROW_H) * 60 };
  };

  const startDrag = (e: React.MouseEvent) => {
    // Left button only, and never when the press lands on something that
    // already owns the click: a course block, the "+N more" tile, the editor.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-course-block],[data-grid-overlay]")) return;
    const at = pointToSlot(e.clientX, e.clientY);
    if (!at) return;
    setActivityDraft(null);
    setDrag({ dayIdx: at.dayIdx, fromMin: at.min, toMin: at.min });
  };

  useEffect(() => {
    if (!drag) return;

    const move = (e: MouseEvent) => {
      const at = pointToSlot(e.clientX, e.clientY);
      if (!at) return;
      // The day is fixed at mousedown: dragging sideways changes the time, not
      // which column the block lands in.
      setDrag((d) => (d ? { ...d, toMin: at.min } : d));
    };

    const up = () => {
      setDrag((d) => {
        if (d) {
          const lo = snap(Math.min(d.fromMin, d.toMin));
          const hi = snap(Math.max(d.fromMin, d.toMin));
          // Ignore a stray click: only a real sweep creates a block.
          if (hi - lo >= MIN_DURATION_MIN) {
            const start = Math.max(GRID_START_MIN, lo);
            const end = Math.min(GRID_END_MIN, Math.max(start + MIN_DURATION_MIN, hi));
            setActivityDraft({
              name: "",
              days: DAY_CODES[d.dayIdx],
              start_min: start,
              end_min: end,
              dayIdx: d.dayIdx,
              top: ((start - GRID_START_MIN) / 60) * ROW_H,
            });
          }
        }
        return null;
      });
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // pointToSlot reads a ref, so it needs no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const saveActivity = useCallback(
    async (value: ActivityDraftState) => {
      setSavingActivity(true);
      try {
        const res = await fetch("/api/activities", {
          method: value.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...value, term: activeTerm, slot: activeSlot }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setActivityError(data?.message || "Could not save that block.");
          return;
        }
        setActivityError(null);
        setActivityDraft(null);
        fetchSchedule();
      } finally {
        setSavingActivity(false);
      }
    },
    [activeTerm, activeSlot, fetchSchedule]
  );

  const deleteActivity = useCallback(
    async (id: number) => {
      setSavingActivity(true);
      try {
        await fetch("/api/activities", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        setActivityDraft(null);
        setActivityError(null);
        fetchSchedule();
      } finally {
        setSavingActivity(false);
      }
    },
    [fetchSchedule]
  );

  const blockKey = (b: { course: ScheduledCourse; isPreview?: boolean }) =>
    `${b.isPreview ? "~" : ""}${b.course.offering_name}::${b.course.section_name}`;
  const { placed: placedBlocks, overflow: crowdedSlots } = layoutWeek(blocks, blockKey);

  if (isMobile) {
    return (
      <MobileLayout
        activeTerm={activeTerm}
        activeSlot={activeSlot}
        slotCounts={slotCounts}
        selectSlot={selectSlot}
        schedule={schedule}
        scheduleLoaded={scheduleLoaded}
        totalCredits={totalCredits}
        fetchSchedule={fetchSchedule}
        selected={selected}
        setSelected={setSelected}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchResults={searchResults}
        searchLoading={searchLoading}
        messages={messages}
        sendMessage={sendMessage}
        setMessages={setMessages}
        input={input}
        setInput={setInput}
        isLoading={isLoading}
        validCourses={validCourses}
        courseSections={courseSections}
        handlePreview={handlePreview}
        clearPreview={clearPreview}
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* ---- LEFT: Schedule ---- */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-slate-200 bg-white/80 backdrop-blur-sm shrink-0 relative z-[100]">
          {/* Title + Term + Schedule picker */}
          <div className="flex items-center gap-2 shrink-0">
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight">JHU Planner</h1>
            <span className="text-[11px] font-medium text-slate-500">{activeTerm}</span>
            <div className="relative" ref={slotRef}>
              {/* Given a chip rather than the term's plain text so it reads as
                  something you can click, next to something you cannot. */}
              <button
                type="button"
                onClick={() => setSlotOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={slotOpen}
                aria-label={`${scheduleSlotLabel(activeSlot)}. Switch schedule`}
                className="flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                {scheduleSlotLabel(activeSlot)}
                <svg className={`w-3 h-3 text-slate-400 transition-transform ${slotOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
              {slotOpen && (
                <div role="listbox" aria-label="Schedules" className="absolute left-0 top-full mt-1 w-48 rounded-md border border-slate-200 bg-white shadow-lg py-1 z-[200]">
                  {SCHEDULE_SLOTS.map((slotNo) => {
                    const n = slotCounts[slotNo] ?? 0;
                    return (
                      <button
                        key={slotNo}
                        type="button"
                        role="option"
                        aria-selected={slotNo === activeSlot}
                        onClick={() => selectSlot(slotNo)}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-slate-50 transition-colors ${slotNo === activeSlot ? "font-semibold text-blue-600" : "text-slate-600"}`}
                      >
                        <span className="truncate">{scheduleSlotLabel(slotNo)}</span>
                        <span className="shrink-0 text-[10px] text-slate-400">
                          {n === 0 ? "empty" : `${n} course${n === 1 ? "" : "s"}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Search bar */}
          <div className="relative flex-1 max-w-xs" ref={searchRef}>
              <div className="relative">
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                  onFocus={() => { if (searchQuery.length >= 2) setSearchOpen(true); }}
                  placeholder="Add course by code or name..."
                  className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md border border-slate-200 bg-slate-50/50 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-200 focus:border-blue-300 focus:bg-white transition-colors"
                />
                {searchLoading && <div className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-slate-200 border-t-blue-400 rounded-full animate-spin" />}
              </div>
              {searchOpen && searchResults.length > 0 && (() => {
                // Group results by offering_name
                const grouped = new Map<string, typeof searchResults>();
                for (const r of searchResults) {
                  if (!grouped.has(r.offering_name)) grouped.set(r.offering_name, []);
                  grouped.get(r.offering_name)!.push(r);
                }
                return (
                <div
                  // The dropdown hangs directly over the MON-WED columns of the
                  // grid, so a hovered morning section previews underneath it and
                  // looks like nothing happened. Fade it while a preview is up —
                  // the cursor is already on the row, and the point of the hover
                  // is to see the fit, not to read the list.
                  className={`absolute top-full left-0 right-0 mt-1 z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 max-h-[400px] overflow-auto transition-opacity duration-150 ${previewCourse ? "opacity-25" : "opacity-100"}`}
                >
                  {[...grouped.entries()].map(([code, sections]) => {
                    const first = sections[0];
                    const isCatalogue = !!(first as { source?: string }).source;
                    const courseInSchedule = schedule.some((s) => s.offering_name === code);
                    const dc = deptColor(first.department);
                    const isExpanded = expandedSearchCourse === code;
                    const visibleSections = isExpanded ? expandedSections : sections;
                    const canExpand = !isCatalogue;

                    const addSection = async (r: typeof first) => {
                      const sectionName = r.section_name;
                      await fetch("/api/schedule", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ offering_name: r.offering_name, section_name: sectionName, term: activeTerm, slot: activeSlot }),
                      });
                      fetchSchedule();
                      clearPreview();
                      setSearchQuery("");
                      setSearchOpen(false);
                      setExpandedSearchCourse(null);
                      setExpandedSections([]);
                    };

                    const expandCourse = async () => {
                      if (isExpanded) { setExpandedSearchCourse(null); setExpandedSections([]); return; }
                      setExpandedSearchCourse(code);
                      setExpandedLoading(true);
                      try {
                        const res = await fetch(`/api/course-search?q=${encodeURIComponent(code)}&term=${encodeURIComponent(activeTerm)}&mode=term`);
                        if (res.ok) {
                          const all = (await res.json()) as typeof searchResults;
                          const forCode = all.filter((r) => r.offering_name === code);
                          setExpandedSections(forCode.length > 0 ? forCode : sections);
                        } else {
                          setExpandedSections(sections);
                        }
                      } catch { setExpandedSections(sections); }
                      setExpandedLoading(false);
                    };

                    return (
                      <div key={code}>
                        <button
                          onClick={() => {
                            if (courseInSchedule && !canExpand) return;
                            if (canExpand) {
                              expandCourse();
                            } else {
                              addSection(first);
                            }
                          }}
                          className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${courseInSchedule && !canExpand ? "opacity-40 cursor-default" : "hover:bg-slate-50 cursor-pointer"}`}
                        >
                          <div className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: dc.border }} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-mono font-semibold" style={{ color: dc.text }}>{code}</span>
                              {first.credits && <span className="text-[9px] text-slate-300">{first.credits}cr</span>}
                            </div>
                            <div className="text-[11px] text-slate-700 truncate">{first.title}</div>
                            {(!canExpand || isCatalogue) && (
                              <div className="text-[9px] text-slate-400 truncate">
                                {isCatalogue ? (first.department || "Catalogue") : `${first.meetings || "TBA"} · ${first.instructors_full_name || "Staff"}`}
                              </div>
                            )}
                            {canExpand && !isExpanded && (
                              <div className="text-[9px] text-slate-400">Click to choose section</div>
                            )}
                            {first.pos_tags && (
                              <div className="flex gap-1 mt-0.5 flex-wrap">
                                {first.pos_tags.split(",").slice(0, 4).map((tag) => (
                                  <span key={tag} className="text-[7px] font-mono font-semibold text-blue-500 bg-blue-50 rounded px-1">{tag}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          {courseInSchedule && <span className="text-[8px] text-emerald-500 font-semibold shrink-0 mt-1">ADDED</span>}
                          {canExpand && !courseInSchedule && (
                            <svg className={`w-3.5 h-3.5 text-slate-400 shrink-0 mt-1 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                          )}
                        </button>
                        {/* Section picker */}
                        {isExpanded && (
                          <div className="bg-slate-50/80 border-t border-slate-100">
                            {expandedLoading ? (
                              <div className="px-7 py-2 text-[10px] text-slate-400">Loading sections...</div>
                            ) : visibleSections.map((r, si) => {
                              const secInSchedule = schedule.some((sc) => sc.offering_name === r.offering_name && sc.section_name === r.section_name);
                              return (
                                <button
                                  key={si}
                                  onClick={() => { if (!secInSchedule) addSection(r); }}
                                  onMouseEnter={() => { if (r.section_name) handlePreview(r.offering_name, r.section_name); }}
                                  onMouseLeave={clearPreview}
                                  className={`w-full text-left pl-7 pr-3 py-1.5 flex items-center gap-2 text-[10px] transition-colors ${secInSchedule ? "opacity-40 cursor-default" : "hover:bg-blue-50 cursor-pointer"}`}
                                >
                                  <span className="font-mono font-semibold text-slate-500 w-[36px] shrink-0">§{r.section_name}</span>
                                  <span className="text-slate-500 truncate flex-1">{r.meetings || "TBA"}</span>
                                  <span className="text-slate-400 truncate max-w-[120px]">{r.instructors_full_name || "Staff"}</span>
                                  {secInSchedule && <span className="text-[8px] text-emerald-500 font-semibold shrink-0">ADDED</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                );
              })()}
              {searchOpen && searchQuery.length >= 2 && searchResults.length === 0 && !searchLoading && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-3 px-3 text-center text-[11px] text-slate-400">
                  No courses found for &ldquo;{searchQuery}&rdquo;
                </div>
              )}
            </div>

          {/* Credits summary */}
          <div className="flex items-center gap-2 text-[11px] text-slate-400 shrink-0 ml-auto">
            {schedule.length > 0 && (
              <Fragment>
                <span><span className="font-semibold text-slate-600">{schedule.length}</span> course{schedule.length !== 1 && "s"}</span>
                <span className="w-px h-3 bg-slate-200" />
                <span><span className="font-semibold text-slate-600">{totalCredits}</span> cr</span>
              </Fragment>
            )}
          </div>
        </div>

        {/* Requirements panel — removed, preserved in full-features branch */}
        {false && (
          <div className="flex-1 flex min-h-0">
            {/* Left: Program search */}
            <div className="w-[280px] shrink-0 border-r border-slate-200 flex flex-col bg-slate-50/30">
              <div className="px-3 py-2.5 border-b border-slate-200">
                <div className="relative">
                  <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input
                    type="text"
                    value={programSearch}
                    onChange={(e) => setProgramSearch(e.target.value)}
                    placeholder="Search majors & minors..."
                    className="w-full text-[11px] pl-7 pr-2 py-1.5 rounded-md border border-slate-200 bg-white placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-200 focus:border-violet-300"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {(programSearch.length > 0
                  ? programs.filter((p) => p.program_name.toLowerCase().includes(programSearch.toLowerCase()))
                  : programs
                ).map((p) => {
                  const isSelected = selectedPrograms.includes(p.program_name);
                  return (
                    <button
                      key={p.program_name}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedPrograms((s) => s.filter((n) => n !== p.program_name));
                        } else {
                          setSelectedPrograms((s) => [...s, p.program_name]);
                          setActiveProgram(p.program_name);
                          loadProgramDetail(p.program_name);
                        }
                      }}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-[11px] border-b border-slate-100 transition-colors ${isSelected ? "bg-violet-50 text-violet-700 font-medium" : "text-slate-600 hover:bg-white"}`}
                    >
                      <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${isSelected ? "bg-violet-500 border-violet-500 text-white" : "border-slate-300"}`}>
                        {isSelected && <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className="flex-1 truncate">{p.program_name}</span>
                      <span className="text-[9px] text-slate-300 shrink-0">{p.course_count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right: Selected programs chips + active detail */}
            <div className="flex-1 flex flex-col bg-white min-w-0">
              {/* Program chips bar */}
              {selectedPrograms.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 py-2.5 border-b border-slate-200 bg-slate-50/30">
                  {selectedPrograms.map((pname) => {
                    const isActive = activeProgram === pname;
                    const detail = programDetails[pname];
                    const os = detail?.overallStatus;
                    const statusDot = os === "complete" ? "bg-emerald-400" : os === "in_progress" ? "bg-amber-400" : "bg-slate-300";
                    return (
                      <button
                        key={pname}
                        onClick={() => setActiveProgram(isActive ? null : pname)}
                        className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md border transition-colors ${isActive ? "bg-violet-100 text-violet-700 border-violet-300" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${statusDot} shrink-0`} />
                        <span className="truncate max-w-[180px]">{pname}</span>
                        <span
                          onClick={(e) => { e.stopPropagation(); setSelectedPrograms((p) => p.filter((n) => n !== pname)); setProgramDetails((d) => { const next = { ...d }; delete next[pname]; return next; }); if (activeProgram === pname) setActiveProgram(null); }}
                          className="text-slate-400 hover:text-red-500 ml-0.5"
                        >
                          ×
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Detail view for active program */}
              <div className="flex-1 overflow-auto">
                {selectedPrograms.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center space-y-2 max-w-xs px-4">
                      <div className="mx-auto w-10 h-10 rounded-lg bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-300 text-lg">+</div>
                      <p className="text-xs font-medium text-slate-500">Select a program</p>
                      <p className="text-[11px] text-slate-400">Choose your major, minor, or certificate from the list.</p>
                    </div>
                  </div>
                ) : !activeProgram ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-[11px] text-slate-400">Click a program above to view its requirements.</p>
                  </div>
                ) : (() => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const detail = programDetails[activeProgram!] as any;
                  if (!detail) return <div className="px-4 py-6 text-[11px] text-slate-400 text-center">Loading requirements...</div>;

                  // Short term label: "Fall 2024" → "F24", "Spring 2025" → "S25", "AP/Transfer" → "AP"
                  const shortTerm = (term: string) => {
                    if (!term) return "";
                    if (term === "AP/Transfer") return "AP";
                    const m = term.match(/^(Fall|Spring|Summer)\s+(\d{4})$/);
                    if (!m) return term;
                    return (m[1] === "Fall" ? "F" : m[1] === "Spring" ? "S" : "Su") + m[2].slice(2);
                  };

                  const typeLabel = (s: SchemaSection) => {
                    if (s.is_chooseable_group) return "Choose 1 track";
                    if (s.type === "all") return "All required";
                    if (s.type === "choose_one") return "Pick 1";
                    if (s.type === "choose_n") return `Pick ${s.n}`;
                    if (s.type === "credit_min" && s.credits_required) return `${s.credits_required}cr min`;
                    if (s.type === "credit_min") return "Credits";
                    return "";
                  };

                  const overrides = activeProgram ? getOverrides(activeProgram!) : { hiddenSections: [], manualComplete: [], addedCourses: {} };

                  const renderSection = (s: SchemaSection, depth: number, parentKey: string) => {
                    const key = `${parentKey}::${s.name}`;
                    const isHidden = overrides.hiddenSections.includes(key);
                    const isManualComplete = overrides.manualComplete.includes(key);
                    const isCollapsed = !collapsedGroups.has(key);

                    const st = isManualComplete ? "complete" : s.status;
                    const dot = st === "complete" ? "bg-emerald-400" : st === "in_progress" ? "bg-amber-400" : "bg-slate-300";
                    // Don't show matched courses on sections that have subsections — let children display them
                    const hasChildren = (s.subsections && s.subsections.length > 0) || s.is_chooseable_group;
                    const matched = hasChildren ? [] : (s.matched_courses || []);
                    const matchedCodes = new Set(matched.map((m) => m.code));

                    let prog = "";
                    if (s.type === "credit_min" && s.credits_required) {
                      // Use fulfilled from API — it already includes child credits
                      prog = `${s.fulfilled ?? 0}/${s.credits_required}cr`;
                    } else if (s.fulfilled !== undefined && s.total !== undefined && s.total > 0) {
                      prog = `${s.fulfilled}/${s.total}`;
                    }

                    if (s.type === "reference_only" || s.type === "info_only") return null;
                    if (isHidden) {
                      return (
                        <div key={key} className={`${depth > 0 ? "ml-4" : ""} opacity-40`}>
                          <div className={`flex items-center gap-1.5 ${depth === 0 ? "px-4 py-1" : "px-3 py-0.5"}`}>
                            <span className="text-[10px] text-slate-400 line-through flex-1">{s.name}</span>
                            <button onClick={() => toggleSectionHidden(activeProgram!, key)} className="text-[9px] text-blue-400 hover:text-blue-600">Show</button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={key} className={depth > 0 ? "ml-4 border-l border-slate-100" : ""}>
                        <div className={`flex items-center gap-1.5 transition-colors group/hdr ${depth === 0 ? "px-4 py-2 hover:bg-slate-50" : "px-3 py-1.5 hover:bg-slate-50/50"}`}>
                          <button onClick={() => toggleGroup(key)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                            <svg className={`w-3 h-3 text-slate-400 shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                            <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
                            <span className={`flex-1 truncate ${depth === 0 ? "text-[11px] font-semibold text-slate-700" : "text-[10px] font-medium text-slate-500"} ${isManualComplete ? "line-through opacity-60" : ""}`}>{s.name}</span>
                          </button>
                          <span className="text-[8px] text-slate-300 shrink-0">{typeLabel(s)}</span>
                          {prog && <span className={`text-[9px] font-medium shrink-0 ml-1 ${st === "complete" ? "text-emerald-500" : st === "in_progress" ? "text-amber-500" : "text-slate-300"}`}>{prog}</span>}
                          {s.required_areas && s.area_labels && (
                            <span className={`text-[9px] font-medium shrink-0 ml-1 ${(s.areas_covered?.length || 0) >= s.required_areas ? "text-emerald-500" : "text-amber-500"}`}>
                              {s.areas_covered?.length || 0}/{s.required_areas} areas
                            </span>
                          )}
                          {isManualComplete && <span className="text-[8px] text-emerald-500 shrink-0">manual</span>}
                          {/* Edit controls — visible on hover */}
                          <div className="flex items-center gap-1 opacity-0 group-hover/hdr:opacity-100 transition-opacity shrink-0">
                            <button
                              onClick={() => toggleManualComplete(activeProgram!, key)}
                              title={isManualComplete ? "Unmark complete" : "Mark as complete"}
                              className={`text-[9px] px-1 py-0.5 rounded ${isManualComplete ? "text-amber-500 hover:text-amber-600" : "text-emerald-400 hover:text-emerald-600"}`}
                            >
                              {isManualComplete ? "↩" : "✓"}
                            </button>
                            <button
                              onClick={() => toggleSectionHidden(activeProgram!, key)}
                              title="Hide this section"
                              className="text-[9px] text-slate-300 hover:text-red-400 px-1 py-0.5 rounded"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        {!isCollapsed && (
                          <div className={depth === 0 ? "px-4 pb-2" : "px-3 pb-1"}>
                            {s.description && <div className="text-[9px] text-slate-400 mb-1.5">{s.description}</div>}

                            {/* Area coverage badges */}
                            {s.area_labels && s.area_labels.length > 0 && (
                              <div className="flex flex-wrap gap-1 mb-2">
                                {s.area_labels.map((area) => {
                                  const covered = s.areas_covered?.includes(area);
                                  return (
                                    <span key={area} className={`text-[8px] font-mono px-1.5 py-0.5 rounded border ${covered ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-50 text-slate-400 border-slate-200"}`}>
                                      {covered ? "✓ " : ""}{area}
                                    </span>
                                  );
                                })}
                              </div>
                            )}

                            {/* Courses */}
                            {s.courses && s.courses.length > 0 && (
                              <div className="space-y-0.5 mb-1">
                                {s.courses.map((ref, ri) => {
                                  const allCodes = [ref.code, ...(ref.alternatives || [])];
                                  const done = allCodes.some((c) => matchedCodes.has(c));
                                  const matchedCode = allCodes.find((c) => matchedCodes.has(c));
                                  const matchInfo = matchedCode ? matched.find((m) => m.code === matchedCode) : null;
                                  return (
                                    <div key={ri}>
                                      <div className="flex items-center gap-1.5 text-[11px] py-0.5">
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${done ? "bg-emerald-400" : "bg-slate-300"}`} />
                                        <span className={`font-mono text-[10px] shrink-0 ${done ? "text-emerald-600" : "text-violet-600"}`}>{ref.code}</span>
                                        <span className={`truncate ${done ? "text-emerald-600" : "text-slate-500"}`}>{ref.title || ""}</span>
                                        {done && matchInfo && <span className="text-[8px] text-emerald-400 bg-emerald-50 rounded px-1 shrink-0">{shortTerm(matchInfo.term)}</span>}
                                      </div>
                                      {ref.alternatives && ref.alternatives.length > 0 && (
                                        <div className="ml-5 space-y-0.5">
                                          {ref.alternatives.map((alt, ai) => {
                                            const altDone = matchedCodes.has(alt);
                                            const altTitle = ref.alt_titles?.[ai] || "";
                                            return (
                                              <div key={ai} className="flex items-center gap-1.5 text-[10px] py-0.5">
                                                <span className={`text-[9px] ${altDone ? "text-emerald-400" : "text-orange-400"}`}>{altDone ? "✓" : "or"}</span>
                                                <span className={`font-mono text-[10px] shrink-0 ${altDone ? "text-emerald-600" : "text-slate-400"}`}>{alt}</span>
                                                <span className={`truncate ${altDone ? "text-emerald-500" : "text-slate-400"}`}>{altTitle}</span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* POS tags — skip if area_labels already covers the same tags */}
                            {s.pos_tags && s.pos_tags.length > 0 && !(s.area_labels && s.area_labels.length > 0) && (
                              <div className="space-y-0.5 mb-1">
                                {s.pos_tags.map((tag) => {
                                  const tagMatches = matched.filter((m) => m.matched_by.includes(tag));
                                  return (
                                    <div key={tag}>
                                      <div className="flex items-center gap-1.5 text-[10px] py-0.5">
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tagMatches.length > 0 ? "bg-emerald-400" : "bg-slate-300"}`} />
                                        <span className={`font-mono text-[9px] ${tagMatches.length > 0 ? "text-emerald-500" : "text-blue-500"}`}>{tag}</span>
                                      </div>
                                      {tagMatches.length > 0 && (
                                        <div className="ml-5 space-y-0.5">
                                          {tagMatches.map((m, mi) => (
                                            <div key={mi} className="flex items-center gap-1 text-[10px] text-emerald-600">
                                              <span className="text-emerald-400">↳</span>
                                              <span className="font-mono">{m.code}</span>
                                              <span className="truncate text-emerald-500">{m.title}</span>
                                              <span className="text-[8px] text-emerald-400 bg-emerald-50 rounded px-1 shrink-0">{shortTerm(m.term)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Area tags */}
                            {s.area_tags && s.area_tags.length > 0 && !s.courses?.length && (
                              <div className="mb-1">
                                <div className="flex gap-1 mb-1">
                                  {s.area_tags.map((a) => <span key={a} className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100">{a}</span>)}
                                </div>
                                {matched.length > 0 && (
                                  <div className="ml-2 space-y-0.5">
                                    {matched.map((m, mi) => (
                                      <div key={mi} className="flex items-center gap-1 text-[10px] text-emerald-600">
                                        <span className="text-emerald-400">↳</span>
                                        <span className="font-mono">{m.code}</span>
                                        <span className="truncate text-emerald-500">{m.title}</span>
                                        <span className="text-[8px] text-emerald-400 shrink-0">{m.credits}cr</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Matched courses for sections that don't have their own display (no courses, no POS tags, no area tags) */}
                            {matched.length > 0 && !s.courses?.length && !s.pos_tags?.length && !s.area_tags?.length && (
                              <div className="space-y-0.5 mb-1">
                                {matched.map((m, mi) => (
                                  <div key={mi} className="flex items-center gap-1.5 text-[10px] text-emerald-600 py-0.5 group/mc">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                                    <span className="font-mono">{m.code}</span>
                                    <span className="truncate text-emerald-500">{m.title}</span>
                                    <span className="text-[8px] text-emerald-400 shrink-0">{m.credits}cr</span>
                                    <span className="text-[8px] text-emerald-400 bg-emerald-50 rounded px-1 shrink-0">{shortTerm(m.term)}</span>
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        await fetch("/api/schedule", {
                                          method: "DELETE",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ offering_name: m.code, term: m.term || activeTerm, slot: activeSlot }),
                                        });
                                        fetchSchedule();
                                      }}
                                      className="text-[9px] text-red-300 hover:text-red-500 opacity-0 group-hover/mc:opacity-100 shrink-0"
                                      title={`Remove ${m.code} from ${m.term}`}
                                    >✕</button>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Placeholders */}
                            {s.placeholders && s.placeholders.map((p, pi) => (
                              <div key={pi} className="text-[10px] text-slate-500 italic py-0.5">{p}</div>
                            ))}

                            {/* Subsections */}
                            {s.subsections && s.subsections.map((sub, si) => (
                              <Fragment key={si}>{renderSection(sub, depth + 1, key)}</Fragment>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  };

                  return (
                    <Fragment>
                      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100">
                        <span className="text-[11px] font-semibold text-slate-700 flex-1">{activeProgram}</span>
                        {detail.totalScheduledCredits !== undefined && <span className="text-[9px] text-slate-400">{detail.totalScheduledCredits}cr scheduled</span>}
                        {detail.crossProgram && detail.crossProgram.excludedCourses.length > 0 && (
                          <span className="text-[9px] text-amber-500" title={`Shared: ${detail.crossProgram.sharedCourses.join(", ")}. Excluded: ${detail.crossProgram.excludedCourses.join(", ")}`}>
                            {detail.crossProgram.sharedCourses.length}/{detail.crossProgram.maxShared} shared
                          </span>
                        )}
                        {detail.url && <a href={detail.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 hover:text-blue-600">e-catalogue ↗</a>}
                      </div>
                      <div className="py-1">{((detail.sections || []) as SchemaSection[]).map((s: SchemaSection, i: number) => <Fragment key={i}>{renderSection(s, 0, activeProgram!)}</Fragment>)}</div>
                    </Fragment>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Grid area */}
        <div className="flex-1 overflow-auto relative">
          {schedule.length === 0 && !previewCourse ? (
            // Keep the grid up while a section is being previewed: on an empty
            // schedule the placeholder would otherwise replace the very thing
            // the hover is meant to draw on, so the first course you look at
            // appears to preview nothing at all.
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2 max-w-xs">
                <div className="mx-auto w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-xl">
                  +
                </div>
                <p className="text-sm font-medium text-slate-500">
                  Your schedule is empty
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Search for courses in the chat panel and ask to add them to
                  your schedule.
                </p>
              </div>
            </div>
          ) : (
            <div className="min-w-[640px] p-4">
              {/* Day headers */}
              <div
                className="grid sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm"
                style={{
                  gridTemplateColumns: "52px repeat(5, 1fr)",
                }}
              >
                <div />
                {DAYS_SHORT.map((d) => (
                  <div
                    key={d}
                    className="text-center text-[11px] font-semibold text-slate-400 uppercase tracking-wider py-2"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Grid body */}
              <div
                ref={gridRef}
                onMouseDown={startDrag}
                className="relative grid mt-1.5 select-none"
                style={{
                  gridTemplateColumns: "52px repeat(5, 1fr)",
                }}
              >
                {/* Hour rows */}
                {HOURS.map((h) => (
                  <div key={h} className="contents">
                    <div
                      className="text-[10px] text-slate-400 text-right pr-2 -translate-y-1.5 select-none"
                      style={{ height: ROW_H }}
                    >
                      {h > 12 ? h - 12 : h} {h >= 12 ? "pm" : "am"}
                    </div>
                    {DAYS_SHORT.map((_, di) => (
                      <div
                        key={di}
                        className="border-t border-slate-100"
                        style={{ height: ROW_H }}
                      />
                    ))}
                  </div>
                ))}

                {/* Course blocks */}
                {placedBlocks.map(({ block, lane: idx, lanes: total }) => {
                  const pal = colorOf(block.course);

                  if (block.isPreview) {
                    return (
                      <div
                        key={`preview-${block.dayIdx}-${block.top}`}
                        className="absolute rounded-lg overflow-hidden pointer-events-none"
                        style={{
                          top: block.top,
                          height: block.height,
                          left: `calc(52px + ${block.dayIdx} * ((100% - 52px) / 5) + 3px + ${idx} * ((100% - 52px) / 5 - 6px) / ${total})`,
                          width: `calc(((100% - 52px) / 5 - 6px) / ${total})`,
                          background: "rgba(16, 185, 129, 0.12)",
                          border: "2px dashed rgba(16, 185, 129, 0.5)",
                          zIndex: 15,
                        }}
                      >
                        <div className="px-2 py-1.5">
                          <span className="text-[10px] font-bold text-emerald-700 leading-none truncate block">
                            {block.course.offering_name}
                          </span>
                          <span className="text-[10px] text-emerald-600 leading-snug truncate block mt-0.5 opacity-80">
                            {block.course.title}
                          </span>
                        </div>
                      </div>
                    );
                  }

                  if (block.activity) {
                    const a = block.activity;
                    const open = activityDraft?.id === a.id;
                    return (
                      <div
                        key={`activity-${a.id}-${block.dayIdx}`}
                        data-course-block
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setActivityError(null);
                          setActivityDraft({
                            id: a.id,
                            name: a.name,
                            days: a.days,
                            start_min: a.start_min,
                            end_min: a.end_min,
                            dayIdx: block.dayIdx,
                            top: block.top,
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).click();
                          }
                        }}
                        className={`absolute rounded-lg overflow-hidden cursor-pointer transition-shadow hover:shadow-md ${
                          open ? "ring-2 ring-violet-400" : ""
                        }`}
                        style={{
                          top: block.top,
                          height: block.height,
                          left: `calc(52px + ${block.dayIdx} * ((100% - 52px) / 5) + 3px + ${idx} * ((100% - 52px) / 5 - 6px) / ${total})`,
                          width: `calc(((100% - 52px) / 5 - 6px) / ${total})`,
                          // Deliberately not from the course palette: an
                          // activity should never be mistaken for a class.
                          background:
                            "repeating-linear-gradient(135deg, #f5f3ff, #f5f3ff 6px, #ede9fe 6px, #ede9fe 12px)",
                          borderLeft: "3px solid #a78bfa",
                          color: "#4c1d95",
                        }}
                      >
                        <div className="px-2 py-1.5 h-full flex flex-col">
                          <span className="text-[10px] font-bold leading-none truncate">{a.name}</span>
                          <span className="text-[9px] leading-snug truncate mt-0.5 opacity-70">
                            {minutesToLabel(a.start_min)}
                          </span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={`${block.course.offering_name}-${block.course.section_name}-${block.dayIdx}-${block.top}`}
                      data-course-block
                      className="absolute rounded-lg overflow-hidden group cursor-pointer transition-shadow hover:shadow-md"
                      style={{
                        top: block.top,
                        height: block.height,
                        left: `calc(52px + ${block.dayIdx} * ((100% - 52px) / 5) + 3px + ${idx} * ((100% - 52px) / 5 - 6px) / ${total})`,
                        width: `calc(((100% - 52px) / 5 - 6px) / ${total})`,
                        background: pal.bg,
                        borderLeft: `3px solid ${pal.border}`,
                        color: pal.text,
                      }}
                      onClick={() => setSelected(block.course)}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCourse(block.course);
                        }}
                        className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-black/10 transition-all"
                        title="Remove"
                      >
                        &#10005;
                      </button>
                      <div className="px-2 py-1.5 h-full flex flex-col">
                        <span className="text-[10px] font-bold leading-none truncate">
                          {block.course.offering_name}
                        </span>
                        <span className="text-[10px] leading-snug truncate mt-0.5 opacity-80 group-hover:hidden">
                          {block.course.title}
                        </span>
                        <span className="text-[10px] leading-snug truncate mt-0.5 opacity-90 hidden group-hover:block font-medium">
                          Click for info
                        </span>
                      </div>
                    </div>
                  );
                })}

                {/* Crowded slots: past three columns a block is too narrow to
                    read, so the tail of the stack collapses into one tile. */}
                {crowdedSlots.map((slot) => {
                  const id = `${slot.dayIdx}-${slot.top}`;
                  const isOpen = openCrowded === id;
                  // Flip the panel when the tile sits low in the grid, or when
                  // it is on Thu/Fri, so it stays inside the visible area.
                  const dropUp = slot.top > (HOURS.length * ROW_H) / 2;
                  const alignRight = slot.dayIdx >= 3;
                  return (
                    <div
                      key={`crowded-${id}`}
                      ref={isOpen ? crowdedRef : undefined}
                      className="absolute"
                      style={{
                        top: slot.top,
                        height: slot.height,
                        left: `calc(52px + ${slot.dayIdx} * ((100% - 52px) / 5) + 3px + ${slot.lane} * ((100% - 52px) / 5 - 6px) / ${slot.lanes})`,
                        width: `calc(((100% - 52px) / 5 - 6px) / ${slot.lanes})`,
                        zIndex: isOpen ? 40 : 16,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setOpenCrowded(isOpen ? null : id)}
                        aria-expanded={isOpen}
                        aria-label={`${slot.hidden.length} more courses at this time`}
                        className={`w-full h-full rounded-lg border border-dashed flex flex-col items-center justify-center gap-0.5 transition-colors ${
                          isOpen
                            ? "border-slate-400 bg-slate-100 text-slate-700"
                            : "border-slate-300 bg-slate-50 text-slate-500 hover:border-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        }`}
                      >
                        <span className="text-[11px] font-bold leading-none">+{slot.hidden.length}</span>
                        <span className="text-[9px] leading-none opacity-70">more</span>
                      </button>

                      {isOpen && (
                        <div
                          className={`absolute w-56 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white shadow-xl py-1 ${
                            dropUp ? "bottom-full mb-1" : "top-full mt-1"
                          } ${alignRight ? "right-0" : "left-0"}`}
                        >
                          <div className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                            {DAYS_SHORT[slot.dayIdx]} {formatSlotTime(slot.top, slot.height)}
                          </div>
                          {slot.hidden.map(({ course }) => {
                            const pal = colorOf(course);
                            return (
                              <div
                                key={`${course.offering_name}-${course.section_name}`}
                                className="group/more flex items-start gap-2 px-2.5 py-1.5 hover:bg-slate-50 transition-colors"
                              >
                                <span
                                  className="mt-[3px] w-2 h-2 rounded-full shrink-0"
                                  style={{ background: pal.border }}
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelected(course);
                                    setOpenCrowded(null);
                                  }}
                                  className="flex-1 min-w-0 text-left"
                                >
                                  <span className="block text-[11px] font-semibold text-slate-700 truncate">
                                    {course.offering_name}
                                  </span>
                                  <span className="block text-[10px] text-slate-500 truncate">
                                    {course.title}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeCourse(course)}
                                  className="shrink-0 text-[10px] text-slate-300 hover:text-red-500 opacity-0 group-hover/more:opacity-100 transition-opacity"
                                  title="Remove"
                                >
                                  &#10005;
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* The region being swept out, before it has a name. */}
                {drag && (() => {
                  const lo = snap(Math.min(drag.fromMin, drag.toMin));
                  const hi = snap(Math.max(drag.fromMin, drag.toMin));
                  if (hi - lo < MIN_DURATION_MIN) return null;
                  return (
                    <div
                      data-grid-overlay
                      className="absolute rounded-lg border-2 border-dashed border-violet-400 bg-violet-100/50 pointer-events-none flex items-start justify-center pt-1"
                      style={{
                        top: ((lo - GRID_START_MIN) / 60) * ROW_H,
                        height: ((hi - lo) / 60) * ROW_H,
                        left: `calc(52px + ${drag.dayIdx} * ((100% - 52px) / 5) + 3px)`,
                        width: `calc((100% - 52px) / 5 - 6px)`,
                        zIndex: 30,
                      }}
                    >
                      <span className="text-[10px] font-semibold text-violet-700">
                        {minutesToLabel(lo)} – {minutesToLabel(hi)}
                      </span>
                    </div>
                  );
                })()}

                {/* Naming a new block, or editing one that exists. */}
                {activityDraft && (
                  <div
                    data-grid-overlay
                    className="absolute"
                    style={{
                      top: activityDraft.top,
                      left: `calc(52px + ${activityDraft.dayIdx} * ((100% - 52px) / 5) + 3px)`,
                      width: `calc((100% - 52px) / 5 - 6px)`,
                      zIndex: 50,
                    }}
                  >
                    <div
                      className={`absolute ${
                        activityDraft.top > (HOURS.length * ROW_H) / 2 ? "bottom-0 mb-1" : "top-0"
                      } ${activityDraft.dayIdx >= 3 ? "right-0" : "left-0"}`}
                    >
                      <ActivityEditor
                        key={activityDraft.id ?? `new-${activityDraft.dayIdx}-${activityDraft.start_min}`}
                        draft={activityDraft}
                        saving={savingActivity}
                        onSave={saveActivity}
                        onCancel={() => {
                          setActivityDraft(null);
                          setActivityError(null);
                        }}
                        onDelete={
                          activityDraft.id ? () => deleteActivity(activityDraft.id!) : undefined
                        }
                      />
                      {activityError && (
                        <p className="mt-1 px-2 py-1 rounded bg-red-50 text-[10px] text-red-600">
                          {activityError}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Courses with no meetings (TBA/online/PLAN in current term) — show as list below calendar */}
          {(() => {
            const ghostCourses = schedule.filter((c) => {
              if (!c.meetings || c.meetings === "" || c.meetings === "TBA") return true;
              if (c.section_name === "PLAN" || c.section_name === "TAKEN") return true;
              // Check if this course has any visible calendar blocks
              const mbs = parseMeetings(c.meetings);
              return mbs.length === 0;
            });
            if (ghostCourses.length === 0) return null;
            return (
              <div className="border-t border-slate-200 bg-slate-50/50 px-4 py-2">
                <div className="text-[10px] text-slate-400 mb-1">Courses without scheduled times:</div>
                <div className="flex flex-wrap gap-1.5">
                  {ghostCourses.map((c) => (
                    <div key={`${c.offering_name}-${c.section_name}`} className="flex items-center gap-1.5 text-[10px] bg-white border border-slate-200 rounded px-2 py-1 group/ghost">
                      <span className="font-mono text-violet-600">{c.offering_name}</span>
                      <span className="text-slate-500 truncate max-w-[120px]">{c.title}</span>
                      <span className="text-slate-300">{c.credits}cr</span>
                      <button
                        onClick={async () => {
                          await fetch("/api/schedule", {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ offering_name: c.offering_name, section_name: c.section_name, term: activeTerm, slot: activeSlot }),
                          });
                          fetchSchedule();
                        }}
                        className="text-red-300 hover:text-red-500 opacity-0 group-hover/ghost:opacity-100"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Course detail panel */}
          {selected && panelReady && (
            <div
              ref={panelRef}
              className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] z-20 max-h-[60%] flex flex-col"
            >
              <div className="flex-1 overflow-y-auto px-5 py-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-medium text-slate-400">
                        {selected.offering_name}
                      </span>
                      <span className="text-[11px] text-slate-300">
                        Section {selected.section_name}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-slate-900 mt-0.5">
                      {selected.title}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={async () => {
                        await fetch("/api/schedule", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ offering_name: selected.offering_name, section_name: selected.section_name, term: activeTerm, slot: activeSlot }),
                        });
                        setSelected(null); setProfRatings(null); setCourseDetail(null);
                        fetchSchedule();
                      }}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => { setSelected(null); setProfRatings(null); setCourseDetail(null); }}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors text-xs"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>

                {/* Two-column layout */}
                <div className="grid grid-cols-[1fr_1fr] gap-5">
                  {/* Left: course info + evals + professor ratings */}
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                      <div>
                        <span className="text-slate-400">Credits</span>
                        <p className="text-slate-700 font-medium">{selected.credits}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Format</span>
                        <p className="text-slate-700 font-medium">{selected.instruction_method || "N/A"}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Schedule</span>
                        <p className="text-slate-700 font-medium">{selected.meetings || "TBA"}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Location</span>
                        <p className="text-slate-700 font-medium">
                          {[selected.building, selected.location].filter(Boolean).join(", ") || "TBA"}
                        </p>
                      </div>
                      <div className="col-span-2">
                        <span className="text-slate-400">Instructor</span>
                        <p className="text-slate-700 font-medium">
                          {selected.instructors_full_name || "Staff"}
                          {selected.instructors_full_name && selected.instructors_full_name !== "Staff" && (
                            <a
                              href={`https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(selected.instructors_full_name.split(";")[0].trim())}+Johns+Hopkins`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-1.5 text-[10px] text-blue-400 hover:text-blue-600"
                              title="Search Google Scholar"
                            >Scholar ↗</a>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Sections — which one you're in, and the others */}
                    {courseDetail && courseDetail !== "loading" && (courseDetail.sections?.length ?? 0) > 0 && (
                      <div>
                        <span className="text-[11px] text-slate-400">
                          Sections ({courseDetail.sections!.length})
                          {courseDetail.sections!.length > 1 && (
                            <span className="text-slate-300"> · click to switch</span>
                          )}
                        </span>
                        <div className="mt-1.5 max-h-36 overflow-y-auto rounded-lg border border-slate-100 divide-y divide-slate-100">
                          {courseDetail.sections!.map((sec) => {
                            const current = sec.section_name === selected.section_name;
                            const busy = switchingSection === sec.section_name;
                            const seats =
                              sec.open_seats !== null && sec.max_seats !== null
                                ? `${sec.open_seats}/${sec.max_seats}`
                                : null;
                            return (
                              <button
                                key={sec.section_name}
                                type="button"
                                disabled={current || switchingSection !== null}
                                onClick={() => switchSection(sec)}
                                aria-current={current}
                                className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2 text-[11px] transition-colors ${
                                  current
                                    ? "bg-blue-50 cursor-default"
                                    : switchingSection !== null
                                      ? "opacity-50 cursor-wait"
                                      : "hover:bg-slate-50 cursor-pointer"
                                }`}
                              >
                                <span
                                  className={`font-mono font-semibold shrink-0 w-7 ${
                                    current ? "text-blue-600" : "text-slate-500"
                                  }`}
                                >
                                  {sec.section_name}
                                </span>
                                <span className="flex-1 min-w-0">
                                  <span className="block truncate text-slate-600">
                                    {sec.meetings || "TBA"}
                                  </span>
                                  <span className="block truncate text-slate-400 text-[10px]">
                                    {sec.instructors_full_name || "Staff"}
                                  </span>
                                </span>
                                {seats && (
                                  <span
                                    className={`shrink-0 text-[10px] ${
                                      sec.open_seats === 0 ? "text-red-400" : "text-slate-400"
                                    }`}
                                    title={
                                      sec.waitlisted
                                        ? `${sec.waitlisted} on the waitlist`
                                        : "Open seats / capacity"
                                    }
                                  >
                                    {seats}
                                  </span>
                                )}
                                <span className="shrink-0 w-12 text-right text-[10px] font-medium">
                                  {busy ? (
                                    <span className="text-violet-500">…</span>
                                  ) : current ? (
                                    <span className="text-blue-600">In plan</span>
                                  ) : (
                                    <span className="text-slate-300">Switch</span>
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Course evaluations */}
                    <div>
                      <span className="text-[11px] text-slate-400">Course Evaluations</span>
                      {courseDetail && courseDetail !== "loading" && courseDetail.overall_quality !== null ? (
                        <div className="mt-1.5 space-y-1.5">
                          {([
                            ["Overall Quality", courseDetail.overall_quality],
                            ["Instructor", courseDetail.instructor_effectiveness],
                            ["Challenge", courseDetail.intellectual_challenge],
                            ["Workload", courseDetail.workload],
                          ] as const).map(([label, value]) =>
                            value !== null ? (
                              <div key={label} className="flex items-center gap-2 text-[12px]">
                                <span className="text-slate-500 w-[100px] shrink-0">{label}</span>
                                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full"
                                    style={{
                                      width: `${((value as number) / 5) * 100}%`,
                                      background: label === "Workload"
                                        ? (value as number) > 3.5 ? "#f87171" : (value as number) > 2.5 ? "#fbbf24" : "#34d399"
                                        : (value as number) >= 4 ? "#34d399" : (value as number) >= 3 ? "#fbbf24" : "#f87171",
                                    }}
                                  />
                                </div>
                                <span className="text-slate-700 font-semibold w-7 text-right">{(value as number).toFixed(1)}</span>
                              </div>
                            ) : null
                          )}
                          {courseDetail.num_respondents !== null && (
                            <p className="text-[11px] text-slate-400">
                              {courseDetail.num_respondents} respondent{courseDetail.num_respondents !== 1 && "s"}
                            </p>
                          )}
                        </div>
                      ) : courseDetail === "loading" ? (
                        <p className="text-[12px] text-slate-400 mt-0.5">Loading...</p>
                      ) : (
                        <p className="text-[12px] text-slate-400 mt-0.5">No data available</p>
                      )}
                    </div>

                    {/* Professor ratings */}
                    <div>
                      <span className="text-[11px] text-slate-400">RateMyProfessors</span>
                      <div className="mt-1 text-[12px] space-y-1.5">
                        {profRatings === "loading" && (
                          <span className="text-slate-400">Loading...</span>
                        )}
                        {Array.isArray(profRatings) && profRatings.length === 0 && (
                          <span className="text-slate-400">N/A</span>
                        )}
                        {Array.isArray(profRatings) && profRatings.map((pr) => (
                          <div key={pr.name} className="flex items-center gap-3 text-slate-700">
                            <span className="font-medium text-slate-500 min-w-[90px] truncate">
                              {pr.name.split(",").reverse().map(s => s.trim()).join(" ")}
                            </span>
                            {pr.rating ? (
                              <>
                                <span><span className="font-semibold">{pr.rating.avg_rating.toFixed(1)}</span><span className="text-slate-400">/5</span></span>
                                <span><span className="font-semibold">{pr.rating.avg_difficulty.toFixed(1)}</span><span className="text-slate-400"> diff</span></span>
                                {pr.rating.would_take_again_pct !== null && pr.rating.would_take_again_pct >= 0 && (
                                  <span><span className="font-semibold">{Math.round(pr.rating.would_take_again_pct)}%</span><span className="text-slate-400"> retake</span></span>
                                )}
                                <span className="text-slate-400 text-[11px]">({pr.rating.num_ratings})</span>
                              </>
                            ) : (
                              <span className="text-slate-400">N/A</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right: description + prerequisites */}
                  <div className="space-y-3">
                    {courseDetail === "loading" && (
                      <p className="text-[11px] text-slate-400">Loading details...</p>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.description && (
                      <div>
                        <span className="text-[11px] text-slate-400">Description</span>
                        <p className="text-[12px] text-slate-600 leading-relaxed mt-0.5">
                          {courseDetail.description}
                        </p>
                      </div>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.prerequisites && (() => {
                      const { restrictions, prereqs } = splitPrerequisites(courseDetail.prerequisites);
                      return (
                        <>
                          {prereqs.length > 0 && (
                            <div>
                              <span className="text-[11px] text-slate-400">Prerequisites</span>
                              <p className="text-[12px] text-slate-600 leading-relaxed mt-0.5">
                                {prereqs.join("; ")}
                              </p>
                            </div>
                          )}
                          {restrictions.length > 0 && (
                            <div>
                              <span className="text-[11px] text-slate-400">Restrictions</span>
                              {restrictions.map((r, i) => (
                                <p key={i} className="text-[12px] text-amber-600 leading-relaxed mt-0.5">
                                  {r}
                                </p>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {courseDetail && courseDetail !== "loading" && !courseDetail.description && !courseDetail.prerequisites && (
                      <p className="text-[12px] text-slate-400">No description available</p>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.areas && (
                      <div>
                        <span className="text-[11px] text-slate-400">Areas</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(() => {
                            const DISTRO_NAMES: Record<string, string> = { E: "Engineering", H: "Humanities", N: "Natural Sciences", Q: "Quantitative", S: "Social Sciences" };
                            const raw = courseDetail.areas.split(",").map((a: string) => a.trim()).filter(Boolean);
                            const expanded: string[] = [];
                            for (const area of raw) {
                              if (/^[EHNQS]{2,}$/.test(area)) {
                                for (const ch of area) expanded.push(ch);
                              } else {
                                expanded.push(area);
                              }
                            }
                            const unique = [...new Set(expanded)];
                            return unique.map((area) => {
                              const isDistro = /^[EHNQS]$/.test(area);
                              return (
                                <span
                                  key={area}
                                  className={`inline-block text-[9px] font-medium px-1.5 py-0.5 rounded border ${isDistro ? "bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold" : "bg-slate-50 text-slate-600 border-slate-200"}`}
                                  title={isDistro ? DISTRO_NAMES[area] : undefined}
                                >
                                  {isDistro ? `${area} - ${DISTRO_NAMES[area]}` : area}
                                </span>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.pos_tags && courseDetail.pos_tags.length > 0 && (
                      <div>
                        <span className="text-[11px] text-slate-400">POS Codes</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {courseDetail.pos_tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-block text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ---- RIGHT: Chat ---- */}
      <aside className="w-[380px] shrink-0 border-l border-slate-200 bg-white flex flex-col">
        {/* Chat header — aligned with left top bar */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-slate-200 bg-white/80 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-slate-900 tracking-tight">
              Course Assistant
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFeedbackOpen(true)}
              className="text-[11px] text-slate-400 hover:text-blue-500 transition-colors"
              title="Send feedback"
            >
              Feedback
            </button>
            {messages.length > 0 && (
              <button
                onClick={() => { setMessages([]); }}
                className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
                title="Clear chat"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Feedback modal */}
        {feedbackOpen && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setFeedbackOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl p-5 w-[420px] max-w-[90vw] shadow-xl space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Send Feedback</h3>
                <button onClick={() => setFeedbackOpen(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
              </div>
              <p className="text-[11px] text-slate-500">Send feedback or issues. Click send to open your email client.</p>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Your feedback..."
                className="w-full h-32 text-[12px] px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none"
              />
              <div className="flex items-center justify-end">
                <a
                  href={`mailto:rayhan@live.com?subject=${encodeURIComponent("JHU Course Chat Feedback")}&body=${encodeURIComponent(feedbackText)}`}
                  onClick={() => { setFeedbackOpen(false); setFeedbackText(""); }}
                  className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors ${feedbackText.trim() ? "bg-blue-500 text-white hover:bg-blue-600" : "bg-slate-100 text-slate-300 pointer-events-none"}`}
                >
                  Send
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && !isLoading && (
            <div className="pt-6 space-y-4">
              <p className="text-[13px] text-slate-500 leading-relaxed">
                Ask me anything about JHU courses, professors, schedules, or prerequisites.
              </p>
              <div className="space-y-1.5">
                {[
                  "Add Data Structures section 01 to my schedule and find CS classes that don't conflict",
                  "Find upper level CS courses rated above 4.0 that don't require Data Structures",
                  "Which CS professors have the highest RMP ratings and what are they teaching?",
                  "Find me easy writing intensives on TTh before noon",
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      sendMessage({ text: s });
                    }}
                    className="block w-full text-left px-3 py-2 rounded-lg text-xs text-slate-600 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Agent messages */}
          {messages.map((message, msgIdx) => {
            // Hide assistant messages that have no visible content (only hidden tool parts)
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
                onMouseLeave={clearPreview}
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 ${
                  message.role === "user"
                    ? "bg-slate-800 text-white"
                    : "bg-slate-100 text-slate-800"
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    if (message.role === "user") {
                      return (
                        <div
                          key={i}
                          className="text-[12px] leading-[1.6] [&>strong]:font-semibold"
                          dangerouslySetInnerHTML={{ __html: md(part.text) }}
                        />
                      );
                    }
                    return (
                      <div
                        key={i}
                        className="text-[12px] leading-[1.6] [&>strong]:font-semibold"
                      >
                        <MessageContent
                          html={md(part.text)}
                          validCourses={validCourses}
                          courseSections={courseSections}
                          onAdd={async (code, section) => {
                            await fetch("/api/schedule", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ offering_name: code, section_name: section, term: activeTerm, slot: activeSlot }),
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
                  if (isToolUIPart(part)) {
                    return null;
                  }
                  return null;
                })}
              </div>
            </div>
          );
          })}

          {isLoading && (() => {
            const last = messages[messages.length - 1];
            if (!last) return false;
            if (last.role === "user") return true;
            const hasText = last.parts.some((p) => p.type === "text" && p.text.trim());
            return !hasText;
          })() && (
            <div className="flex justify-start">
              <div className="bg-slate-100 rounded-2xl px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-slate-100 shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim() && !isLoading) {
                sendMessage({ text: input });
                setInput("");
              }
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isLoading}
              placeholder="Ask about courses..."
              className="flex-1 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-[12px] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-300 disabled:opacity-50 transition-all"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="p-2 rounded-xl bg-slate-800 text-white disabled:opacity-30 hover:bg-slate-700 transition-colors"
              aria-label="Send"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
