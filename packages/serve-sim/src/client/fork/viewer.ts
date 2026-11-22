// fork: viewer tweaks laid over upstream's preview with one stylesheet and a
// couple of window listeners, so SimulatorView and client.tsx keep their
// upstream shape. They hang off attributes upstream already renders
// (`touch-indicator`, `data-sim-resize-handle`) plus the surface's
// `simulator-surface` tag, which a `fork:` seam in SimulatorView adds.
//
// - A press darkens the pointer instead of dropping upstream's blue dot under
//   it: the pointer already says where the touch is, and two overlapping
//   circles read as two fingers.
// - The corner grip that resizes the simulator can be hidden. It sits over the
//   bottom right of the screen, which is exactly where it is in the way once
//   the bezel is off and the stream runs edge to edge.

import { useSyncExternalStore } from "react";

const SURFACE = '[data-testid="simulator-surface"]';
const PRESSED_ATTR = "data-fork-pressed";
const HIDE_HANDLE_ATTR = "data-fork-hide-resize-handle";
const STYLE_ID = "serve-sim-fork-viewer";

/** Viewer preference, kept under the key the fork has always used. */
export const HIDE_RESIZE_HANDLE_STORAGE_KEY = "serve-sim:hide-resize-handle";

/** Upstream's finger cursor, a shade darker and more solid. */
const PRESSED_CURSOR =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(125,125,125,0.6)' stroke='rgba(0,0,0,0.7)' stroke-width='1.25' filter='drop-shadow(0 1px 2px rgba(0,0,0,0.45))'/%3E%3C/svg%3E") 12 12, pointer`;

const CSS = `
[data-testid="touch-indicator"] { display: none !important; }
${SURFACE}[${PRESSED_ATTR}] * { cursor: ${PRESSED_CURSOR} !important; }
html[${HIDE_HANDLE_ATTR}] [data-sim-resize-handle] { display: none !important; }
`;

const listeners = new Set<() => void>();

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_RESIZE_HANDLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function applyHidden(): void {
  document.documentElement.toggleAttribute(HIDE_HANDLE_ATTR, readHidden());
}

export function setResizeHandleHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(HIDE_RESIZE_HANDLE_STORAGE_KEY, hidden ? "1" : "0");
  } catch {
    // Private mode: the switch still works for this page.
  }
  applyHidden();
  for (const listener of listeners) listener();
}

/** The resize-handle preference as React state, shared by every reader. */
export function useResizeHandleHidden(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readHidden,
    () => false,
  );
  return [hidden, setResizeHandleHidden];
}

let pressedSurface: Element | null = null;

function onMouseDown(event: MouseEvent): void {
  // Option-drag is the two-finger preview, which has dots of its own.
  if (event.button !== 0 || event.altKey) return;
  const surface = (event.target as Element | null)?.closest?.(SURFACE) ?? null;
  if (!surface) return;
  surface.setAttribute(PRESSED_ATTR, "");
  pressedSurface = surface;
}

function onRelease(): void {
  pressedSurface?.removeAttribute(PRESSED_ATTR);
  pressedSurface = null;
}

/** Installs the stylesheet and listeners once; later calls do nothing. */
export function installForkViewer(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  applyHidden();
  // Capture phase: the input layer calls preventDefault on mousedown.
  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mouseup", onRelease, true);
  // A release outside the window never arrives; losing focus stands in for it.
  window.addEventListener("blur", onRelease);
}
