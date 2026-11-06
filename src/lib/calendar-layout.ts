/**
 * Column layout for the week grid.
 *
 * Two jobs:
 *
 * 1. Decide how many side-by-side columns a set of overlapping blocks needs,
 *    and which column each one sits in. The old inline version asked each
 *    block "who overlaps me?" and divided the day column by that count, which
 *    is wrong whenever overlap isn't transitive: for 9:00-10:00, 9:30-10:30
 *    and 10:00-11:00 the three blocks compute denominators of 2, 3 and 2, so
 *    the first two are drawn at different widths and visibly overlap. Blocks
 *    have to agree on a denominator, so it is computed per *cluster* — a
 *    transitively-connected run of overlapping blocks — not per block.
 *
 * 2. Keep blocks readable when a slot is crowded. Past three columns a block
 *    is too narrow to show even a course number, so a cluster needing more
 *    than `maxLanes` columns shows the first `maxLanes - 1` and collapses the
 *    rest into one "+N more" tile that the caller renders as a popover.
 */

export interface LayoutBlock {
  dayIdx: number;
  top: number;
  height: number;
  isPreview?: boolean;
}

export interface Placed<T> {
  block: T;
  /** Column index within the day, 0-based. */
  lane: number;
  /** How many columns the day is divided into here. */
  lanes: number;
}

export interface Overflow<T> {
  dayIdx: number;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  hidden: T[];
}

export interface DayLayout<T> {
  placed: Placed<T>[];
  overflow: Overflow<T>[];
}

const end = (b: LayoutBlock) => b.top + b.height;

/**
 * Lay out one day's blocks.
 *
 * `key` only breaks ties, so that two blocks at the same time don't swap
 * columns between renders.
 */
export function layoutDay<T extends LayoutBlock>(
  blocks: T[],
  key: (b: T) => string,
  maxLanes = 3
): DayLayout<T> {
  const placed: Placed<T>[] = [];
  const overflow: Overflow<T>[] = [];
  if (blocks.length === 0) return { placed, overflow };

  // Ascending start is what makes the greedy column assignment below correct.
  // A preview block wins its tie so it lands in column 0 and never ends up
  // hidden behind a "+N more" — it exists to show where a course would go.
  const sorted = [...blocks].sort((a, b) => {
    if (a.top !== b.top) return a.top - b.top;
    const pa = a.isPreview ? 0 : 1;
    const pb = b.isPreview ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.height !== b.height) return b.height - a.height;
    return key(a).localeCompare(key(b));
  });

  // A cluster breaks where a block starts at or after everything before it has
  // ended; nothing across that line can overlap, so the two sides are free to
  // use different column counts.
  let cluster: T[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;

    // Greedy interval partitioning: reuse the first column whose last block
    // has already finished, else open a new one.
    const laneEnd: number[] = [];
    const laneOf = new Map<T, number>();
    for (const b of cluster) {
      let lane = laneEnd.findIndex((e) => e <= b.top);
      if (lane === -1) {
        lane = laneEnd.length;
        laneEnd.push(end(b));
      } else {
        laneEnd[lane] = end(b);
      }
      laneOf.set(b, lane);
    }

    const laneCount = laneEnd.length;

    if (laneCount <= maxLanes) {
      for (const b of cluster) {
        placed.push({ block: b, lane: laneOf.get(b)!, lanes: laneCount });
      }
    } else {
      // Crowded. Keep the first maxLanes - 1 columns; the last column becomes
      // the "+N more" tile standing in for everything further right.
      const visibleLanes = maxLanes - 1;
      const hidden: T[] = [];
      for (const b of cluster) {
        const lane = laneOf.get(b)!;
        if (lane < visibleLanes) {
          placed.push({ block: b, lane, lanes: maxLanes });
        } else {
          hidden.push(b);
        }
      }
      if (hidden.length > 0) {
        const top = Math.min(...hidden.map((b) => b.top));
        const bottom = Math.max(...hidden.map(end));
        overflow.push({
          dayIdx: cluster[0].dayIdx,
          top,
          height: bottom - top,
          lane: visibleLanes,
          lanes: maxLanes,
          hidden,
        });
      }
    }

    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const b of sorted) {
    if (b.top >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, end(b));
  }
  flush();

  return { placed, overflow };
}

/** Lay out every day independently. */
export function layoutWeek<T extends LayoutBlock>(
  blocks: T[],
  key: (b: T) => string,
  maxLanes = 3
): DayLayout<T> {
  const byDay = new Map<number, T[]>();
  for (const b of blocks) {
    const list = byDay.get(b.dayIdx);
    if (list) list.push(b);
    else byDay.set(b.dayIdx, [b]);
  }
  const placed: Placed<T>[] = [];
  const overflow: Overflow<T>[] = [];
  for (const dayBlocks of byDay.values()) {
    const day = layoutDay(dayBlocks, key, maxLanes);
    placed.push(...day.placed);
    overflow.push(...day.overflow);
  }
  return { placed, overflow };
}
