import { rawPointForDisplayPoint } from "../simulator/orientation.js";
import type { PointerSample, PointerTrackUpload } from "../../fork/pointer-track-format";
import type { RecordingSidecar } from "./recording-sidecar";

// fork: records what the mouse did while a toolbar recording was running.
//
// The recording itself comes off the simulator, so it holds only what iOS
// drew: no cursor, no touch indicators. This track is the missing half. The
// page sends it with its stop request, the server saves it beside the movie,
// and the overlay script draws it back on, including clicks and the second
// finger that option-drag produces.
//
// Coordinates are normalized to the framebuffer, not to what the surface
// happened to show: they go through the same orientation mapping the touch path
// applies, so a rotated capture lines up, and they survive any window resize.

/** Ceiling on move sampling, so a fast mouse can't balloon the file. */
const MOVE_MIN_INTERVAL_MS = 8;

const SURFACE_SELECTOR = '[data-testid="simulator-surface"]';

interface PointerTracker {
  /** Detaches the listeners and returns everything captured so far. */
  stop(): PointerSample[];
}

function surfaceElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SURFACE_SELECTOR);
}

/**
 * Intrinsic size of whatever paints the stream: the AVCC canvas or MJPEG img.
 *
 * Scoped to the surface. Searching the whole document took the first canvas on
 * the page, which is only the stream while AVCC is in use; under MJPEG the
 * stream is an <img> and the search landed on some unrelated canvas, sending
 * the track out with its size in place of the device's.
 */
function videoSize(): { width: number; height: number } | null {
  const surface = surfaceElement();
  if (!surface) return null;
  const canvas = surface.querySelector("canvas");
  if (canvas && canvas.width > 0) return { width: canvas.width, height: canvas.height };
  // Any painted <img>, not `img[src]`: the MJPEG path assigns the blob through
  // the property and the attribute selector never matched, so this reported
  // nothing at all under the codec that is now the default. A non-zero
  // intrinsic size is the real test of "this one is showing the stream".
  for (const img of surface.querySelectorAll("img")) {
    if (img.naturalWidth > 0) return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return null;
}

function startPointerTracking(): PointerTracker {
  const events: PointerSample[] = [];
  const t0 = performance.now();
  let lastMoveAt = -Infinity;
  let alt = false;

  const at = () => Math.round(performance.now() - t0);
  const round = (n: number) => Math.round(n * 10000) / 10000;

  // Recorded in the framebuffer's own space, the same mapping the touch path
  // applies before the device sees a point. Storing what the surface showed
  // instead would place every marker transposed on a landscape capture and
  // point-mirrored on an upside-down one, with nothing in the file to undo it.
  const locate = (ev: MouseEvent) => {
    const surface = surfaceElement();
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const dx = (ev.clientX - rect.left) / rect.width;
    const dy = (ev.clientY - rect.top) / rect.height;
    const over = dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1;
    const orientation = surface.dataset.orientation as
      | "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
      | undefined;
    const raw = rawPointForDisplayPoint(orientation ?? "portrait", dx, dy);
    return { x: round(raw.x), y: round(raw.y), over };
  };

  // The pinch partner is read off the screen rather than derived. Mirroring
  // through the centre is only one of the two option modes: holding shift pans,
  // where the second finger travels parallel with a locked offset, and a
  // mirrored guess drew it moving the opposite way.
  const partner = () => {
    const surface = surfaceElement();
    const dots = surface?.querySelectorAll<HTMLElement>('[data-testid="finger-dot"]');
    if (!surface || !dots || dots.length < 2) return null;
    const rect = surface.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const box = dots[1]!.getBoundingClientRect();
    const dx = (box.left + box.width / 2 - rect.left) / rect.width;
    const dy = (box.top + box.height / 2 - rect.top) / rect.height;
    const orientation = surface.dataset.orientation as
      | "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
      | undefined;
    const raw = rawPointForDisplayPoint(orientation ?? "portrait", dx, dy);
    return { px: round(raw.x), py: round(raw.y) };
  };

  const onMove = (ev: MouseEvent) => {
    const now = performance.now();
    if (now - lastMoveAt < MOVE_MIN_INTERVAL_MS) return;
    const p = locate(ev);
    if (!p) return;
    lastMoveAt = now;
    events.push({ t: at(), e: "move", ...p, alt, ...(alt ? partner() ?? {} : {}) });
  };

  const onButton = (e: "down" | "up") => (ev: MouseEvent) => {
    const p = locate(ev);
    if (!p) return;
    events.push({ t: at(), e, ...p, alt, b: ev.button, ...(alt ? partner() ?? {} : {}) });
  };

  const onDown = onButton("down");
  const onUp = onButton("up");

  // Option drives the two-finger preview, so its transitions are part of the
  // track even when the mouse is still.
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Alt" || alt) return;
    alt = true;
    events.push({ t: at(), e: "alt", held: true });
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key !== "Alt" || !alt) return;
    alt = false;
    events.push({ t: at(), e: "alt", held: false });
  };
  // Alt+Tab and friends steal the keyup, which would leave the track claiming
  // option is still down for the rest of the recording.
  const onBlur = () => {
    if (!alt) return;
    alt = false;
    events.push({ t: at(), e: "alt", held: false });
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);

  return {
    stop() {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      return events;
    },
  };
}

const PINCH_RULE =
  "px/py carry the second finger where option was held; coordinates are already in the framebuffer's orientation";

/**
 * The track as a {@link RecordingSidecar}: it starts listening as the start
 * request goes out, and leaves with the stop request.
 *
 * t=0 is the moment the start is dispatched. The server stamps the moment it
 * received the start and the moment it answered, so the trip out is what is
 * left of the round trip once the server's own work (helper start, native
 * start) is taken off, halved. Halving the whole trip instead would charge
 * half of that work to the trip out and put t=0 late by as much.
 */
export function pointerTrackSidecar(): RecordingSidecar {
  let tracker: PointerTracker | null = null;
  let startedAt: string | null = null;

  const drop = () => {
    tracker?.stop();
    tracker = null;
    startedAt = null;
  };

  return {
    startQuery: { index: "1" },
    begin() {
      drop();
      tracker = startPointerTracking();
    },
    started({ startedAt: received, respondedAt, roundTripMs }) {
      const receivedMs = Date.parse(received ?? "");
      if (!Number.isFinite(receivedMs)) return;
      const respondedMs = Date.parse(respondedAt ?? "");
      const serverWorkMs = Number.isFinite(respondedMs) ? Math.max(0, respondedMs - receivedMs) : 0;
      const outboundMs = Math.max(0, roundTripMs - serverWorkMs) / 2;
      startedAt = new Date(receivedMs - outboundMs).toISOString();
    },
    abort: drop,
    finish() {
      const events = tracker?.stop() ?? [];
      const anchor = startedAt;
      tracker = null;
      startedAt = null;
      // Nothing to draw, or nothing to line it up by: the movie downloads
      // either way, and a folder with no cursor in it would only be clutter.
      if (!events.length || !anchor) return null;
      const upload: PointerTrackUpload = {
        version: 1,
        startedAt: anchor,
        video: videoSize(),
        pinch: PINCH_RULE,
        events,
      };
      return JSON.stringify(upload);
    },
  };
}
