import { cookies } from "next/headers";

export const SESSION_COOKIE = "schedule_session";
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * The caller's schedule identity, minted on first contact.
 *
 * Every route that touches `schedules` must come through here. The chat route
 * used to fall back to the literal string "default" instead of minting a UUID,
 * so a visitor whose first action was asking the agent to add a course wrote
 * into a bucket shared with every other cookie-less visitor — and then read
 * back an empty schedule, because GET /api/schedule minted a throwaway UUID
 * rather than persisting one. Three orphan rows under "default" in production
 * are what that left behind.
 *
 * HTTP cannot set a cookie once a response has started streaming, so call this
 * before handing off to a stream, not inside it.
 */
export async function resolveSessionId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE)?.value;
  if (existing) return existing;

  const sessionId = crypto.randomUUID();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return sessionId;
}
