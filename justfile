# Fork tasks. Run `just` for the list.

port := "3399"
upstream := "https://github.com/EvanBacon/serve-sim.git"
# The hardware H.264 encoder fails on this machine and buries the log under
# "error encoding frame: encodingFailed". The stream lives through it by
# falling back to JPEG anyway, so ask for JPEG up front and skip the noise.
# Pass "auto" as the second argument to try H.264 again.
codec := "mjpeg"

default:
    @just --list

# --no-save leaves bun.lock as upstream wrote it. Upstream's lock trails its
# own package.json, so a plain install rewrites it, and a lock the fork has
# touched conflicts on every merge that brings a new one.
#
# Install JS dependencies.
install:
    bun install --no-save

# First run compiles Swift and takes a few minutes; later runs are seconds.
# Build the CLI, the preview bundle and the Swift native module.
build:
    bun run packages/serve-sim/build.ts

# Serve the booted simulator. Usage: just serve [port] [codec]
serve port=port codec=codec:
    node packages/serve-sim/dist/serve-sim.js --port {{ port }} --codec {{ codec }}

# Build, then serve.
up port=port codec=codec: build
    @just serve {{ port }} {{ codec }}

# Pass a folder to pick a specific capture. Writes the -with-cursor render
# beside the source.
#
# Draw the recorded pointer track onto the movie (newest capture by default).
cursor dir="":
    bun run packages/serve-sim/scripts/fork/overlay-cursor.ts "{{ dir }}"

# Freezes the whole bar, not just the clock: a carrier name or a battery that
# drops a percent mid-take dates the footage as surely as a wrong time does.
# `discharging` at 100 rather than `charged`, which draws the charging bolt.
# Survives until `just statusbar-clear`, a reboot, or an erase.
#
# Dress the status bar for a recording (9:41, full bars, full battery).
statusbar time="9:41":
    xcrun simctl status_bar booted override \
      --time "{{ time }}" \
      --dataNetwork wifi --wifiMode active --wifiBars 3 \
      --cellularMode active --cellularBars 4 --operatorName '' \
      --batteryState discharging --batteryLevel 100

# Hand the status bar back to the simulator.
statusbar-clear:
    xcrun simctl status_bar booted clear

# Waits for the process to actually be gone, because pkill returns before that
# and a `just serve` typed straight after would find the port still taken.
#
# Stop any instance this justfile started.
stop:
    -@pkill -f "dist/serve-sim.js --port" || true
    @while pgrep -f "dist/serve-sim.js --port" >/dev/null 2>&1; do sleep 0.2; done

# Watch mode against the source (no build step).
dev:
    bun run --filter 'serve-sim' dev

typecheck:
    bun run typecheck

lint:
    bun run lint

# The excluded files drive whatever device is booted: ui-settings.e2e flips
# appearance / text size / VoiceOver on it, permissions.e2e rewrites app
# permissions, type-command-sim types into it, drop-upload pushes media, and
# the rest send HID or poll live endpoints. They only skip themselves on CI, so
# running the whole directory locally mutates the simulator you are working in.
#
# Tests that never touch a running simulator.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ justfile_directory() }}
    files=$(ls packages/serve-sim/src/__tests__/*.test.ts packages/serve-sim/src/__tests__/*.test.tsx \
      | grep -vE '(ui-settings\.e2e|permissions\.e2e|type-command-sim|drop-upload|hid-malformed-input|event-log|idle-floor|avcc-stream-endpoint|accessibility-endpoint)\.test\.')
    bun test --max-concurrency=1 $files

# Every test, including the ones that reconfigure the booted simulator.
test-all:
    bun test --max-concurrency=1 packages/serve-sim/src/__tests__/

check: typecheck lint test

# Fails instead of merging if the fork's main has its own commits, so nothing
# is rewritten behind your back.
#
# Fast-forward local main to upstream.
sync:
    git remote get-url upstream >/dev/null 2>&1 || git remote add upstream {{ upstream }}
    git fetch upstream
    git switch main
    git merge --ff-only upstream/main

# A merge rather than a rebase: the fork's branches are pushed, and since
# upstream absorbed the frame toggle and recording, replaying the old fork
# commits would walk back into the conflicts the merge already settled.
# rerere (this repo only) remembers how a conflict was resolved and reapplies
# it when the same one comes back. After a merge, `just seams` lists every
# place the fork reaches into upstream code, and `just check` proves they
# still hold: each one is covered by a fork-* test.
#
# Merge an updated main into the current branch.
update branch=`git rev-parse --abbrev-ref HEAD`:
    @just sync
    git switch {{ branch }}
    git config rerere.enabled true
    git merge main

# Fork code lives in src/fork, src/client/fork, scripts/fork and the
# __tests__/fork-* files. Everything else it needs is a line or two in an
# upstream file, tagged `fork:` so this finds it.
#
# List every seam where the fork reaches into upstream code.
seams:
    @git grep -n "fork:" -- packages/serve-sim ':(exclude,glob)**/fork/**' ':(exclude,glob)**/__tests__/fork-*'

# How much of upstream the fork touches: the upstream files it changes, and by
# how many lines, working tree included so it also reads mid-merge. Measured
# from where the branch meets main, so commits main gained since don't count.
# Its own files are left out.
#
# Show the fork's footprint on upstream files.
footprint:
    @git diff --stat $(git merge-base main HEAD) -- . ':(exclude,glob)**/fork/**' ':(exclude,glob)**/__tests__/fork-*' ':(exclude)justfile' ':(exclude,glob)**/FORK.md' ':(exclude,glob)**/README-just.md'
