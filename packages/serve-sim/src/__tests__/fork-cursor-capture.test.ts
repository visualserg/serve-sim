import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  captureFolderName,
  makeCaptureDir,
  parseCursorTrack,
  saveCursorCapture,
  CAPTURE_TRACK_NAME,
} from "../fork/cursor-capture";
import { cursorMovieName } from "../fork/pointer-track-format";
import type { NativeRecordingIndex } from "../recording-index";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-cursor-test-"));
  scratch.push(dir);
  return dir;
}

const TRACK = {
  version: 1,
  startedAt: "2026-11-22T10:00:00.000Z",
  video: { width: 1206, height: 2622 },
  pinch: "px/py carry the second finger",
  events: [
    { t: 0, e: "move", x: 0.5, y: 0.5, over: true, alt: false },
    { t: 40, e: "down", x: 0.5, y: 0.5, over: true, alt: false, b: 0 },
  ],
};

/** Native summary with an index whose first frame lands 250ms after arming. */
function nativeSummary(armedWallMs: number, extra: Record<string, unknown> = {}): string {
  const index: NativeRecordingIndex = {
    version: 1,
    fps: 60,
    clock: { armedUptime: 1000, armedWallMs, originUptime: 1000.25 },
    slots: [0, 1],
    uptimesUs: [1_000_250_000, 1_000_266_667],
    changed: [1, 1],
    truncated: false,
  };
  return JSON.stringify({ width: 1206, height: 2622, fps: 60, duration: 1, rotation: 0, ...extra, index });
}

describe("parseCursorTrack", () => {
  test("accepts the track the page sends", () => {
    expect(parseCursorTrack(JSON.stringify(TRACK))).toEqual(TRACK as never);
  });

  test("rejects anything that is not a track, instead of saving it", () => {
    expect(parseCursorTrack("")).toBeNull();
    expect(parseCursorTrack("not json")).toBeNull();
    expect(parseCursorTrack("null")).toBeNull();
    expect(parseCursorTrack(JSON.stringify({ ...TRACK, version: 2 }))).toBeNull();
    expect(parseCursorTrack(JSON.stringify({ ...TRACK, events: "nope" }))).toBeNull();
    expect(parseCursorTrack(JSON.stringify({ ...TRACK, startedAt: "yesterday" }))).toBeNull();
    const { startedAt: _, ...unanchored } = TRACK;
    expect(parseCursorTrack(JSON.stringify(unanchored))).toBeNull();
  });
});

describe("capture folders", () => {
  test("are serve-sim- and the local date and time, to the second", () => {
    expect(captureFolderName(new Date(2026, 7, 1, 1, 4, 9))).toBe("serve-sim-2026-08-01-01-04-09");
  });

  test("step aside instead of sharing a folder when a second holds two takes", async () => {
    const downloads = tempDir();
    const at = new Date(2026, 7, 1, 1, 4, 9);
    const first = await makeCaptureDir(downloads, at);
    const second = await makeCaptureDir(downloads, at);
    expect(first).toBe(join(downloads, "serve-sim-2026-08-01-01-04-09"));
    expect(second).toBe(join(downloads, "serve-sim-2026-08-01-01-04-09_2"));
    expect(existsSync(second)).toBe(true);
  });
});

describe("cursorMovieName", () => {
  test("names the render after its movie, so it sorts beside it", () => {
    expect(cursorMovieName("serve-sim-recording-2026-11-22-14-42-09.mp4"))
      .toBe("serve-sim-recording-2026-11-22-14-42-09-with-cursor.mp4");
    // The simctl captures from before the merge keep the name they always had.
    expect(cursorMovieName("recording.mov")).toBe("recording-with-cursor.mov");
  });
});

describe("saveCursorCapture", () => {
  test("puts the movie and the anchored track side by side, then hands the folder to the overlay", async () => {
    const downloads = tempDir();
    const movie = join(tempDir(), "native.mp4");
    writeFileSync(movie, "fake-mp4");
    const armedWallMs = Date.parse("2026-11-22T10:00:00.100Z");
    const overlays: string[] = [];

    const saved = await saveCursorCapture({
      device: "TEST-UDID",
      moviePath: movie,
      track: parseCursorTrack(JSON.stringify(TRACK))!,
      summary: nativeSummary(armedWallMs, { rotation: 90 }),
      deps: { capturesDir: downloads, now: () => new Date(2026, 10, 22, 13, 0, 5), spawnOverlay: (d) => overlays.push(d) },
    });

    const dir = join(downloads, "serve-sim-2026-11-22-13-00-05");
    // Named the way a toolbar download is, which is what lets the page's
    // Finder card reveal it and drag it onto the simulator.
    const movieName = "serve-sim-recording-2026-11-22-13-00-05.mp4";
    expect(saved).toEqual({ dir, moviePath: join(dir, movieName) });
    expect(readFileSync(join(dir, movieName), "utf-8")).toBe("fake-mp4");
    // The source is left alone: the server still streams it to the page.
    expect(existsSync(movie)).toBe(true);

    const track = JSON.parse(readFileSync(join(dir, CAPTURE_TRACK_NAME), "utf-8"));
    expect(track).toMatchObject({
      version: 1,
      movie: movieName,
      source: "native",
      device: "TEST-UDID",
      startedAt: TRACK.startedAt,
      // pts 0 is the first frame's capture uptime moved onto the wall clock:
      // armed at 10:00:00.100, first frame 250ms of uptime later.
      movieStartedAt: "2026-11-22T10:00:00.350Z",
      rotation: 90,
      video: TRACK.video,
      events: TRACK.events,
    });
    expect(overlays).toEqual([dir]);
  });

  test("still saves the track when the recorder placed no frame, leaving the anchor empty", async () => {
    const downloads = tempDir();
    const movie = join(tempDir(), "native.mp4");
    writeFileSync(movie, "fake-mp4");

    const { dir } = await saveCursorCapture({
      device: "TEST-UDID",
      moviePath: movie,
      track: parseCursorTrack(JSON.stringify(TRACK))!,
      summary: JSON.stringify({ width: 1206, height: 2622 }),
      deps: { capturesDir: downloads, spawnOverlay: () => {} },
    });

    const saved = JSON.parse(readFileSync(join(dir, CAPTURE_TRACK_NAME), "utf-8"));
    expect(saved.movieStartedAt).toBeNull();
    expect(saved.rotation).toBe(0);
  });
});
