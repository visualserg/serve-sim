// fork: what the page adds to upstream's toolbar recording. Created once per
// page and handed to two upstream hooks through options they already have or
// that a `fork:` seam adds:
//
//   useRecordingToast({ locate })          upstream's own option
//   useScreenRecording(udid, { sidecar })  fork seam
//
// The sidecar records the pointer track and sends it with the stop. When the
// server answers that it saved the movie into a capture folder, the sidecar
// remembers where, and `locate` hands that path to the Recording Saved card in
// place of upstream's search for a browser download.

import { hostAction } from "../utils/exec";
import { CAPTURE_HEADER } from "../../fork/pointer-track-format";
import { pointerTrackSidecar } from "./pointer-track";
import type { RecordingSidecar } from "./recording-sidecar";

export interface ForkRecording {
  sidecar: RecordingSidecar;
  /** Host path of a recording by file name, "" when it can't be found (yet). */
  locate(fileName: string): Promise<string>;
}

/** The host path a capture's movie was saved to, if the stop says so. */
function capturePath(header: string | null): string | null {
  if (!header) return null;
  try {
    const path = decodeURIComponent(header);
    return path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

/** Upstream's lookup of a browser download, for recordings that took that path. */
async function locateDownload(fileName: string): Promise<string> {
  try {
    const res = await hostAction("locateRecording", { fileName });
    return typeof res.path === "string" ? res.path : "";
  } catch {
    return "";
  }
}

export function createForkRecording({
  fallbackLocate = locateDownload,
}: { fallbackLocate?: (fileName: string) => Promise<string> } = {}): ForkRecording {
  const saved = new Map<string, string>();
  return {
    sidecar: {
      ...pointerTrackSidecar(),
      collected(headers) {
        const path = capturePath(headers.get(CAPTURE_HEADER));
        if (path) saved.set(path.slice(path.lastIndexOf("/") + 1), path);
        return path;
      },
    },
    locate: async (fileName) => saved.get(fileName) ?? fallbackLocate(fileName),
  };
}
