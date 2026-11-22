// fork: the cursor pass for recordings made from the preview toolbar.
//
// The native recorder encodes the framebuffer, which has no cursor in it. The
// page records what the mouse did while it ran and sends that track with its
// stop request. This saves the two side by side in a folder of their own in the
// host's Downloads and hands the folder to scripts/overlay-cursor.ts, which
// burns the track onto a copy of the movie:
//
//   serve-sim-2026-11-22-14-42-09/
//     serve-sim-recording-2026-11-22-14-42-09.mp4
//     serve-sim-recording-2026-11-22-14-42-09-with-cursor.mp4
//     pointer-track.json
//     overlay.log
//
// The movie is named the way upstream names a toolbar download, which is what
// its Finder card checks before it reveals a file or drops it on the simulator.
// The stop response says where the movie went (CAPTURE_HEADER), and the page
// takes that in place of its own download. A capture that cannot be saved is
// logged and dropped, the header stays off, and the page downloads as before.

import { spawn } from "child_process";
import { closeSync, constants, existsSync, lstatSync, openSync } from "fs";
import { copyFile, mkdir, rename, writeFile } from "fs/promises";
import type { IncomingMessage } from "http";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { cursorMovieName, type PointerTrack, type PointerTrackUpload } from "./pointer-track-format";
import { recordingFileName } from "../recording";
import { recordingClock, splitRecordingSummary } from "../recording-index";

export { CAPTURE_HEADER } from "./pointer-track-format";
export const CAPTURE_TRACK_NAME = "pointer-track.json";
const OVERLAY_LOG_NAME = "overlay.log";

/**
 * Ceiling on the stop body. Continuous movement costs about 9 KB of JSON a
 * second, so the 30 minute recording cap stays well under it.
 */
const MAX_TRACK_BYTES = 64 * 1024 * 1024;

/** Highest `_n` suffix tried before giving up on a minute. */
const MAX_FOLDER_SUFFIX = 99;

export interface CursorCaptureDependencies {
  /** Where capture folders go; defaults to ~/Downloads. */
  capturesDir?: string;
  /** Clock for the folder name; defaults to `new Date()`. */
  now?: () => Date;
  /** Starts the overlay pass on a saved folder; defaults to {@link spawnOverlay}. */
  spawnOverlay?: (dir: string) => void;
}

/** The track the page sent, or null for anything that is not one. */
export function parseCursorTrack(raw: string): PointerTrackUpload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const track = value as Partial<PointerTrackUpload>;
  if (track.version !== 1) return null;
  // Without its anchor a track can only be lined up by guessing, and a wrong
  // guess looks subtly right. Refusing it here says so in the log.
  if (typeof track.startedAt !== "string" || !Number.isFinite(Date.parse(track.startedAt))) return null;
  if (!Array.isArray(track.events)) return null;
  const video = track.video;
  const sized = video && typeof video === "object" && typeof video.width === "number" && typeof video.height === "number";
  return {
    version: 1,
    startedAt: track.startedAt,
    video: sized ? { width: video.width, height: video.height } : null,
    pinch: typeof track.pinch === "string" ? track.pinch : "",
    events: track.events,
  };
}

/**
 * Reads a pointer track from a stop request's body. Resolves null at once for
 * a stop that carries none (the CLI, another tab, an upstream client), and for
 * a body that is too large, malformed, or cut off.
 */
export function readCursorTrack(req: IncomingMessage): Promise<PointerTrackUpload | null> {
  const type = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type !== "application/json") return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (track: PointerTrackUpload | null) => {
      if (settled) return;
      settled = true;
      resolve(track);
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return; // keep draining so the request still completes
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_TRACK_BYTES) {
        chunks.length = 0;
        settle(null);
        return;
      }
      chunks.push(buf);
    });
    req.once("end", () => settle(parseCursorTrack(Buffer.concat(chunks).toString("utf8"))));
    req.once("error", () => settle(null));
    // A client that hangs up mid-body never sends "end".
    req.once("close", () => settle(null));
  });
}

/** `serve-sim-2026-11-22-14-42-09`: local time, sorts chronologically. */
export function captureFolderName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = [
    date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()),
    pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds()),
  ].join("-");
  return `serve-sim-${stamp}`;
}

/**
 * Creates the folder for one capture. Two stops within the same second step
 * aside to `_2`, `_3`, … rather than sharing a folder. mkdir is the test as
 * well as the creation, so they cannot both pick the same name.
 */
export async function makeCaptureDir(parent: string, date: Date): Promise<string> {
  await mkdir(parent, { recursive: true });
  const base = join(parent, captureFolderName(date));
  for (let n = 1; n <= MAX_FOLDER_SUFFIX; n++) {
    const dir = n === 1 ? base : `${base}_${n}`;
    try {
      await mkdir(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`No free capture folder name for ${base}`);
}

/**
 * Saves one capture: a copy of the finished movie, and the page's track with
 * the server's half filled in. Resolves to the folder and the movie's path in
 * it. The movie at `moviePath` is left in place, since the caller still
 * streams it to the page (which uses it for the Finder card's thumbnail).
 */
export async function saveCursorCapture({
  device,
  moviePath,
  track,
  summary,
  deps = {},
}: {
  device: string;
  moviePath: string;
  track: PointerTrackUpload;
  /** The native recorder's finish summary, with its index when one was asked for. */
  summary: string;
  deps?: CursorCaptureDependencies;
}): Promise<{ dir: string; moviePath: string }> {
  const { summary: fields, index } = splitRecordingSummary(summary);
  // pts 0 moved onto the wall clock. Null when the start asked for no index,
  // or when the recorder never placed a frame.
  const clock = index ? recordingClock(index) : null;
  const rotation = typeof fields.rotation === "number" ? fields.rotation : 0;

  const date = (deps.now ?? (() => new Date()))();
  const dir = await makeCaptureDir(deps.capturesDir ?? join(homedir(), "Downloads"), date);
  const movieName = recordingFileName(date);
  const savedMovie = join(dir, movieName);
  // A clone on APFS, so even a long recording costs no time or space here.
  await copyFile(moviePath, savedMovie, constants.COPYFILE_FICLONE);

  const saved: PointerTrack = {
    ...track,
    device,
    movie: movieName,
    source: "native",
    movieStartedAt: clock?.originWall ?? null,
    rotation,
  };
  // Staged and moved into place, so `just cursor` can never pick up a half
  // written track and die in JSON.parse with no hint why.
  const trackPath = join(dir, CAPTURE_TRACK_NAME);
  await writeFile(`${trackPath}.part`, JSON.stringify(saved));
  await rename(`${trackPath}.part`, trackPath);

  (deps.spawnOverlay ?? spawnOverlay)(dir);
  return { dir, moviePath: savedMovie };
}

const OVERLAY_SCRIPT = join("scripts", "fork", "overlay-cursor.ts");

/**
 * The overlay script in the package: scripts/fork/ under packages/serve-sim,
 * which is two levels up from this file in src/fork/ and one from the bundle
 * in dist/. Absent from the npm package and the compiled binary, where the
 * overlay pass is simply skipped.
 */
function overlayScriptPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of [[".."], ["..", ".."]]) {
    const candidate = join(here, ...up, OVERLAY_SCRIPT);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Runs the overlay pass on a saved folder, detached and logged to overlay.log
 * there: the encode outlives the request, and a failure has to leave
 * something behind to read. Needs `bun` on PATH; without it the log says so.
 */
function spawnOverlay(dir: string): void {
  const script = overlayScriptPath();
  if (!script) return;
  const log = openSync(join(dir, OVERLAY_LOG_NAME), "a");
  try {
    const child = spawn("bun", ["run", script, dir], { detached: true, stdio: ["ignore", log, log] });
    child.on("error", (error) => {
      console.error(`[record] cursor overlay for ${dir} did not start: ${error.message}`);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * The stop's side of the capture, for DeviceSession's `fork:` seam: saves the
 * page's track beside a copy of the movie and resolves to the saved movie's
 * path, or null when there was no track or saving failed. Never throws: the
 * MP4 download comes first.
 */
export async function captureForStop({
  udid,
  moviePath,
  track,
  summary,
  deps,
}: {
  udid: string;
  moviePath: string;
  track: PointerTrackUpload | null;
  summary: string;
  deps?: CursorCaptureDependencies;
}): Promise<string | null> {
  if (!track) return null;
  try {
    const saved = await saveCursorCapture({ device: udid, moviePath, track, summary, deps });
    console.error(`[record] ${udid}: cursor capture saved to ${saved.dir}`);
    return saved.moviePath;
  } catch (error) {
    console.error(`[record] ${udid}: could not save the cursor capture:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * For upstream's revealRecording `fork:` seam: the cursor render beside a
 * recording once the overlay has written it, else the recording itself. The
 * render's name is the recording's plus a suffix in the same folder, so it
 * passes the same checks the recording already did.
 */
export function preferCursorRender(path: string): string {
  const slash = path.lastIndexOf("/");
  const render = `${path.slice(0, slash + 1)}${cursorMovieName(path.slice(slash + 1))}`;
  try {
    return lstatSync(render).isFile() ? render : path;
  } catch {
    return path;
  }
}
