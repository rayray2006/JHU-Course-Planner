/**
 * Live seat counts, straight from SIS, for courses already on screen.
 *
 * The stored numbers come from a cron that can only run once a day on Hobby,
 * so during registration week what the page paints is a 3am snapshot — a
 * section listed as having seats may have been full since breakfast. This
 * route exists to correct that one number without putting SIS in front of the
 * whole page: the UI paints from Supabase immediately and patches these values
 * in when they land, so a slow or unreachable SIS degrades to the stored data
 * rather than an empty card.
 *
 * The fetching, caching and write-back live in `@/lib/live-seats`, which the
 * chat agent shares — it is asked the same questions about seats and waitlists
 * and should not answer them from yesterday's numbers either.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { fetchLiveSeats, persistLiveSeats } from "@/lib/live-seats";
import { CURRENT_TERM } from "@/lib/terms";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const term = req.nextUrl.searchParams.get("term") || CURRENT_TERM;
  const codes = (req.nextUrl.searchParams.get("codes") || "").split(",");

  const { courses, failed, rows } = await fetchLiveSeats(codes, term);

  // Everything SIS just told us is newer than what the table holds, so fold it
  // back in and the next page load starts from it — the cron stops being the
  // only thing keeping the table current.
  //
  // This has to outlive the response: the function can be frozen the moment it
  // returns, which would leave a bare floating promise unfinished. `after`
  // hands the work to the platform (waitUntil on Vercel) so it still lands,
  // while the caller gets its numbers without waiting for a database write.
  if (rows.length > 0) {
    after(async () => {
      try {
        await persistLiveSeats(rows);
      } catch (err) {
        console.error("seats: write-back failed", err);
      }
    });
  }

  return NextResponse.json({ term, courses, failed, fetchedAt: Date.now() });
}
