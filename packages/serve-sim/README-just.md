# Working on this fork

Every task lives in the `justfile` at the repo root. Run `just` on its own for the full list. What the fork adds, and how it stays mergeable with upstream, is in [FORK.md](./FORK.md).

## Getting current and running

```sh
just sync        # add the `upstream` remote if missing, fetch, fast-forward main
just install     # bun install, leaving bun.lock as upstream ships it
just build       # CLI + preview bundle + Swift native module (first run: a few minutes)
just serve 3399  # serve the booted simulator at http://localhost:3399
```

`just stop` ends a running instance, and waits for it to actually be gone, so a `just serve` typed straight after finds the port free. `just up` builds and serves in one go, and `just update` merges an updated main into the current branch (see [FORK.md](./FORK.md#taking-upstreams-changes) for why a merge, and what to run after it).

`just sync` merges with `--ff-only`, so a fork main that has grown its own commits fails loudly instead of collecting a silent merge commit.

### The codec argument

`serve` and `up` take the stream codec second and default it to `mjpeg`, because the hardware H.264 encoder fails on this machine and buries the log under `error encoding frame: encodingFailed`. Nothing breaks when it does, since the browser falls back to JPEG on its own, but asking for JPEG up front keeps the log readable. `just serve 3399 auto` tries H.264 again.

Only a page that asks for the H.264 stream can produce those errors: with no browser attached there are none either way. So a tab left open against an earlier run keeps them coming until it is reloaded.

## Before a take

```sh
just statusbar        # 9:41, full bars, full battery, no carrier
just statusbar 14:30  # any other time
just statusbar-clear  # hand the bar back to the simulator
```

It freezes the whole bar rather than only the clock, since a carrier name or a battery ticking down mid-take dates the footage just as much as a wrong time. The override outlives the recording: it stays until cleared, or until the device reboots or is erased.

The clock comes out `09:41`, not Apple's `9:41`, and that is `simctl` rather than the device: it parses whatever `--time` is given and stores it zero-padded. `9:41`, `9:41 AM`, `9:41am`, a full ISO timestamp and a leading space all land on the same stored `09:41`, under a US locale forced on the call as much as under any other. Switching the device to 12-hour time changes the real clock but not the override, and patching the stored string in `data/Library/SpringBoard/StatusBarOverrides.archive` does not survive: SpringBoard does not read it back on restart.

## Checks

`just check` runs typecheck, lint and tests together; `just typecheck`, `just lint` and `just test` run them separately.

`just test` deliberately skips the suites that reconfigure whatever simulator is booted: they flip appearance, text size and VoiceOver, rewrite app permissions, and type into the device. Those suites skip themselves only on CI, so running the whole test directory locally mutates the simulator you are working in. `just test-all` runs them anyway when that is actually what you want.

## Drawing the cursor onto a recording

Stopping a toolbar recording renders this automatically, so a capture folder in `~/Downloads` already holds the `-with-cursor.mp4` render alongside `overlay.log` from the run. The render is written under a hidden name and moved into place when it is done, so a half-written file never shows up. The automatic pass is skipped when the server was not started from the repo, since the script would not be there to run.

`just cursor` does the same by hand, which is what you want after editing the script. With no arguments it picks the newest capture, in `~/Downloads` or, for older ones, on the Desktop:

```sh
just cursor                                          # newest capture
just cursor ~/Downloads/serve-sim-2026-11-22-14-42-09  # a specific one
```

There is nothing to tune. Both recordings carry a timestamp taken off the same clock, so where they line up is read rather than guessed.

### How it lines the two up

The movie and the pointer track do not share a zero: tracking starts when the page sends the start request, the movie at the recorder's first frame. Both instants end up on the host's clock, so the shift between them is a subtraction:

- The page asks for the recording index (`index=1` on the start), and the index places the first frame on the host's wall clock. The server writes that into the track as `movieStartedAt`.
- The server stamps when it received the start and when it answered (`startedAt`, `respondedAt`). The page takes the server's own work off its round trip and halves what is left as the trip out, which places its zero on the host's clock as well. That holds even when the page runs on another machine over the LAN, whose wall clock agrees with the host's only by accident.

```
offset    -6ms (from the timestamps, nothing estimated)
```

The native recorder writes a frame for every slot from its first frame to the stop, so the movie is the whole session and nothing is padded. Pointer movement from before the first frame is dropped.

A take recorded in landscape is stored as portrait pixels plus a rotation, which ffmpeg applies on decode. The track holds raw framebuffer points, so the overlay turns each one the same way. Upstream's limit applies: rotating mid-recording leaves the rest of the footage sideways.

### Older captures

Folders from before the merge with upstream sit on the Desktop (`20260801_0104`) and hold `recording.mov` from `simctl io recordVideo`. `just cursor` still renders them, into `recording-with-cursor.mov` as before. `simctl` wrote frames only while the screen changed, so a still stretch at either end is missing from those movies. Their timestamps say how long the session really was, and the overlay restores the gaps by holding the first and last frame, and says so:

```
padded    302ms at the head, 8692ms at the tail (the screen was still and simctl wrote nothing)
```

When a capture has no stamp to read, the fallback is to line the tails up, which is wrong by however long the screen sat still before the stop, and which is why such captures are not padded either. The log says so in capitals.
