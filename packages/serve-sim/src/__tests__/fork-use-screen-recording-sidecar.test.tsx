import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useScreenRecording } from "../client/hooks/use-screen-recording";
import type { RecordingSidecar } from "../client/fork/recording-sidecar";

// fork: the sidecar that carries the cursor track alongside recordings the
// toolbar starts. Same harness as use-screen-recording.test.tsx, plus request
// bodies.

type Call = { method: string; path: string; body?: string; contentType?: string };
type Handler = (call: Call) => Response | Promise<Response>;

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let root: Root | undefined;
let previous: Map<string, unknown>;
let realFetch: typeof fetch;
let realCreate: typeof URL.createObjectURL;
let calls: Call[];
let handler: Handler;
let hook: ReturnType<typeof useScreenRecording>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  (dom as unknown as { __SIM_PREVIEW__: unknown }).__SIM_PREVIEW__ = { basePath: "/" };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  handler = () => json({ recording: false });
  realFetch = globalThis.fetch;
  realCreate = URL.createObjectURL;
  downloaded = [];
  objectUrls = 0;
  URL.createObjectURL = () => {
    objectUrls++;
    return "blob:test";
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: String(input),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(headers.get("content-type") ? { contentType: headers.get("content-type")! } : {}),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

type Log = Array<string | { started: Parameters<RecordingSidecar["started"]>[0] }>;

function recordingSidecar(log: Log, body: string | null = '{"track":1}'): RecordingSidecar {
  return {
    startQuery: { index: "1" },
    begin: () => log.push("begin"),
    started: (timing) => log.push({ started: timing }),
    abort: () => log.push("abort"),
    finish: () => {
      log.push("finish");
      return body;
    },
    collected: (headers) => {
      const saved = headers.get("x-serve-sim-capture");
      return saved ? decodeURIComponent(saved) : null;
    },
  };
}

type Downloaded = { fileName: string; blob: Blob };
let downloaded: Downloaded[];
let objectUrls: number;

function Harness({ device, pollMs, sidecar }: { device: string | null; pollMs: number; sidecar?: RecordingSidecar }) {
  hook = useScreenRecording(device, { pollMs, onDownloaded: (d) => downloaded.push(d), sidecar });
  return null;
}

async function render(device: string | null, sidecar?: RecordingSidecar, pollMs = 60_000) {
  await act(async () => {
    if (!root) root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    root.render(<Harness device={device} pollMs={pollMs} sidecar={sidecar} />);
  });
  await flush();
}

async function flush(ms = 5) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const STARTED = "2026-11-22T10:00:00.000Z";
const RESPONDED = "2026-11-22T10:00:00.120Z";

/** A server that records once started and hands back an MP4 on stop. */
function recordingServer(capturePath?: string) {
  let recording = false;
  return ({ method, path }: Call) => {
    if (path.includes("/recording/start")) {
      recording = true;
      return json({ recording: true, startedAt: STARTED, respondedAt: RESPONDED, token: "T" });
    }
    if (path.includes("/recording/stop")) {
      recording = false;
      return new Response("mp4", {
        headers: {
          "content-type": "video/mp4",
          "content-disposition": 'attachment; filename="a.mp4"',
          ...(capturePath ? { "x-serve-sim-capture": encodeURIComponent(capturePath) } : {}),
        },
      });
    }
    if (method === "GET") return json(recording ? { recording: true, startedAt: STARTED } : { recording: false });
    return json({});
  };
}

describe("useScreenRecording sidecar", () => {
  test("starts with the sidecar's query, after telling it, and reports the server's stamps", async () => {
    const log: Log = [];
    handler = recordingServer();
    await render("A", recordingSidecar(log));

    await act(async () => { await hook.start(); });

    const start = calls.find((c) => c.method === "POST" && c.path.includes("/recording/start"))!;
    expect(start.path).toBe("/helper/A/recording/start?index=1");
    expect(log[0]).toBe("begin");
    const started = log[1] as { started: Parameters<RecordingSidecar["started"]>[0] };
    expect(started.started.startedAt).toBe(STARTED);
    expect(started.started.respondedAt).toBe(RESPONDED);
    expect(started.started.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(hook.state.status).toBe("recording");
  });

  test("its own stop carries the sidecar's body as JSON, next to the token", async () => {
    const log: Log = [];
    handler = recordingServer();
    await render("A", recordingSidecar(log));
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });

    const stop = calls.find((c) => c.path.includes("/recording/stop"))!;
    expect(stop.path).toBe("/helper/A/recording/stop?token=T");
    expect(stop.body).toBe('{"track":1}');
    expect(stop.contentType).toBe("application/json");
    expect(log).toContain("finish");
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("a sidecar with nothing to say sends a bare stop", async () => {
    handler = recordingServer();
    await render("A", recordingSidecar([], null));
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });
    const stop = calls.find((c) => c.path.includes("/recording/stop"))!;
    expect(stop.body).toBeUndefined();
    expect(stop.contentType).toBeUndefined();
  });

  test("a refused start lets the sidecar go", async () => {
    const log: Log = [];
    handler = ({ method, path }) => {
      if (path.includes("/recording/start")) return json({ error: "already_recording" }, 409);
      if (method === "GET") return json({ recording: false });
      return json({});
    };
    await render("A", recordingSidecar(log));
    await act(async () => { await hook.start(); });
    expect(log).toEqual(["begin", "abort"]);
  });

  test("a recording stopped elsewhere lets the sidecar go", async () => {
    const log: Log = [];
    let recording = false;
    handler = ({ method, path }) => {
      if (path.includes("/recording/start")) {
        recording = true;
        return json({ recording: true, startedAt: STARTED, respondedAt: RESPONDED, token: "T" });
      }
      if (method === "GET") return json(recording ? { recording: true, startedAt: STARTED } : { recording: false });
      return json({});
    };
    await render("A", recordingSidecar(log), 10);
    await act(async () => { await hook.start(); });
    recording = false; // another tab, or the CLI, stopped it
    await flush(40);
    expect(log).toContain("abort");
    expect(log).not.toContain("finish");
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("leaving the device mid-recording lets the sidecar go", async () => {
    const log: Log = [];
    handler = recordingServer();
    const sidecar = recordingSidecar(log);
    await render("A", sidecar);
    await act(async () => { await hook.start(); });
    await render("B", sidecar);
    expect(log).toContain("abort");
  });

  test("without a sidecar nothing changes: no query, no body", async () => {
    handler = recordingServer();
    await render("A");
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });
    expect(calls.find((c) => c.path.includes("/recording/start"))!.path).toBe("/helper/A/recording/start");
    expect(calls.find((c) => c.path.includes("/recording/stop"))!.body).toBeUndefined();
  });

  test("a movie the server already saved is not downloaded a second time", async () => {
    const saved = "/Users/ü/Downloads/serve-sim-2026-11-22-14-42-09/serve-sim-recording-2026-11-22-14-42-09.mp4";
    handler = recordingServer(saved);
    await render("A", recordingSidecar([]));
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });

    // The card still shows, under the saved name, which is what the fork's
    // `locate` maps back to the folder.
    expect(objectUrls).toBe(0);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.fileName).toBe("serve-sim-recording-2026-11-22-14-42-09.mp4");
    expect(await downloaded[0]!.blob.text()).toBe("mp4");
  });

  test("without a saved capture the browser downloads it, as upstream does", async () => {
    handler = recordingServer();
    await render("A", recordingSidecar([]));
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });

    expect(objectUrls).toBe(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.fileName).toBe("a.mp4");
  });
});
