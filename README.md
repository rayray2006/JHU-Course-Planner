# CourseSearch

Course search and scheduling for Johns Hopkins, with a chat interface that actually knows the data.

SIS can tell you a course exists. It can't tell you that the section fits around the three classes you already picked, that the professor averages 2.1 on workload, or that the same course was taught by someone else last spring with much better reviews. This pulls all of that into one place and puts an agent in front of it.

Unofficial and not affiliated with JHU.

## What it does

Ask for things in plain language and get back a short list, not a wall of text:

- "easy humanities before noon that fit my schedule"
- "upper level CS that doesn't need data structures"
- "who teaches Signals and Systems and how are they rated"
- "FA4 courses with open seats"

Behind that are 12 tools over the dataset. The main search alone takes close to 40 parameters — time windows, days of week, areas, Foundational Abilities, POS tags, prerequisite keywords to include or exclude, seat availability, and cutoffs on any evaluation metric. The rest cover schedule add/remove with conflict detection, prerequisite chains, term-over-term course history, and professor lookup against RateMyProfessors.

There's also a normal UI — a weekly schedule grid, a search panel, and a degree-requirements sidebar that tracks progress against program schemas scraped from the e-catalogue. The chat and the grid stay in sync; adding a course either way updates both.

## Stack

Next.js 16 (App Router) and React 19 on the front, Vercel AI SDK v6 driving a `ToolLoopAgent` on Gemini 2.5 Flash through Vertex, capped at 5 steps with a small thinking budget. Data lives in Postgres (Supabase) in production and SQLite locally.

## Running it

You need Node 20+, a Supabase project, and Google Vertex credentials. The JHU SIS API key is only needed if you want to re-scrape course data yourself.

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

Environment variables:

| Variable | Needed for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | everything |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything |
| `SUPABASE_SERVICE_KEY` | writes, all ingest scripts |
| `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` | the chat agent |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Vertex auth in production |
| `ANTHROPIC_API_KEY` | optional; switches the chat agent from Gemini 2.5 Flash to Claude Haiku 5.5 |
| `JHU_API_KEY` | scraping SIS |
| `JHU_SIS_API_BASE` | optional; overrides the SIS API host (default `https://sis.jhu.edu/api`) |
| `CRON_SECRET` | the seat-refresh cron |

If a `courses.db` file is present, the data layer uses SQLite and skips Supabase entirely — queries are much faster and you can work offline. On Vercel the native module isn't available, so it falls back to Supabase automatically. Same query surface either way, in `src/lib/data.ts`.

## The data

Roughly 40,000 course sections across eight terms (Fall 2024 through Spring 2027), 16,000 course evaluations going back to 2015, 10,000 catalogue entries, and 887 rated professors. Five upstream sources, none of them an official public API:

- **SIS Course Search Web API** (`sis.jhu.edu/api/classes`, overridable with `JHU_SIS_API_BASE`) — sections, meeting times, instructors, seats, waitlists. The only source that changes daily. All calls go through `src/lib/sis-api.ts`, which also normalises the newer Typesense-backed API's response format (caret-separated `Areas` with codes, `{ "Message": ... }` error bodies, inline `SectionDetails`) into the shape the tables already use.
- **`e-catalogue.jhu.edu`** — descriptions, prerequisites, corequisites, restrictions, and program requirement pages.
- **`asen-jhu.evaluationkit.com`** — course evaluations, behind a public report link and a cookie session.
- **RateMyProfessors** — ratings by professor, via their GraphQL endpoint.
- **JHU's Typesense index** — Program of Study tags (`CSCI-APPL`, `ROBO-CMCS`, and so on).

Tables: `courses`, `catalogue`, `evaluations`, `professors`, `schedules`, `program_requirements`, `program_schemas`, `program_tags`, `available_terms`. Schema in `supabase/schema.sql`.

### Refreshing it

Seats and waitlists move constantly during registration, so a Vercel cron hits `/api/cron/sync-seats` every morning at 8am and re-pulls the current term. To do it by hand, with a report of what changed:

```bash
npm run sync:seats               # current term
npm run sync:seats -- "Spring 2027"
```

The heavier scrapes write to SQLite first, then get pushed up:

```bash
npm run ingest                   # SIS sections, all terms
npm run ingest:catalogue         # descriptions and prerequisites
npm run ingest:evaluations       # course evaluations
npm run ingest:rmp               # RateMyProfessors
npm run sync:supabase [table] [term]   # push SQLite -> Supabase (term narrows `courses`)
npm run aggregate:evals -- --dry # roll evaluations into course ratings
```

Evaluations are stored per course-instance and then averaged into rating columns on `courses`, which is what the search filters read. If you sync evaluations without running `aggregate:evals`, the new data lands in the table but nothing in the app changes.

A few things worth knowing before you run the scrapers:

The evaluation scrape takes hours. It discovers ~15,000 reports across ~5,000 course codes, and evaluationkit throttles long sessions hard — expect throughput to fall off a cliff after the first half hour. It's built to survive that: work is checkpointed to `eval_searched_codes`, `eval_link_cache`, and `eval_no_data`, results accumulate in a staging table, and the live table is only swapped at the very end (and only if staging has at least 90% of the previous row count). If it dies, run it again and it picks up where it stopped. `--fresh` throws away the checkpoints and starts over.

Sections that disappear from SIS are never deleted, so a term's row count slowly drifts above what SIS actually reports. Nothing depends on it yet, but the numbers won't match exactly.

Descriptions are sparse for future terms. The e-catalogue only publishes them once a term is close, so a newly opened term will have sections and times but almost no descriptions until it fills in.

## Cost

Every chat request is metered in `src/lib/cost-tracker.ts` against Vertex's Gemini 2.5 Flash pricing and logged to Supabase. There's a hard $150 cutoff so a runaway loop or a bored crawler can't drain the account.

## Layout

```
src/app/          routes and the single-page UI
src/lib/agents/   agent definition and system prompt
src/lib/tools/    the 12 tools the agent can call
src/lib/data.ts   SQLite/Supabase data layer
scripts/          ingest and sync scripts
supabase/         schema
```

The system prompt in `src/lib/agents/course-agent.ts` is doing a lot of the work — output formatting, which tool to reach for, and a standing instruction never to ask clarifying questions when it could just run the search instead. Worth reading before changing agent behavior.
