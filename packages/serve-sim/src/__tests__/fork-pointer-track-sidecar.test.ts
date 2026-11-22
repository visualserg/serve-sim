import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { pointerTrackSidecar } from "../client/fork/pointer-track";
import type { PointerTrackUpload } from "../fork/pointer-track-format";

const GLOBALS = ["window", "document", "MouseEvent", "KeyboardEvent"] as const;
let dom: Window;
let previous: Map<string, unknown>;

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  // A 200x400 surface at the page origin, standing in for the stream.
  const surface = dom.document.createElement("div");
  surface.setAttribute("data-testid", "simulator-surface");
  surface.dataset.orientation = "portrait";
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as never;
  dom.document.body.appendChild(surface);
});

afterEach(async () => {
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

function move(clientX: number, clientY: number) {
  dom.dispatchEvent(new dom.MouseEvent("mousemove", { clientX, clientY }));
}

describe("pointerTrackSidecar", () => {
  test("asks for the recording index, which is where the movie's clock comes from", () => {
    expect(pointerTrackSidecar().startQuery).toEqual({ index: "1" });
  });

  test("places t=0 on the server's clock, taking the server's own work out of the round trip", () => {
    const sidecar = pointerTrackSidecar();
    sidecar.begin();
    move(100, 100);
    // 130ms there and back, 100ms of it spent in the server: 15ms each way.
    sidecar.started({
      startedAt: "2026-11-22T10:00:00.500Z",
      respondedAt: "2026-11-22T10:00:00.600Z",
      roundTripMs: 130,
    });
    const upload = JSON.parse(sidecar.finish()!) as PointerTrackUpload;
    expect(upload.startedAt).toBe("2026-11-22T10:00:00.485Z");
    expect(upload.version).toBe(1);
    expect(upload.events).toHaveLength(1);
    expect(upload.events[0]).toMatchObject({ e: "move", x: 0.5, y: 0.25, over: true });
  });

  test("halves the whole trip against a server that does not say when it answered", () => {
    const sidecar = pointerTrackSidecar();
    sidecar.begin();
    move(10, 10);
    sidecar.started({ startedAt: "2026-11-22T10:00:00.500Z", roundTripMs: 40 });
    expect((JSON.parse(sidecar.finish()!) as PointerTrackUpload).startedAt).toBe("2026-11-22T10:00:00.480Z");
  });

  test("sends nothing when there is nothing to draw, or no stamp to anchor it", () => {
    const quiet = pointerTrackSidecar();
    quiet.begin();
    quiet.started({ startedAt: "2026-11-22T10:00:00.500Z", roundTripMs: 10 });
    expect(quiet.finish()).toBeNull();

    const unanchored = pointerTrackSidecar();
    unanchored.begin();
    move(10, 10);
    unanchored.started({ roundTripMs: 10 });
    expect(unanchored.finish()).toBeNull();
  });

  test("an aborted track stops listening and is gone", () => {
    const sidecar = pointerTrackSidecar();
    sidecar.begin();
    move(10, 10);
    sidecar.started({ startedAt: "2026-11-22T10:00:00.500Z", roundTripMs: 10 });
    sidecar.abort();
    move(20, 20);
    expect(sidecar.finish()).toBeNull();
  });
});
