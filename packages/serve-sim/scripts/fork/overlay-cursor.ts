#!/usr/bin/env bun
// Burns a recorded pointer track onto its movie.
//
// The recorder encodes the framebuffer, which has no cursor in it, so the page
// records what the mouse did and the server saves it to pointer-track.json
// beside the movie (src/cursor-capture.ts). This turns the two back into one
// video. It also still reads the older simctl captures (recording.mov).
//
// fork: lives in scripts/fork/ with the rest of the fork's code.
//
// Usage:
//   bun run scripts/fork/overlay-cursor.ts [folder]
//
// With no folder, the newest capture is used: serve-sim-* in ~/Downloads, or
// an older one on the Desktop. There is nothing
// to tune: both recordings carry a timestamp off the same clock, so where they
// line up is read rather than guessed.
//
// Everything is done with `overlay`, whose x/y are expressions re-evaluated per
// frame. The obvious tool would be an ASS subtitle burned in with the `ass`
// filter, but Homebrew's ffmpeg ships without libass (and without freetype, so
// no drawtext either), and the overlay x/y in that build are not commandable,
// which rules out sendcmd as well. So position becomes one big expression over
// `t`, built as a balanced if-tree: a right-nested chain deep enough to cover a
// long recording risks the parser's recursion, while a balanced tree over the
// same data is ~11 levels.

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, join } from "path";
import { cursorMovieName, type PointerSample, type PointerTrack } from "../../src/fork/pointer-track-format";
import { displayFrame, trackAlignment } from "../../src/fork/pointer-track-geometry";

/** Grid the track is resampled onto before runs are merged. */
const SAMPLE_HZ = 60;
/** Constant rate the output is rendered at. */
const OUTPUT_FPS = 60;
/** What simctl captures were called, from before the track named its movie. */
const LEGACY_MOVIE_NAME = "recording.mov";
const TRACK_NAME = "pointer-track.json";

type Rgb = [number, number, number];

// Everything about how the markers look lives here.
//
// A pinch is deliberately excluded from the pressed state: option-drag holds
// the button down the whole time, so styling it as a press would leave the two
// fingers looking like different things. While the pair is up, both are the
// resting marker.
// The resting marker is iOS's own touch indicator: a white circle stroked in
// black at half opacity. Those are the documented defaults of Fingertips, the
// library that reproduces the system indicator (fillColor white, strokeColor
// black, touchAlpha 0.5), and 128 is that alpha on a 0-255 scale.
const MARKER = {
  /** Pointer at rest, and both fingers of a pinch. */
  cursor: { fill: [255, 255, 255] as Rgb, rim: [140, 140, 140] as Rgb, alpha: 128 },
  /** Pointer while a button is held, outside a pinch: the same marker, dimmed
   * and a touch more solid so a press is legible without changing hue. */
  press: { fill: [188, 188, 188] as Rgb, rim: [115, 115, 115] as Rgb, alpha: 150 },
};
/** Shared geometry, so the markers cannot drift apart in size. */
const MARKER_RADIUS = 54;
const MARKER_RIM = 3;

/** Enable windows closer together than this are joined into one. */
const WINDOW_MERGE_GAP_MS = 100;

interface Frame {
  x: number;
  y: number;
  over: boolean;
  pressed: boolean;
  alt: boolean;
  /** The second finger, as it actually stood on screen. */
  px: number;
  py: number;
  pair: boolean;
}

interface Run extends Frame {
  /** Inclusive start and exclusive end, in seconds. */
  start: number;
  end: number;
}

/** Duration and frame size in one pass; two probes could also disagree. */
function probeMovie(path: string): { durationMs: number; width: number; height: number } {
  const probe = Bun.spawnSync([
    "ffprobe", "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration:stream=width,height",
    "-of", "json",
    path,
  ]);
  const parsed = JSON.parse(probe.stdout.toString() || "{}");
  const stream = parsed.streams?.[0] ?? {};
  const seconds = Number(parsed.format?.duration);
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isFinite(seconds) || !width || !height) {
    throw new Error(`Could not read ${path}`);
  }
  return { durationMs: seconds * 1000, width, height };
}

/** Where captures have lived, and what their folders were called there. */
const CAPTURE_PLACES: Array<{ dir: string; names: RegExp[] }> = [
  // serve-sim-2026-11-22-14-42-09, with _2 when a second holds two takes.
  { dir: "Downloads", names: [/^serve-sim-\d{4}(-\d{2}){5}(_\d+)?$/] },
  // The simctl era: 20260801_0104, and before that serve-sim-recording-*.
  { dir: "Desktop", names: [/^\d{8}_\d{4}(_\d+)?$/, /^serve-sim-recording-/] },
];

function newestCapture(): string {
  const dirs = CAPTURE_PLACES.flatMap(({ dir, names }) => {
    const parent = join(homedir(), dir);
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .filter((name) => names.some((re) => re.test(name)))
      .map((name) => join(parent, name))
      .filter((path) => statSync(path).isDirectory());
  });
  if (!dirs.length) throw new Error("No capture folder in ~/Downloads or ~/Desktop");
  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}

/** Replays the events onto a uniform grid, then merges unchanged neighbours. */
function toRuns(events: PointerSample[], offsetMs: number): Run[] {
  if (!events.length) return [];
  const step = 1000 / SAMPLE_HZ;
  const last = events[events.length - 1]!.t;

  let cursor = 0;
  const state: Frame = { x: 0, y: 0, over: false, pressed: false, alt: false, px: 0, py: 0, pair: false };
  const runs: Run[] = [];

  for (let ms = events[0]!.t; ms <= last; ms += step) {
    while (cursor < events.length && events[cursor]!.t <= ms) {
      const ev = events[cursor++]!;
      if (ev.e === "alt") {
        state.alt = ev.held;
        // The partner goes with it. The mirror overlay is gated on `pair`
        // alone, so leaving it set burned a second finger into the frame for
        // the rest of the take: releasing option cleared the dots on screen
        // while the render kept drawing one, motionless, at wherever it last
        // stood (measured: 165 frames spanning 0.27s to 3.00s).
        if (!ev.held) state.pair = false;
        continue;
      }
      state.x = ev.x;
      state.y = ev.y;
      state.over = ev.over;
      state.alt = ev.alt;
      state.pair = ev.px !== undefined && ev.py !== undefined;
      if (state.pair) {
        state.px = ev.px!;
        state.py = ev.py!;
      }
      if (ev.e === "down") state.pressed = true;
      if (ev.e === "up") state.pressed = false;
    }
    // Anything the offset pushes before the movie starts is dropped, not pinned
    // to zero. Pinning collapsed every early sample onto the same instant, and
    // the filtergraph then carried hundreds of zero-length windows stacked at
    // t=0, which is what made ffmpeg refuse to build it at all.
    const at = (ms + offsetMs) / 1000;
    if (at < 0) continue;
    const tail = runs[runs.length - 1];
    const same =
      tail &&
      tail.over === state.over &&
      tail.pressed === state.pressed &&
      tail.alt === state.alt &&
      tail.pair === state.pair &&
      Math.abs(tail.px - state.px) < 0.0005 &&
      Math.abs(tail.py - state.py) < 0.0005 &&
      Math.abs(tail.x - state.x) < 0.0005 &&
      Math.abs(tail.y - state.y) < 0.0005;
    if (same) tail.end = at + step / 1000;
    else runs.push({ ...state, start: at, end: at + step / 1000 });
  }
  return runs;
}

/** Balanced if-tree over run boundaries, so the parser never nests deeply. */
function positionExpr(runs: Run[], value: (run: Run) => number): string {
  if (!runs.length) return "0";
  const walk = (lo: number, hi: number): string => {
    if (lo === hi) return value(runs[lo]!).toFixed(1);
    const mid = (lo + hi) >> 1;
    return `if(lt(t\\,${runs[mid]!.end.toFixed(3)})\\,${walk(lo, mid)}\\,${walk(mid + 1, hi)})`;
  };
  return walk(0, runs.length - 1);
}

/** Sum of between() windows; ffmpeg reads any non-zero as enabled. */
function enableExpr(runs: Run[], want: (run: Run) => boolean): string {
  const windows: Array<[number, number]> = [];
  for (const run of runs) {
    if (!want(run)) continue;
    const tail = windows[windows.length - 1];
    // Join anything that touches, not just what starts exactly where the last
    // one ended: a graph with a term per sample is one ffmpeg declines to build.
    if (tail && run.start - tail[1] < WINDOW_MERGE_GAP_MS / 1000) tail[1] = Math.max(tail[1], run.end);
    else windows.push([run.start, run.end]);
  }
  if (!windows.length) return "0";
  return windows.map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`).join("+");
}

/** A stroked, filled disc as an rgba lavfi source: the system touch indicator. */
function sprite(
  { fill, rim: rimColour, alpha }: { fill: Rgb; rim: Rgb; alpha: number },
  radius = MARKER_RADIUS,
  rim = MARKER_RIM,
): string {
  const size = radius * 2 + 2;
  const c = size / 2;
  const dist = `hypot(X-${c}\\,Y-${c})`;
  const colour = (index: number) =>
    rim > 0
      ? `if(gte(${dist}\\,${radius - rim})\\,${rimColour[index]}\\,${fill[index]})`
      : String(fill[index]);
  return (
    `color=c=black:s=${size}x${size},format=rgba,` +
    `geq=r='${colour(0)}':g='${colour(1)}':b='${colour(2)}':` +
    `a='if(lte(${dist}\\,${radius})\\,${alpha}\\,0)'`
  );
}

const [dirArg] = process.argv.slice(2);
const dir = dirArg && dirArg.length ? dirArg : newestCapture();

const trackPath = join(dir, TRACK_NAME);
if (!existsSync(trackPath)) throw new Error(`Missing ${trackPath}`);
const track = JSON.parse(readFileSync(trackPath, "utf-8")) as PointerTrack;
// basename: the name comes out of a file, and must not walk out of the folder.
const movieName = basename(track.movie || LEGACY_MOVIE_NAME);
const moviePath = join(dir, movieName);
if (!existsSync(moviePath)) throw new Error(`Missing ${moviePath}`);

// From the file, never from the track: the page has reported an unrelated
// element's 528x362 for a 1206x2622 recording, and scattered every marker.
const { durationMs: movieMs, width: codedW, height: codedH } = probeMovie(moviePath);
if (track.video && (track.video.width !== codedW || track.video.height !== codedH)) {
  console.log(
    `note      track says ${track.video.width}x${track.video.height}, movie is ${codedW}x${codedH}; using the movie`,
  );
}
// A landscape take is stored as portrait pixels plus a rotation, which ffmpeg
// applies on decode: the markers go where the upright frame puts them.
const frame = displayFrame(track.rotation ?? 0, codedW, codedH);
const W = frame.width;
const H = frame.height;

// The two clocks do not share a zero: tracking starts the moment the start is
// dispatched, the movie at its first frame. See trackAlignment for how they
// are lined up, and for which recorder gets its still stretches restored.
if (!track.events.length) throw new Error("Track has no events to draw");
const { offsetMs, headPadMs, tailPadMs, anchored } = trackAlignment(track, movieMs);
const paddedOffsetMs = offsetMs + headPadMs;

const runs = toRuns(track.events, paddedOffsetMs);
if (!runs.length) throw new Error("Track has no events to draw");

// Normalized coordinates become pixels here, on the upright frame; overlay
// positions by top-left corner, hence the half-sprite shift.
const px = positionExpr(runs, (r) => frame.point(r.x, r.y).x * W);
const py = positionExpr(runs, (r) => frame.point(r.x, r.y).y * H);
// Drawn where the pair actually stood, not mirrored through the centre: with
// shift held, option pans instead of pinching and the second finger travels
// parallel, so the mirror drew it moving the opposite way.
const partnerX = positionExpr(runs, (r) => frame.point(r.px, r.py).x * W);
const partnerY = positionExpr(runs, (r) => frame.point(r.px, r.py).y * H);
const at = (expr: string) => `(${expr})-overlay_w/2`;
const atY = (expr: string) => `(${expr})-overlay_h/2`;

// Radius follows what serve-sim draws on screen: its 24px indicator over a
// ~266px wide surface is ~9% of the width, which is ~54px at this resolution.
// Baked to PNG once rather than left as lavfi sources: geq is per-pixel, and
// leaving it in the graph re-renders every sprite for every frame of the movie.
//
// Two sprites, not three. The pinch partner is the resting marker, so the
// filtergraph splits that one input in two rather than rendering a duplicate.
const sprites = mkdtempSync(join(tmpdir(), "serve-sim-cursor-"));
const spriteFiles = [
  ["cursor.png", sprite(MARKER.cursor)],
  ["press.png", sprite(MARKER.press)],
].map(([name, spec]) => {
  const path = join(sprites, name!);
  const made = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error",
    "-f", "lavfi", "-i", spec!,
    "-frames:v", "1", path,
  ]);
  if (made.exitCode !== 0) throw new Error(`Could not render ${name}`);
  return path;
});

/** Holds the first and last frame over the stretches simctl never wrote. */
function padFilter(): string {
  const parts: string[] = [];
  if (headPadMs > 0) parts.push(`start_mode=clone:start_duration=${(headPadMs / 1000).toFixed(3)}`);
  if (tailPadMs > 0) parts.push(`stop_mode=clone:stop_duration=${(tailPadMs / 1000).toFixed(3)}`);
  return parts.length ? `tpad=${parts.join(":")},` : "";
}

const filter = [
  // simctl wrote frames only when the screen changed, and even the native
  // recorder skips a slot when its encoder is busy. Left alone, the still image
  // inputs drag the graph's output rate down and frames get dropped.
  // Resampling to a constant rate up front fixes that and gives the position
  // expressions an even grid to be evaluated on.
  `[0:v]${padFilter()}fps=${OUTPUT_FPS}[base]`,
  `[1:v]split=2[cur][mir]`,
  // A pinch keeps the button down throughout, so the press styling is held
  // back while the pair is up and both fingers stay the resting marker.
  `[base][cur]overlay=x='${at(px)}':y='${atY(py)}':enable='${enableExpr(runs, (r) => r.over && (!r.pressed || r.alt))}'[a]`,
  `[a][2:v]overlay=x='${at(px)}':y='${atY(py)}':enable='${enableExpr(runs, (r) => r.pressed && !r.alt)}'[b]`,
  `[b][mir]overlay=x='${at(partnerX)}':y='${atY(partnerY)}':enable='${enableExpr(runs, (r) => r.pair)}'[out]`,
].join(";");

const outPath = join(dir, cursorMovieName(movieName));
// Rendered under a hidden name and moved into place at the end, so nothing can
// pick up a half-written movie: the page's Finder card reveals the render
// whenever it exists, and falls back to the source until then.
const partPath = join(dir, `.${basename(outPath)}`);
const args = [
  "-y",
  "-i", moviePath,
  ...spriteFiles.flatMap((path) => ["-i", path]),
  "-filter_complex", filter,
  "-map", "[out]",
  // Hardware encode: a 1206x2622 frame through libx264 at a quality preset runs
  // slower than real time by a wide margin, and this is a re-encode of an
  // already-compressed capture, so the extra fidelity buys nothing. The bitrate
  // sits above what the recorder produced so the overlay pass is not the weak link.
  "-c:v", "h264_videotoolbox",
  "-b:v", "30M",
  "-tag:v", "avc1",
  "-pix_fmt", "yuv420p",
  partPath,
];

console.log(`capture   ${dir}`);
console.log(`events    ${track.events.length} -> ${runs.length} runs`);
const how = anchored
  ? "from the timestamps, nothing estimated"
  : "movieStartedAt" in track
    ? "TAILS ALIGNED: the recorder never reported its first frame, so this is off by " +
      "however long the screen sat still before the stop"
    : "tails aligned, this capture predates the timestamp";
// The measured shift, not what survives the padding. Holding the head moves
// the movie's zero onto the track's, so the residual is always zero on an
// anchored capture and printing it said nothing at all.
console.log(`offset    ${Math.round(offsetMs)}ms (${how})`);
if (headPadMs > 0 || tailPadMs > 0) {
  console.log(
    `padded    ${Math.round(headPadMs)}ms at the head, ${Math.round(tailPadMs)}ms at the tail ` +
      `(the screen was still and simctl wrote nothing)`,
  );
}


const proc = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-stats", ...args], {
  stdout: "inherit",
  stderr: "inherit",
});
rmSync(sprites, { recursive: true, force: true });
if (proc.exitCode !== 0) {
  rmSync(partPath, { force: true });
  process.exit(proc.exitCode ?? 1);
}
renameSync(partPath, outPath);
console.log(`wrote     ${outPath}`);
