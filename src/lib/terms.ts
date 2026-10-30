/**
 * The term the app defaults to. `available_terms.is_current` in the database is
 * the real source of truth — the UI and the seat-sync cron both read it there —
 * but server routes need a fallback for requests that arrive without a term,
 * and `npm run ingest` needs to know which row to flag. Keep them in step by
 * changing this constant and re-running the ingest for the new term.
 */
export const CURRENT_TERM = "Spring 2027";
