# This fork

What it adds to upstream serve-sim, where that code lives, and how to take upstream's changes without fighting it. Recipes for building, serving and re-rendering are in [README-just.md](./README-just.md).

## What it adds

Turning the device frame off (toolbar button, or Tools, Stream, Device frame) leaves the bare rectangular stream: no bezel, and none of the rounded corners or edge highlight the viewer otherwise fakes in its place. Tools, Stream, Resize handle hides the corner grip that sits over the bottom right of the screen.

A press darkens the pointer instead of dropping upstream's blue dot under it: the pointer already says where the touch is, and two overlapping circles read as two fingers.

Recordings started from the toolbar get a cursor. The [native recorder](./README.md#screen-recording) encodes the framebuffer, which has no pointer in it, so the page records what the mouse did while it ran and sends that with its stop request. The server saves each take into a folder of its own in the host's Downloads:

```
serve-sim-2026-11-22-14-42-09/
  serve-sim-recording-2026-11-22-14-42-09.mp4               the movie
  serve-sim-recording-2026-11-22-14-42-09-with-cursor.mp4   the track burned onto it
  pointer-track.json   moves, presses, and the option key behind the pinch preview
  overlay.log
```

The browser downloads nothing for such a take, so there is no second copy loose in Downloads. The Recording Saved card works as upstream's: Open in Finder shows the render with the cursor once it is written, and the movie itself until then; dragging the card onto the simulator adds the movie to Photos.

The cursor pass starts on its own once the folder is written. It needs `bun` and `ffmpeg` on the host and runs only when the server was started from this repo, where the script sits next to it. The folder is on the host even when the page is open on another machine. Recordings started elsewhere (`serve-sim record`, another tab) get no folder and download as upstream's do: the page that started a recording is the only one that saw its pointer. A take whose folder cannot be written falls back to the plain download too.

## Where the code lives

Everything the fork owns sits in places upstream never writes to:

```
packages/serve-sim/src/fork/          server: capture folder, track format, alignment
packages/serve-sim/src/client/fork/   page: pointer track, recording sidecar, viewer tweaks
packages/serve-sim/scripts/fork/      the overlay that burns the cursor in
packages/serve-sim/src/__tests__/fork-*.test.ts(x)
justfile, README-just.md, FORK.md
```

Upstream files are touched only at seams: a line or two, each tagged with a `fork:` comment, that hand control to the fork's code. `just seams` lists them all, `just footprint` shows which upstream files they are in and how many lines each. The fork's viewer tweaks hang off attributes upstream already renders (`touch-indicator`, `data-sim-resize-handle`) through a stylesheet, so they need no seam at all.

Where upstream offers a way in, the fork uses it rather than adding one: the Recording Saved card is pointed at the capture folder through its own `locate` option, and the fork's server modules are published by one `src/fork/*.ts` entry in `files`.

## Taking upstream's changes

```sh
just update   # fast-forward main to upstream, then merge it into the current branch
just seams    # every place the fork reaches into upstream code
just check    # typecheck, lint, and the tests (each seam is covered by a fork-* test)
```

`just update` merges rather than rebases: the fork's branches are pushed, and replaying old fork commits would walk back into conflicts an earlier merge already settled. It turns on `rerere` for this repo, so a conflict resolved once is resolved the same way when it comes back.

When a merge does conflict, it is at a seam. Take upstream's side of the file, put the tagged lines back where they belong, and let `just check` say whether they still hold. If upstream has meanwhile added a way in (an option, a hook, an attribute), move the fork onto it and drop the seam.

`bun.lock` stays exactly as upstream ships it: `just install` installs without saving a lockfile, since a lock the fork had rewritten would conflict on every merge that brings a new one.
