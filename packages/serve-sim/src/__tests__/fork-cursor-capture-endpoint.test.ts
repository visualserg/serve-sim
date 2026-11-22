import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import type { RecordingStartOptions } from "../native";
import type { NativeRecordingIndex } from "../recording-index";
import { CAPTURE_HEADER, CAPTURE_TRACK_NAME } from "../fork/cursor-capture";

const servers: Server[] = [];
const sessions: DeviceSession[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-cursor-endpoint-"));
  scratch.push(dir);
  return dir;
}

function fakeCapture(starts: RecordingStartOptions[]): DeviceSessionDependencies["capture"] {
  let active: { path: string; armedWallMs: number; index: boolean } | undefined;
  return {
    start: async () => {},
    stop: async () => {},
    subscribeMjpeg: async () => () => {},
    subscribeAvcc: async () => () => {},
    subscribeSize: async () => () => {},
    snapshotJpeg: async () => null,
    setPreferredScreenSize: async () => {},
    startRecording: async (path, options) => {
      starts.push(options);
      active = { path, armedWallMs: Date.now(), index: options.index === true };
    },
    stopRecording: async () => {
      const { path, armedWallMs, index: wantIndex } = active!;
      active = undefined;
      writeFileSync(path, Buffer.from("fake-mp4"));
      const index: NativeRecordingIndex = {
        version: 1,
        fps: 60,
        clock: { armedUptime: 500, armedWallMs, originUptime: 500.1 },
        slots: [0],
        uptimesUs: [500_100_000],
        changed: [1],
        truncated: false,
      };
      return JSON.stringify({ path, width: 1206, height: 2622, fps: 60, duration: 1, rotation: 0, ...(wantIndex ? { index } : {}) });
    },
  };
}

function hid(): DeviceSessionDependencies["hid"] {
  return {
    touch: async () => {},
    multiTouch: async () => {},
    button: async () => {},
    buttonHid: async () => {},
    key: async () => {},
    scroll: async () => {},
    digitalCrown: async () => {},
    orientation: async () => false,
    memoryWarning: async () => {},
    softwareKeyboard: async () => {},
    caDebug: async () => false,
    hardwareKeyboard: async () => false,
    pose: async () => false,
    hinge: async () => false,
  };
}

async function serve(session: DeviceSession): Promise<string> {
  sessions.push(session);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/recording/start") void session.handleRecording(req, res, "start");
    else if (path === "/recording/stop") void session.handleRecording(req, res, "stop");
    else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function setup() {
  const downloads = tempDir();
  const overlays: string[] = [];
  const starts: RecordingStartOptions[] = [];
  const session = new DeviceSession("TEST-UDID", {
    capture: fakeCapture(starts),
    hid: hid(),
    cursorCapture: { capturesDir: downloads, spawnOverlay: (dir) => overlays.push(dir) },
  });
  return { downloads, overlays, starts, session };
}

const TRACK = {
  version: 1,
  startedAt: new Date().toISOString(),
  video: { width: 1206, height: 2622 },
  pinch: "px/py",
  events: [{ t: 0, e: "move", x: 0.25, y: 0.75, over: true, alt: false }],
};

describe("cursor capture on the native recorder", () => {
  test("start says when it answered, so the page can take the server's work out of the round trip", async () => {
    const { session } = setup();
    const base = await serve(session);
    const body = await (await fetch(`${base}/recording/start`, { method: "POST" })).json() as {
      startedAt: string;
      respondedAt: string;
    };
    expect(Date.parse(body.respondedAt)).toBeGreaterThanOrEqual(Date.parse(body.startedAt));
  });

  test("a stop carrying a pointer track leaves a capture folder and says where the movie went", async () => {
    const { downloads, overlays, starts, session } = setup();
    const base = await serve(session);
    await fetch(`${base}/recording/start?index=1`, { method: "POST" });
    expect(starts[0]!.index).toBe(true);

    const res = await fetch(`${base}/recording/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TRACK),
    });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");

    const folders = readdirSync(downloads);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^serve-sim-\d{4}(-\d{2}){5}$/);
    const dir = join(downloads, folders[0]!);
    // The page reads the path to skip its own download and point the Finder
    // card at the folder; encoded, since a home directory need not be ASCII.
    const moviePath = decodeURIComponent(res.headers.get(CAPTURE_HEADER) ?? "");
    expect(moviePath.startsWith(`${dir}/serve-sim-recording-`)).toBe(true);
    expect(readFileSync(moviePath, "utf-8")).toBe("fake-mp4");
    const saved = JSON.parse(readFileSync(join(dir, CAPTURE_TRACK_NAME), "utf-8"));
    expect(saved.events).toEqual(TRACK.events);
    expect(saved.device).toBe("TEST-UDID");
    expect(typeof saved.movieStartedAt).toBe("string");
    expect(overlays).toEqual([dir]);
  });

  test("a plain stop (CLI, another tab) leaves no folder behind", async () => {
    const { downloads, overlays, session } = setup();
    const base = await serve(session);
    await fetch(`${base}/recording/start?index=1`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get(CAPTURE_HEADER)).toBeNull();
    await res.arrayBuffer();
    expect(readdirSync(downloads)).toEqual([]);
    expect(overlays).toEqual([]);
  });

  test("a track that does not parse never costs the recording", async () => {
    const { downloads, session } = setup();
    const base = await serve(session);
    await fetch(`${base}/recording/start?index=1`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
    expect(res.headers.get(CAPTURE_HEADER)).toBeNull();
    expect(readdirSync(downloads)).toEqual([]);
  });

  test("a capture that cannot be written never costs the recording either", async () => {
    const starts: RecordingStartOptions[] = [];
    const blocked = join(tempDir(), "not-a-folder");
    writeFileSync(blocked, "a file where Downloads should be");
    const session = new DeviceSession("TEST-UDID", {
      capture: fakeCapture(starts),
      hid: hid(),
      cursorCapture: { capturesDir: blocked, spawnOverlay: () => {} },
    });
    const base = await serve(session);
    await fetch(`${base}/recording/start?index=1`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TRACK),
    });
    expect(res.status).toBe(200);
    // No folder, so no header: the page falls back to its own download.
    expect(res.headers.get(CAPTURE_HEADER)).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
    expect(existsSync(blocked)).toBe(true);
  });
});
