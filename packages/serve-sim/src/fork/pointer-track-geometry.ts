// fork: where a pointer track lands on its movie, in time and in space. Pure
// functions, so scripts/overlay-cursor.ts stays a thin ffmpeg driver and the
// parts that have gone wrong before can be tested on their own.

import type { PointerTrack } from "./pointer-track-format";

export interface TrackAlignment {
  /** Added to a track time to get a movie time. */
  offsetMs: number;
  /** Hold the movie's first frame this long before it starts. */
  headPadMs: number;
  /** Hold its last frame this long after it ends. */
  tailPadMs: number;
  /** True when the shift came from the two stamps rather than a guess. */
  anchored: boolean;
}

/** The shift straight from the two recordings' timestamps, which share a clock. */
function anchoredOffsetMs(track: Pick<PointerTrack, "startedAt" | "movieStartedAt">): number | null {
  if (!track.startedAt || !track.movieStartedAt) return null;
  const trackStart = Date.parse(track.startedAt);
  const movieStart = Date.parse(track.movieStartedAt);
  if (!Number.isFinite(trackStart) || !Number.isFinite(movieStart)) return null;
  return trackStart - movieStart;
}

/**
 * Lines a track up with its movie.
 *
 * Both stamps come off the host's clock, so when both are there the shift is a
 * subtraction. Without them, lining the tails up is the last resort, and it is
 * wrong by however long the screen sat still before the stop.
 *
 * What happens at the ends depends on the recorder. The native one writes a
 * frame for every slot from its first frame to the stop, so the movie is the
 * whole session and anything the track holds outside it is simply dropped.
 * simctl wrote frames only while the screen changed, so a still stretch at
 * either end was missing from the file; those are restored by holding the
 * first and last frame, which also moves the movie's zero onto the track's.
 */
export function trackAlignment(
  track: Pick<PointerTrack, "startedAt" | "movieStartedAt" | "source" | "events">,
  movieMs: number,
): TrackAlignment {
  const lastEventMs = track.events.length ? track.events[track.events.length - 1]!.t : 0;
  const anchored = anchoredOffsetMs(track);
  const offsetMs = anchored ?? movieMs - lastEventMs;
  const restoreStills = anchored !== null && track.source !== "native";
  return {
    offsetMs,
    headPadMs: restoreStills ? Math.max(0, -offsetMs) : 0,
    // How far the last event falls past the end of the movie. Holding the head
    // moves both by the same amount, so only the offset is left in it.
    tailPadMs: restoreStills ? Math.max(0, lastEventMs + offsetMs - movieMs) : 0,
    anchored: anchored !== null,
  };
}

export interface DisplayFrame {
  /** Size of the frames the overlay draws on, after ffmpeg turns them upright. */
  width: number;
  height: number;
  /** A raw framebuffer point (normalized) on those frames (normalized). */
  point(x: number, y: number): { x: number; y: number };
}

/**
 * The frame the overlay draws on, for a movie of coded size `width`x`height`
 * whose track carries a clockwise display `rotation`.
 *
 * ffmpeg applies that rotation on decode, so the filtergraph sees upright
 * frames while the track holds raw portrait framebuffer points. Each point
 * makes the same clockwise turn: the inverse of `rawPointForDisplayPoint`.
 */
export function displayFrame(rotation: number, width: number, height: number): DisplayFrame {
  switch (((Math.round(rotation) % 360) + 360) % 360) {
    case 90:
      return { width: height, height: width, point: (x, y) => ({ x: 1 - y, y: x }) };
    case 270:
      return { width: height, height: width, point: (x, y) => ({ x: y, y: 1 - x }) };
    case 180:
      return { width, height, point: (x, y) => ({ x: 1 - x, y: 1 - y }) };
    default:
      return { width, height, point: (x, y) => ({ x, y }) };
  }
}
