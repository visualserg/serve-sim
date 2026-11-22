import { describe, expect, test } from "bun:test";
import { createForkRecording } from "../client/fork/recording";

// fork: the page's side of a cursor capture (client/fork/recording.ts).

const SAVED = "/Users/ü/Downloads/serve-sim-2026-11-22-14-42-09/serve-sim-recording-2026-11-22-14-42-09.mp4";
const NAME = "serve-sim-recording-2026-11-22-14-42-09.mp4";

const headers = (capture?: string) =>
  new Headers(capture ? { "X-Serve-Sim-Capture": encodeURIComponent(capture) } : {});

describe("createForkRecording", () => {
  test("asks for the recording index, which is where the movie's clock comes from", () => {
    expect(createForkRecording().sidecar.startQuery).toEqual({ index: "1" });
  });

  test("reads where the server saved the movie, and hands that to the Finder card", async () => {
    const asked: string[] = [];
    const fork = createForkRecording({ fallbackLocate: async (name) => { asked.push(name); return ""; } });
    expect(fork.sidecar.collected!(headers(SAVED))).toBe(SAVED);
    expect(await fork.locate(NAME)).toBe(SAVED);
    expect(asked).toEqual([]);
  });

  test("leaves everything else to upstream's download lookup", async () => {
    const fork = createForkRecording({ fallbackLocate: async (name) => `/Users/x/Downloads/${name}` });
    expect(fork.sidecar.collected!(headers())).toBeNull();
    expect(await fork.locate("serve-sim-recording-1.mp4")).toBe("/Users/x/Downloads/serve-sim-recording-1.mp4");
  });

  test("ignores a header that is not a host path", () => {
    const fork = createForkRecording({ fallbackLocate: async () => "" });
    expect(fork.sidecar.collected!(new Headers({ "X-Serve-Sim-Capture": "%E0%A4%A" }))).toBeNull();
    expect(fork.sidecar.collected!(headers("relative/movie.mp4"))).toBeNull();
  });
});
