import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamSettingsTool } from "../client/components/stream-settings-tool";
import {
  HIDE_RESIZE_HANDLE_STORAGE_KEY,
  installForkViewer,
  setResizeHandleHidden,
} from "../client/fork/viewer";

// fork: the viewer tweaks laid over upstream's preview (client/fork/viewer.ts),
// and the Stream row that switches the resize handle.

const GLOBALS = ["window", "document", "MouseEvent", "localStorage"] as const;
let dom: Window;
let previous: Map<string, unknown>;

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
});

afterEach(async () => {
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

function surfaceWithLayer() {
  const surface = dom.document.createElement("div");
  surface.setAttribute("data-testid", "simulator-surface");
  const layer = dom.document.createElement("div");
  surface.appendChild(layer);
  dom.document.body.appendChild(surface);
  return { surface, layer };
}

function press(target: { dispatchEvent(e: unknown): boolean }, init: { altKey?: boolean; button?: number } = {}) {
  target.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, ...init }));
}

function release() {
  dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
}

describe("installForkViewer", () => {
  test("adds its stylesheet once, however often it is called", () => {
    installForkViewer();
    installForkViewer();
    const styles = dom.document.querySelectorAll("style#serve-sim-fork-viewer");
    expect(styles.length).toBe(1);
    const css = styles[0]!.textContent ?? "";
    // Upstream's blue dot goes; the pointer darkens instead.
    expect(css).toContain('[data-testid="touch-indicator"] { display: none !important; }');
    expect(css).toContain("[data-fork-pressed] * { cursor:");
    expect(css).toContain("[data-fork-hide-resize-handle] [data-sim-resize-handle] { display: none !important; }");
  });

  test("marks the surface pressed for a plain press, until the button comes up", () => {
    installForkViewer();
    const { surface, layer } = surfaceWithLayer();
    press(layer);
    expect(surface.hasAttribute("data-fork-pressed")).toBe(true);
    release();
    expect(surface.hasAttribute("data-fork-pressed")).toBe(false);
  });

  test("leaves option-drags and presses elsewhere alone", () => {
    installForkViewer();
    const { surface, layer } = surfaceWithLayer();
    press(layer, { altKey: true });
    expect(surface.hasAttribute("data-fork-pressed")).toBe(false);
    press(dom.document.body);
    expect(surface.hasAttribute("data-fork-pressed")).toBe(false);
  });
});

describe("resize handle preference", () => {
  test("is remembered and shows on the page as an attribute the stylesheet keys on", () => {
    installForkViewer();
    const root = dom.document.documentElement;
    expect(root.hasAttribute("data-fork-hide-resize-handle")).toBe(false);

    setResizeHandleHidden(true);
    expect(dom.localStorage.getItem(HIDE_RESIZE_HANDLE_STORAGE_KEY)).toBe("1");
    expect(root.hasAttribute("data-fork-hide-resize-handle")).toBe(true);

    setResizeHandleHidden(false);
    expect(dom.localStorage.getItem(HIDE_RESIZE_HANDLE_STORAGE_KEY)).toBe("0");
    expect(root.hasAttribute("data-fork-hide-resize-handle")).toBe(false);
  });

  test("a hide saved by an earlier page applies as soon as the viewer installs", () => {
    dom.localStorage.setItem(HIDE_RESIZE_HANDLE_STORAGE_KEY, "1");
    installForkViewer();
    expect(dom.document.documentElement.hasAttribute("data-fork-hide-resize-handle")).toBe(true);
  });
});

describe("Stream settings", () => {
  test("upstream's section carries the fork's resize-handle switch", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool preference="auto" onPreferenceChange={() => {}} activeCodec="h264" avccSupported />,
    );
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Resize handle"/);
  });
});
