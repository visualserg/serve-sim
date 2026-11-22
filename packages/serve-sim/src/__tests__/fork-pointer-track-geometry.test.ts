import { describe, expect, test } from "bun:test";
import { displayFrame, trackAlignment } from "../fork/pointer-track-geometry";
import { rawPointForDisplayPoint } from "../client/simulator/orientation";
import type { PointerSample } from "../fork/pointer-track-format";

const events = (...ts: number[]): PointerSample[] =>
  ts.map((t) => ({ t, e: "move", x: 0.5, y: 0.5, over: true, alt: false }));

describe("trackAlignment", () => {
  test("native: the shift is the two stamps' difference, and the movie is not padded", () => {
    // Tracking started 120ms before the recorder placed its first frame.
    const aligned = trackAlignment({
      source: "native",
      startedAt: "2026-11-22T10:00:00.000Z",
      movieStartedAt: "2026-11-22T10:00:00.120Z",
      events: events(0, 500, 4900),
    }, 4800);
    expect(aligned).toEqual({ offsetMs: -120, headPadMs: 0, tailPadMs: 0, anchored: true });
  });

  test("simctl: still stretches it never wrote are restored at both ends", () => {
    // The movie started 300ms after tracking and stopped writing 8s early.
    const aligned = trackAlignment({
      startedAt: "2026-08-01T01:04:00.000Z",
      movieStartedAt: "2026-08-01T01:04:00.300Z",
      events: events(0, 13_000),
    }, 4_700);
    expect(aligned).toEqual({ offsetMs: -300, headPadMs: 300, tailPadMs: 8_000, anchored: true });
  });

  test("with no anchor the tails are lined up and nothing is padded", () => {
    const aligned = trackAlignment({ startedAt: "2026-08-01T01:04:00.000Z", movieStartedAt: null, events: events(0, 3000) }, 2500);
    expect(aligned).toEqual({ offsetMs: -500, headPadMs: 0, tailPadMs: 0, anchored: false });
  });
});

describe("displayFrame", () => {
  test("an upright movie is drawn on as recorded", () => {
    const frame = displayFrame(0, 1206, 2622);
    expect(frame.width).toBe(1206);
    expect(frame.height).toBe(2622);
    expect(frame.point(0.25, 0.75)).toEqual({ x: 0.25, y: 0.75 });
  });

  // The movie carries its rotation as a track transform, and ffmpeg turns the
  // frames upright before the overlay sees them. The track is in raw
  // framebuffer space, so each point has to make the same turn: exactly the
  // inverse of the rule the page applied going the other way.
  for (const [rotation, orientation] of [[90, "landscape_left"], [-90, "landscape_right"], [180, "portrait_upside_down"]] as const) {
    test(`${rotation}°: undoes the page's ${orientation} mapping`, () => {
      const frame = displayFrame(rotation, 1206, 2622);
      for (const [dx, dy] of [[0, 0], [1, 0], [0.2, 0.7], [0.9, 0.1]] as const) {
        const raw = rawPointForDisplayPoint(orientation, dx, dy);
        const back = frame.point(raw.x, raw.y);
        expect(back.x).toBeCloseTo(dx, 9);
        expect(back.y).toBeCloseTo(dy, 9);
      }
    });
  }

  test("a sideways turn swaps the frame's sides; a half turn does not", () => {
    expect(displayFrame(90, 1206, 2622)).toMatchObject({ width: 2622, height: 1206 });
    expect(displayFrame(-90, 1206, 2622)).toMatchObject({ width: 2622, height: 1206 });
    expect(displayFrame(270, 1206, 2622)).toMatchObject({ width: 2622, height: 1206 });
    expect(displayFrame(180, 1206, 2622)).toMatchObject({ width: 1206, height: 2622 });
  });
});
