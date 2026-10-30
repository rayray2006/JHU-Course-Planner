import { load } from "cheerio";
import { initDb } from "../src/lib/db";

const AUTH_URL =
  "https://asen-jhu.evaluationkit.com/Login/ReportPublic?id=THo7RYxiDOgppCUb8vkY%2bPMVFDNyK2ADK0u537x%2fnZsNvzOBJJZTTNEcJihG8hqZ";
const BASE = "https://asen-jhu.evaluationkit.com/";

const QUESTION_MAP: Record<string, string> = {
  "The overall quality of this course is:": "overall_quality",
  "The instructor's teaching effectiveness is:": "instructor_effectiveness",
  "The intellectual challenge of this course is:": "intellectual_challenge",
  "Compared to other Hopkins courses at this level, the workload for this course is:": "workload",
  "Feedback on my work for this course is useful:": "feedback_usefulness",
};

// ── Multiple independent sessions for parallel scraping ─────────────
const NUM_SESSIONS = 6;
const BATCH_SIZE = 4;

class Session {
  cookies: string[] = [];
  reauths = 0;

  private merge(headers: string[]) {
    for (const h of headers) {
      const c = h.split(";")[0];
      const n = c.split("=")[0];
      this.cookies = this.cookies.filter((x) => !x.startsWith(n + "="));
      this.cookies.push(c);
    }
  }

  async fetch(url: string, retries = 3): Promise<string> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        let u = url;
        for (let r = 0; r < 10; r++) {
          const res = await fetch(u, {
            redirect: "manual",
            headers: { Cookie: this.cookies.join("; "), "User-Agent": "Mozilla/5.0" },
          });
          const sc = res.headers.getSetCookie?.() ?? [];
          if (sc.length > 0) this.merge(sc);
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) throw new Error("Redirect without location");
            u = loc.startsWith("http") ? loc : new URL(loc, u).toString();
            continue;
          }
          if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        }
        throw new Error("Too many redirects");
      } catch (err) {
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        else throw err;
      }
    }
    throw new Error("Unreachable");
  }

  async authenticate() {
    await this.fetch(AUTH_URL);
  }

  /** Drop cookies and log in again. Returns false if the site won't have us. */
  async reauth(): Promise<boolean> {
    try {
      this.cookies = [];
      await this.fetch(AUTH_URL, 2);
      this.reauths++;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch that heals itself. evaluationkit sessions expire partway through a
   * long run; without this, every later request on that session fails forever
   * and its whole share of the work is silently lost.
   */
  async get(url: string): Promise<string> {
    try {
      return await this.fetch(url);
    } catch (err) {
      if (await this.reauth()) return await this.fetch(url);
      throw err;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
function computeWeightedAvg(freq: Record<string, number>): number | null {
  const entries = Object.entries(freq).filter(([l]) => l !== "N/A" && l !== "n/a");
  if (entries.length === 0) return null;
  let total = 0, sum = 0;
  for (let i = 0; i < entries.length; i++) { total += entries[i][1]; sum += entries[i][1] * (i + 1); }
  return total === 0 ? null : Math.round((sum / total) * 100) / 100;
}

function countRespondents(freq: Record<string, number>): number {
  return Object.entries(freq).filter(([l]) => l !== "N/A" && l !== "n/a").reduce((s, [, c]) => s + c, 0);
}

// ── Discovery: extract metadata + report links from search page ─────
interface ReportLink {
  instanceKey: string;
  url: string;
  courseCode: string;
  courseName: string;
  instructor: string;
  responded: number;
  enrolled: number;
  termLabel: string;
}

function parseSearchPage(html: string, courseCode: string): ReportLink[] {
  const $ = load(html);
  const links: ReportLink[] = [];
  $("a.sr-view-report").each((_, el) => {
    const $el = $(el);
    const id0 = $el.attr("data-id0"), id1 = $el.attr("data-id1"),
      id2 = $el.attr("data-id2"), id3 = $el.attr("data-id3");
    if (!id0 || !id1 || !id2 || !id3) return;

    const $row = $el.closest(".row");
    const instanceKey = $row.find(".sr-dataitem-info-code").text().trim();
    if (!instanceKey) return;

    const courseName = $row.find("h2").text().trim();
    const instructor = $row.find(".sr-dataitem-info-instr").text().trim();

    let responded = 0, enrolled = 0;
    const respText = $row.find(".sr-avg span").text().trim();
    const respMatch = respText.match(/(\d+)\s+of\s+(\d+)/);
    if (respMatch) { responded = parseInt(respMatch[1]); enrolled = parseInt(respMatch[2]); }

    const termLabel = $row.find(".sr-dataitem-info .small").first().text().trim().split("\n")[0].trim();

    links.push({
      instanceKey, courseCode, courseName, instructor, responded, enrolled, termLabel,
      url: `${BASE}Reports/StudentReport.aspx?id=${id0},${id1},${id2},${id3}`,
    });
  });
  return links;
}

// ── Report parsing ──────────────────────────────────────────────────
interface EvalRow {
  courseCode: string;
  instanceKey: string;
  courseName: string;
  instructor: string;
  term: string;
  termLabel: string;
  overallQuality: number | null;
  instructorEffectiveness: number | null;
  intellectualChallenge: number | null;
  workload: number | null;
  feedbackUsefulness: number | null;
  numRespondents: number;
  numEnrolled: number;
}

/**
 * "no-data" means we fetched a real report page that carries no usable ratings
 * — permanent, don't retry. "bad-page" means we got something that isn't a
 * report page at all (a login redirect, an error page) — transient, do retry.
 */
type ParseResult =
  | { kind: "row"; row: EvalRow }
  | { kind: "no-data" }
  | { kind: "bad-page" };

function parseReport(html: string, link: ReportLink): ParseResult {
  const $ = load(html);
  const hdnData = $("#hdnReportData").val();
  // No report container at all — this isn't a report page, so retry it later.
  if (!hdnData || typeof hdnData !== "string") return { kind: "bad-page" };

  let data: unknown;
  try { data = JSON.parse(hdnData); } catch { return { kind: "no-data" }; }

  const freqs: Record<string, Record<string, number>> = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      const qt = item.QuestionText || item.questionText || "";
      for (const [question, key] of Object.entries(QUESTION_MAP)) {
        if (qt.includes(question) || question.includes(qt)) {
          const opts = item.Options || item.options || [];
          const f: Record<string, number> = {};
          for (const o of opts) {
            const l = o.OptionText || o.optionText || o.Label || o.label || "";
            const c = o.Frequency || o.frequency || o.Count || o.count || 0;
            if (l) f[l] = Number(c);
          }
          freqs[key] = f;
          break;
        }
      }
    }
  }

  if (!freqs.overall_quality) return { kind: "no-data" };
  const parts = link.instanceKey.split(".");
  return { kind: "row", row: {
    courseCode: link.courseCode,
    instanceKey: link.instanceKey,
    courseName: link.courseName,
    instructor: link.instructor,
    term: parts[parts.length - 1] || "",
    termLabel: link.termLabel,
    overallQuality: computeWeightedAvg(freqs.overall_quality),
    instructorEffectiveness: computeWeightedAvg(freqs.instructor_effectiveness || {}),
    intellectualChallenge: computeWeightedAvg(freqs.intellectual_challenge || {}),
    workload: computeWeightedAvg(freqs.workload || {}),
    feedbackUsefulness: computeWeightedAvg(freqs.feedback_usefulness || {}),
    numRespondents: link.responded || countRespondents(freqs.overall_quality),
    numEnrolled: link.enrolled,
  } };
}

// ── Worker: each session processes its own chunk ────────────────────
/**
 * Hand out work one batch at a time so every session pulls from the same pool.
 * With fixed per-session slices, one stalled session strands its whole slice.
 */
function makeQueue<T>(items: T[], batch: number) {
  let i = 0;
  return () => (i >= items.length ? null : items.slice(i, (i += batch)));
}

async function workerDiscover(
  session: Session,
  nextBatch: () => string[] | null,
  progress: { done: number; total: number; links: number; errors: number },
  onLinks: (links: ReportLink[], searched: string[]) => void
): Promise<{ links: ReportLink[]; noEval: string[] }> {
  const links: ReportLink[] = [];
  const noEval: string[] = [];

  for (let batch = nextBatch(); batch !== null; batch = nextBatch()) {
    const results = await Promise.all(
      batch.map(async (code) => {
        try {
          const html = await session.get(`${BASE}Report/Public/Results?Course=${encodeURIComponent(code)}`);
          return { code, links: parseSearchPage(html, code), failed: false };
        } catch {
          // A fetch failure is NOT the same as "this course has no evaluations" —
          // track it separately so a broken session can't masquerade as empty data.
          return { code, links: [] as ReportLink[], failed: true };
        }
      })
    );
    const batchLinks: ReportLink[] = [];
    const searched: string[] = [];
    for (const r of results) {
      if (r.failed) {
        progress.errors++;
      } else {
        // Only a successful search counts as done — a failed one must be retried
        // on the next run, not remembered as "this course has no evaluations".
        searched.push(r.code);
        if (r.links.length > 0) {
          links.push(...r.links);
          batchLinks.push(...r.links);
          progress.links += r.links.length;
        } else noEval.push(r.code);
      }
      progress.done++;
    }
    onLinks(batchLinks, searched);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { links, noEval };
}

async function workerScrape(
  session: Session,
  nextBatch: () => ReportLink[] | null,
  progress: { done: number; ok: number; noData: number; fail: number; total: number },
  onRows: (rows: EvalRow[], noData: string[]) => void
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (let batch = nextBatch(); batch !== null; batch = nextBatch()) {
    const results = await Promise.all(
      batch.map(async (link) => {
        try {
          return { link, res: parseReport(await session.get(link.url), link) };
        } catch {
          return { link, res: { kind: "bad-page" } as ParseResult };
        }
      })
    );
    const batchRows: EvalRow[] = [];
    const batchNoData: string[] = [];
    for (const { link, res } of results) {
      if (res.kind === "row") {
        rows.push(res.row); batchRows.push(res.row); progress.ok++;
      } else if (res.kind === "no-data") {
        // Permanently has no ratings — record it so later runs skip it instead
        // of paying full retry cost on every pass.
        batchNoData.push(link.instanceKey); progress.noData++;
      } else progress.fail++;
      progress.done++;
    }
    // Persist as we go so an interrupted run resumes from here.
    if (batchRows.length > 0 || batchNoData.length > 0) onRows(batchRows, batchNoData);
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const db = initDb();
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";

  // Scrape into a staging table and swap on success, so a crash or a kill
  // never leaves the live `evaluations` table empty. Staging survives across
  // runs so an interrupted scrape resumes instead of starting over.
  const COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_code TEXT NOT NULL,
      instance_key TEXT NOT NULL UNIQUE,
      course_name TEXT DEFAULT '',
      instructor TEXT DEFAULT '',
      term TEXT DEFAULT '',
      term_label TEXT DEFAULT '',
      overall_quality REAL,
      instructor_effectiveness REAL,
      intellectual_challenge REAL,
      workload REAL,
      feedback_usefulness REAL,
      num_respondents INTEGER DEFAULT 0,
      num_enrolled INTEGER DEFAULT 0`;

  db.exec(`CREATE TABLE IF NOT EXISTS evaluations (${COLUMNS});`);
  db.exec(`CREATE TABLE IF NOT EXISTS evaluations_staging (${COLUMNS});`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_link_cache (
      instance_key TEXT PRIMARY KEY,
      course_code TEXT NOT NULL,
      course_name TEXT DEFAULT '',
      instructor TEXT DEFAULT '',
      term_label TEXT DEFAULT '',
      responded INTEGER DEFAULT 0,
      enrolled INTEGER DEFAULT 0,
      url TEXT NOT NULL,
      discovered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_searched_codes (
      code TEXT PRIMARY KEY,
      searched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_no_data (
      instance_key TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
  `);

  const fresh = process.argv.includes("--fresh");
  if (fresh) {
    console.log("--fresh: clearing staging, link cache, search log and no-data log");
    db.exec("DELETE FROM evaluations_staging; DELETE FROM eval_link_cache; DELETE FROM eval_searched_codes; DELETE FROM eval_no_data;");
  }

  const baseline = (db.prepare("SELECT COUNT(*) c FROM evaluations").get() as { c: number }).c;
  console.log(`Live evaluations table currently holds ${baseline} rows.`);

  const codes = (
    db.prepare("SELECT DISTINCT offering_name FROM courses ORDER BY offering_name").all() as { offering_name: string }[]
  ).map((r) => r.offering_name);

  // Create and authenticate multiple sessions
  console.log(`\nCreating ${NUM_SESSIONS} parallel sessions...`);
  const sessions: Session[] = [];
  for (let i = 0; i < NUM_SESSIONS; i++) {
    const s = new Session();
    await s.authenticate();
    sessions.push(s);
  }
  console.log(`All sessions ready. [${elapsed()}]\n`);

  // Phase 1: Discover — only search codes we haven't already searched
  // successfully, so an interrupted run resumes instead of starting over.
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM eval_searched_codes WHERE searched_at < ?").run(Date.now() - CACHE_TTL_MS);
  const alreadySearched = new Set(
    (db.prepare("SELECT code FROM eval_searched_codes").all() as { code: string }[]).map((r) => r.code)
  );

  const cacheLink = db.prepare(`
    INSERT OR REPLACE INTO eval_link_cache
      (instance_key, course_code, course_name, instructor, term_label, responded, enrolled, url, discovered_at)
    VALUES (@instanceKey, @courseCode, @courseName, @instructor, @termLabel, @responded, @enrolled, @url, @now)
  `);
  const markSearched = db.prepare("INSERT OR REPLACE INTO eval_searched_codes (code, searched_at) VALUES (?, ?)");
  const recordDiscovery = db.transaction((links: ReportLink[], searched: string[], now: number) => {
    for (const l of links) cacheLink.run({ ...l, now });
    for (const c of searched) markSearched.run(c, now);
  });

  const toSearch = codes.filter((c) => !alreadySearched.has(c));
  let noEvalCodes: string[] = [];

  if (toSearch.length === 0) {
    console.log(`=== Phase 1: SKIPPED — all ${codes.length} codes already searched ===`);
    console.log(`    (pass --fresh to force rediscovery)\n`);
  } else {
    if (alreadySearched.size > 0) {
      console.log(`Resuming discovery: ${alreadySearched.size} codes already searched, ${toSearch.length} to go.\n`);
    }
    console.log(`=== Phase 1: Discovering reports for ${toSearch.length} courses (${NUM_SESSIONS} sessions × ${BATCH_SIZE} concurrent) ===\n`);

    const discoverProgress = { done: 0, total: toSearch.length, links: 0, errors: 0 };
    const queue = makeQueue(toSearch, BATCH_SIZE);

    // Log progress periodically
    const logInterval = setInterval(() => {
      const reauths = sessions.reduce((s, x) => s + x.reauths, 0);
      console.log(`  ${discoverProgress.done}/${discoverProgress.total} searched — ${discoverProgress.links} reports, ${discoverProgress.errors} errors, ${reauths} re-auths [${elapsed()}]`);
    }, 5000);

    const discoverResults = await Promise.all(
      sessions.map((session) =>
        workerDiscover(session, queue, discoverProgress, (links, searched) =>
          recordDiscovery(links, searched, Date.now())
        )
      )
    );

    clearInterval(logInterval);
    noEvalCodes = discoverResults.flatMap((r) => r.noEval);

    const errorRate = discoverProgress.errors / Math.max(1, toSearch.length);
    console.log(`\n✓ Phase 1: ${discoverProgress.links} reports found, ${discoverProgress.errors} errors [${elapsed()}]\n`);
    if (errorRate > 0.25) {
      throw new Error(
        `Phase 1 aborted: ${discoverProgress.errors}/${toSearch.length} searches failed (${(errorRate * 100).toFixed(0)}%). ` +
          `Live data left untouched; successful searches are checkpointed, so re-running resumes.`
      );
    }
  }

  // Always read the full link set from the cache — it spans this run and any
  // earlier resumed ones.
  const allLinks = db.prepare(`
    SELECT instance_key AS instanceKey, course_code AS courseCode, course_name AS courseName,
           instructor, term_label AS termLabel, responded, enrolled, url
    FROM eval_link_cache
  `).all() as unknown as ReportLink[];

  if (allLinks.length === 0) {
    throw new Error("Phase 1 found no reports at all — refusing to touch the live table.");
  }

  // Phase 2: Scrape — skip anything already staged by an earlier interrupted run
  const staged = new Set(
    (db.prepare("SELECT instance_key FROM evaluations_staging").all() as { instance_key: string }[])
      .map((r) => r.instance_key)
  );
  const noDataSeen = new Set(
    (db.prepare("SELECT instance_key FROM eval_no_data").all() as { instance_key: string }[])
      .map((r) => r.instance_key)
  );
  const todo = allLinks.filter((l) => !staged.has(l.instanceKey) && !noDataSeen.has(l.instanceKey));
  if (staged.size > 0 || noDataSeen.size > 0) {
    console.log(`Resuming: ${staged.size} staged, ${noDataSeen.size} known to have no ratings, ${todo.length} remaining.\n`);
  }

  console.log(`=== Phase 2: Scraping ${todo.length} reports (${NUM_SESSIONS} sessions × ${BATCH_SIZE} concurrent) ===\n`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO evaluations_staging (
      course_code, instance_key, course_name, instructor, term, term_label,
      overall_quality, instructor_effectiveness, intellectual_challenge,
      workload, feedback_usefulness, num_respondents, num_enrolled
    ) VALUES (
      @courseCode, @instanceKey, @courseName, @instructor, @term, @termLabel,
      @overallQuality, @instructorEffectiveness, @intellectualChallenge,
      @workload, @feedbackUsefulness, @numRespondents, @numEnrolled
    )
  `);
  const markNoData = db.prepare("INSERT OR REPLACE INTO eval_no_data (instance_key, seen_at) VALUES (?, ?)");
  const insertRows = db.transaction((rows: EvalRow[], noData: string[]) => {
    for (const r of rows) insert.run(r);
    const now = Date.now();
    for (const k of noData) markNoData.run(k, now);
  });

  const scrapeProgress = { done: 0, ok: 0, noData: 0, fail: 0, total: todo.length };
  const scrapeQueue = makeQueue(todo, BATCH_SIZE);

  const logInterval2 = setInterval(() => {
    const reauths = sessions.reduce((s, x) => s + x.reauths, 0);
    console.log(`  ${scrapeProgress.done}/${scrapeProgress.total} (${scrapeProgress.ok} ok, ${scrapeProgress.noData} no-ratings, ${scrapeProgress.fail} fail, ${reauths} re-auths) [${elapsed()}]`);
  }, 5000);

  await Promise.all(
    sessions.map((session) => workerScrape(session, scrapeQueue, scrapeProgress, insertRows))
  );

  clearInterval(logInterval2);
  console.log(`\n✓ Phase 2: ${scrapeProgress.ok} scraped, ${scrapeProgress.noData} without ratings, ${scrapeProgress.fail} failed [${elapsed()}]\n`);

  // Guarded swap: only replace live data if staging looks complete. A partial
  // scrape leaves `evaluations` alone and can be resumed by re-running.
  const stagedCount = (db.prepare("SELECT COUNT(*) c FROM evaluations_staging").get() as { c: number }).c;
  if (stagedCount < baseline * 0.9) {
    throw new Error(
      `Refusing to swap: staging has ${stagedCount} rows vs ${baseline} live (< 90%). ` +
        `Live data left untouched — re-run to resume from staging.`
    );
  }

  console.log(`Swapping ${stagedCount} rows into evaluations (was ${baseline})...`);
  db.transaction(() => {
    db.exec("DELETE FROM evaluations");
    db.exec(`
      INSERT INTO evaluations (
        course_code, instance_key, course_name, instructor, term, term_label,
        overall_quality, instructor_effectiveness, intellectual_challenge,
        workload, feedback_usefulness, num_respondents, num_enrolled
      )
      SELECT course_code, instance_key, course_name, instructor, term, term_label,
        overall_quality, instructor_effectiveness, intellectual_challenge,
        workload, feedback_usefulness, num_respondents, num_enrolled
      FROM evaluations_staging
    `);
  })();
  db.exec("CREATE INDEX IF NOT EXISTS idx_eval_course ON evaluations(course_code)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_eval_instructor ON evaluations(instructor)");

  // Phase 3: Aggregate — blank and rebuild inside one transaction so courses
  // are never left with their ratings cleared.
  console.log(`Aggregating into courses...`);
  db.transaction(() => {
  db.exec(`
    UPDATE courses SET overall_quality = NULL, instructor_effectiveness = NULL,
      intellectual_challenge = NULL, workload = NULL, feedback_usefulness = NULL,
      num_evaluations = 0, num_respondents = 0;

    UPDATE courses
    SET overall_quality = agg.avg_oq, instructor_effectiveness = agg.avg_ie,
        intellectual_challenge = agg.avg_ic, workload = agg.avg_wl,
        feedback_usefulness = agg.avg_fu, num_evaluations = agg.cnt,
        num_respondents = agg.total_resp
    FROM (
      SELECT course_code,
        ROUND(AVG(overall_quality), 2) as avg_oq,
        ROUND(AVG(instructor_effectiveness), 2) as avg_ie,
        ROUND(AVG(intellectual_challenge), 2) as avg_ic,
        ROUND(AVG(workload), 2) as avg_wl,
        ROUND(AVG(feedback_usefulness), 2) as avg_fu,
        COUNT(*) as cnt,
        SUM(num_respondents) as total_resp
      FROM evaluations WHERE overall_quality IS NOT NULL
      GROUP BY course_code
    ) agg WHERE courses.offering_name = agg.course_code
  `);
  })();

  // Swap succeeded — clear staging so the next run starts clean.
  db.exec("DELETE FROM evaluations_staging");

  const withEvals = (db.prepare("SELECT COUNT(DISTINCT offering_name) as c FROM courses WHERE overall_quality IS NOT NULL").get() as { c: number }).c;
  const totalResp = (db.prepare("SELECT SUM(num_respondents) as c FROM evaluations WHERE overall_quality IS NOT NULL").get() as { c: number }).c;
  const newTerms = db.prepare("SELECT DISTINCT term FROM evaluations ORDER BY term").all() as { term: string }[];

  console.log(`\n✓ Done in ${elapsed()}!`);
  console.log(`  ${stagedCount} evaluation records stored (was ${baseline})`);
  console.log(`  ${withEvals} courses updated with ratings`);
  console.log(`  ${totalResp} total student responses`);
  console.log(`  ${noEvalCodes.length} courses with no evaluation data`);
  console.log(`  terms: ${newTerms.map((t) => t.term).join(", ")}`);

  console.log(`\n=== Sample ===`);
  const sample = db.prepare(
    "SELECT instance_key, instructor, num_respondents, num_enrolled, overall_quality, workload FROM evaluations WHERE overall_quality IS NOT NULL ORDER BY num_respondents DESC LIMIT 8"
  ).all();
  console.table(sample);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
