// fork: the contract between upstream's useScreenRecording and whatever rides
// along with the recordings it starts. The hook calls these at a handful of
// seams marked `fork:`; everything they do lives on this side.

export interface RecordingSidecar {
  /** Extra query for `/recording/start`. */
  startQuery?: Record<string, string>;
  /** Right before the start request goes out. */
  begin(): void;
  /** The start went through: the server's stamps, and how long the trip took. */
  started(timing: { startedAt?: string; respondedAt?: string; roundTripMs: number }): void;
  /** The recording this hook started ended without it: refused, stopped elsewhere, or left behind. */
  abort(): void;
  /** JSON body for this hook's own stop, or null to send a bare one. */
  finish(): string | null;
  /**
   * The stop's response arrived. Returns the host path when the server saved
   * the movie itself, in which case the browser downloads nothing.
   */
  collected?(headers: Headers): string | null;
}
