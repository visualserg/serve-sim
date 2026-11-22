import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostRpcHandler, type RunResult } from "../host-rpc";

// fork: Open in Finder on a cursor capture shows the render once the overlay
// has written it (the `fork:` seam in revealRecording).

const NAME = "serve-sim-recording-2026-11-22-14-42-09.mp4";
const RENDER = "serve-sim-recording-2026-11-22-14-42-09-with-cursor.mp4";

let home: string;
let folder: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "serve-sim-fork-reveal-")));
  folder = join(home, "Downloads", "serve-sim-2026-11-22-14-42-09");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, NAME), "mp4");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function handler() {
  const calls: Array<[string, string[]]> = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    homeDir: home,
    isKnownDevice: async () => true,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls };
}

describe("revealRecording on a cursor capture", () => {
  test("shows the movie while the overlay is still running", async () => {
    const { rpc, calls } = handler();
    await rpc({ method: "revealRecording", params: { path: join(folder, NAME) } });
    expect(calls).toEqual([["open", ["-R", join(folder, NAME)]]]);
  });

  test("shows the render once it is there", async () => {
    writeFileSync(join(folder, RENDER), "mp4");
    const { rpc, calls } = handler();
    await rpc({ method: "revealRecording", params: { path: join(folder, NAME) } });
    expect(calls).toEqual([["open", ["-R", join(folder, RENDER)]]]);
  });

  test("ignores a render that is not a file", async () => {
    mkdirSync(join(folder, RENDER));
    const { rpc, calls } = handler();
    await rpc({ method: "revealRecording", params: { path: join(folder, NAME) } });
    expect(calls).toEqual([["open", ["-R", join(folder, NAME)]]]);
  });
});
