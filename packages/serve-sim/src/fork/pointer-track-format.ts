// fork: the pointer track's file format, shared by the three parties that touch it:
// the page that records it, the server that saves it beside the movie, and the
// overlay script that draws it back on. Nothing from Node, so the page can
// import it into the browser bundle.
//
// Coordinates are normalized to the framebuffer, which is always native
// portrait: the page maps every point through the same orientation rule the
// touch path applies before the device sees it. Multiply by the movie's coded
// pixel size to place them, then apply the movie's own rotation.

/** `px`/`py` carry the second finger while option is held, when it is on screen. */
export type PointerSample =
  | { t: number; e: "move"; x: number; y: number; over: boolean; alt: boolean; px?: number; py?: number }
  | { t: number; e: "down" | "up"; x: number; y: number; over: boolean; alt: boolean; b: number; px?: number; py?: number }
  | { t: number; e: "alt"; held: boolean };

/** What the page knows and sends with its stop request. */
export interface PointerTrackUpload {
  version: 1;
  /**
   * Host clock of t=0. The page works it out from the start round trip, so it
   * is the server's clock even when the page runs on another machine: the two
   * machines' wall clocks agree only by accident, and the skew would land
   * straight in the alignment.
   */
  startedAt: string;
  /** Pixel size of the stream as the page saw it; the overlay trusts the movie instead. */
  video: { width: number; height: number } | null;
  /** How to rebuild the second pointer that option-drag shows. */
  pinch: string;
  events: PointerSample[];
}

/** The file on disk: the upload plus what only the server knows. */
export interface PointerTrack extends PointerTrackUpload {
  /** The simulator's udid. */
  device: string;
  /** Basename of the movie this track belongs to. */
  movie: string;
  /**
   * Which recorder made the movie. "native" is serve-sim's own: constant frame
   * rate from the first frame to the stop. Absent on the older simctl captures,
   * which wrote frames only while the screen changed.
   */
  source?: "native";
  /**
   * Host clock of the movie's first frame. With both stamps on one clock, the
   * shift between the recordings is a subtraction. Null when the recorder
   * placed no frame to anchor on.
   */
  movieStartedAt: string | null;
  /** Clockwise display rotation stored on the movie's track (0, 90, 180, -90). */
  rotation?: number;
}

/** Stop response header: where the server saved the movie (URI-encoded host path). */
export const CAPTURE_HEADER = "X-Serve-Sim-Capture";

/**
 * The overlay's output beside `movie`: `<name>-with-cursor.<ext>`, so it sorts
 * next to its source and still reads as a toolbar recording's name.
 */
export function cursorMovieName(movie: string): string {
  const dot = movie.lastIndexOf(".");
  return dot > 0 ? `${movie.slice(0, dot)}-with-cursor${movie.slice(dot)}` : `${movie}-with-cursor`;
}
