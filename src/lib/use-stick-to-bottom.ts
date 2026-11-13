import { useCallback, useEffect, useRef } from "react";

/**
 * How close to the bottom still counts as following along. Without slack, a
 * stream that outruns the scroll by a pixel reads as the reader having left,
 * and the log stops following on its own.
 */
const SLACK_PX = 64;

/**
 * Keeps a chat log pinned to the bottom while a reply streams in, and lets go
 * the moment the reader scrolls up.
 *
 * The version this replaces called `scrollIntoView` on every change to
 * `messages` — once per token during a stream — so scrolling up was
 * impossible: the next delta pulled the view straight back down. `behavior:
 * "smooth"` made it worse, restarting an animation that never had time to
 * finish, so whatever you scrolled to was still sliding past when the next
 * one began.
 *
 * Releasing the pin is driven by INPUT (wheel, touch), not by the scroll
 * position, and that distinction is the whole fix. Scroll events are
 * coalesced and delivered asynchronously, so when a token lands in the same
 * frame as the reader's scroll, the re-pin runs first and the one scroll
 * event that arrives afterwards reports the bottom — the reader's scroll is
 * erased before any position check could notice it. A wheel or touch event
 * says what they wanted before the scrolling happens, which nothing can
 * overwrite. Position still decides when to RESUME: reaching the bottom again
 * is how you ask to be carried along.
 */
export function useStickToBottom(
  messages: readonly { role: string }[],
  streaming: boolean,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Refs, not state: these change on every wheel tick, and nothing renders
   * from them. As state they would re-render the whole log mid-stream.
   */
  const stuck = useRef(true);
  const count = useRef(messages.length);

  const atBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK_PX;
  };

  // Only the resume half. Leaving is handled by the input events below.
  const onScroll = useCallback(() => {
    if (atBottom()) stuck.current = true;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) stuck.current = false;
  }, []);

  // Touch carries no direction until the scroll lands, so any drag releases
  // the pin; the scroll handler re-pins if the drag ends at the bottom.
  const onTouchMove = useCallback(() => {
    stuck.current = false;
  }, []);

  useEffect(() => {
    const grew = messages.length > count.current;
    count.current = messages.length;

    // Sending a message is an intent to watch the answer, so it re-pins even
    // if they had scrolled away to re-read something first.
    if (grew && messages[messages.length - 1]?.role === "user") stuck.current = true;
    if (!stuck.current) return;

    const el = scrollRef.current;
    if (!el) return;
    // Jump while streaming; animate only once the message has settled, where
    // no follow-up delta is waiting to cut the animation short.
    if (streaming) el.scrollTop = el.scrollHeight;
    else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  return { scrollRef, onScroll, onWheel, onTouchMove };
}
