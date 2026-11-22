# Fork tasks. Run `just` for the list.

port := "3399"
upstream := "https://github.com/EvanBacon/serve-sim.git"
# The hardware H.264 encoder fails on this machine and buries the log under
# "error encoding frame: encodingFailed". The stream lives through it by
# falling back to JPEG anyway, so ask for JPEG up front and skip the noise.
# Pass "auto" as the second argument to try H.264 again.
codec := "mjpeg"

# Personal shortcuts for this machine (apps, paths). Kept out of git through
# .git/info/exclude, so nothing personal lands in the public fork.
import? 'local.just'

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

# The simulator the app recipes work on: a UDID, or `booted`. Pick another
# with `just device=<udid> app ...`.
device := "booted"

# A .app is installed as it is. A Flutter project (a folder with pubspec.yaml,
# or with src/pubspec.yaml) is built for the simulator first. The app replaces
# any running copy and is launched, so it shows up in the open preview
# straight away. KEY=VALUE arguments are debug overrides, as for `launch`.
#
# Build if needed, install and launch an app. Usage: just app <path> [KEY=VALUE ...]
[positional-arguments]
app path *overrides:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    src="{{ path }}"
    src="${src/#\~/$HOME}"
    if [[ "$src" != *.app ]]; then
      if [[ ! -f "$src/pubspec.yaml" && -f "$src/src/pubspec.yaml" ]]; then src="$src/src"; fi
      if [[ ! -f "$src/pubspec.yaml" ]]; then echo "Not a .app or a Flutter project: {{ path }}" >&2; exit 1; fi
      (cd "$src" && flutter build ios --simulator --debug)
      src=$(ls -d "$src"/build/ios/iphonesimulator/*.app | head -1)
    fi
    xcrun simctl install "{{ device }}" "$src"
    exec "{{ just_executable() }}" --justfile "{{ justfile() }}" device="{{ device }}" launch "$src" "$@"

# For an app that reads `Library/Application Support/debug-overrides.env` in
# its data container at startup, in debug builds only. They hold
# until the next launch through just, so they survive the relaunches iOS does
# on its own (a crash, a permission revoked in Settings); a launch without any
# clears them. The app is a bundle id, a .app or a Flutter project. What the
# app logs under `[DebugOverrides]` is echoed back, which is where a mistyped
# key shows up.
#
# Relaunch an installed app with debug overrides. Usage: just launch <app> [KEY=VALUE ...]
[positional-arguments]
launch app *overrides:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    bundle=$("{{ just_executable() }}" --justfile "{{ justfile() }}" _bundle "{{ app }}")
    "{{ just_executable() }}" --justfile "{{ justfile() }}" device="{{ device }}" _overrides "$bundle" "$@"
    launched=$(xcrun simctl launch --terminate-running-process "{{ device }}" "$bundle")
    echo "$launched"
    (( $# )) || exit 0
    pid=${launched##*: }
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 1
      report=$(xcrun simctl spawn "{{ device }}" log show --last 30s --style compact \
        --predicate "processID == $pid AND eventMessage CONTAINS \"[DebugOverrides]\"" 2>/dev/null \
        | grep -o '\[DebugOverrides\].*' || true)
      if [[ -n "$report" ]]; then echo "$report"; exit 0; fi
    done
    echo "The app said nothing about its overrides: does it read debug-overrides.env?"

# Flutter takes a device by UDID or name, not `booted`, so the UDID is looked
# up first. Stays in the foreground: r hot-reloads, R restarts (and rereads
# the overrides), q quits. Overrides need the app installed once already,
# since they are written before flutter run installs anything.
#
# Run a Flutter project on the simulator with hot reload. Usage: just app-run <path> [KEY=VALUE ...]
[positional-arguments]
app-run path *overrides:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    src="{{ path }}"
    src="${src/#\~/$HOME}"
    if [[ ! -f "$src/pubspec.yaml" && -f "$src/src/pubspec.yaml" ]]; then src="$src/src"; fi
    bundle=$("{{ just_executable() }}" --justfile "{{ justfile() }}" _bundle "$src")
    if xcrun simctl get_app_container "{{ device }}" "$bundle" data >/dev/null 2>&1 || (( $# )); then
      "{{ just_executable() }}" --justfile "{{ justfile() }}" device="{{ device }}" _overrides "$bundle" "$@"
    fi
    udid=$(xcrun simctl getenv "{{ device }}" SIMULATOR_UDID)
    cd "$src" && exec flutter run -d "$udid"

# Keys are the app's own, without the `flutter.` prefix the plugin adds. A
# value keeps the type its key already has (a timestamp stored as a string
# stays a string); a new key is a bool, an integer or a string by its look.
# `key=` deletes. The app is stopped first, so it cannot write its cached
# copy back over the change, and relaunched after.
#
# Show or change a Flutter app's shared_preferences. Usage: just prefs <app> [key=value ...]
[positional-arguments]
prefs app *changes:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    bundle=$("{{ just_executable() }}" --justfile "{{ justfile() }}" _bundle "{{ app }}")
    data=$(xcrun simctl get_app_container "{{ device }}" "$bundle" data)
    domain="$data/Library/Preferences/$bundle"
    defaults() { xcrun simctl spawn "{{ device }}" defaults "$@"; }
    show() {
      defaults export "$domain" - 2>/dev/null | plutil -p - \
        | awk '/^  "/ { keep = ($0 ~ /^  "flutter\./) } keep { sub(/"flutter\./, "\""); print }'
    }
    if (( $# == 0 )); then show; exit; fi
    for change in "$@"; do
      [[ "$change" == *=* && "${change%%=*}" != "" ]] || { echo "Not key=value: $change" >&2; exit 1; }
    done
    xcrun simctl terminate "{{ device }}" "$bundle" 2>/dev/null || true
    for change in "$@"; do
      key="flutter.${change%%=*}"
      value="${change#*=}"
      if [[ -z "$value" ]]; then
        defaults delete "$domain" "$key" 2>/dev/null || true
        continue
      fi
      type=$(defaults read-type "$domain" "$key" 2>/dev/null | awk '{ print $3 }' || true)
      if [[ -z "$type" ]]; then
        if [[ "$value" == true || "$value" == false ]]; then type=boolean
        elif [[ "$value" =~ ^-?[0-9]+$ ]]; then type=integer
        else type=string; fi
      fi
      case "$type" in
        boolean) defaults write "$domain" "$key" -bool "$value" ;;
        integer) defaults write "$domain" "$key" -int "$value" ;;
        float) defaults write "$domain" "$key" -float "$value" ;;
        string) defaults write "$domain" "$key" -string "$value" ;;
        *) echo "$key holds a $type, which this cannot write" >&2; exit 1 ;;
      esac
    done
    show
    xcrun simctl launch "{{ device }}" "$bundle"

# Writes the overrides file for `launch` and `app-run`, or removes it when
# there are none. Staged and moved, so a launch never reads half of it.
[private]
[positional-arguments]
_overrides bundle *overrides:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    data=$(xcrun simctl get_app_container "{{ device }}" "{{ bundle }}" data)
    file="$data/Library/Application Support/debug-overrides.env"
    if (( $# == 0 )); then rm -f "$file"; exit; fi
    for kv in "$@"; do
      [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_.]*= ]] || { echo "Not KEY=VALUE: $kv" >&2; exit 1; }
    done
    mkdir -p "${file%/*}"
    printf '%s\n' "$@" > "$file.part"
    mv "$file.part" "$file"
    printf 'override %s\n' "$@"

# A .app or a Flutter project's last simulator build gives the id it was
# installed under; without a build, the Xcode project's own setting.
[private]
_bundle app:
    #!/usr/bin/env bash
    set -euo pipefail
    app="{{ app }}"
    app="${app/#\~/$HOME}"
    if [[ ! -e "$app" ]]; then echo "$app"; exit; fi
    if [[ "$app" == *.app ]]; then /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist"; exit; fi
    if [[ ! -f "$app/pubspec.yaml" && -f "$app/src/pubspec.yaml" ]]; then app="$app/src"; fi
    built=$(ls -d "$app"/build/ios/iphonesimulator/*.app 2>/dev/null | head -1 || true)
    if [[ -n "$built" ]]; then /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$built/Info.plist"; exit; fi
    id=$(grep -hE 'PRODUCT_BUNDLE_IDENTIFIER = ' "$app/ios/Runner.xcodeproj/project.pbxproj" 2>/dev/null \
      | grep -v Tests | head -1 | sed -E 's/.*= "?([^";]+)"?;.*/\1/' || true)
    if [[ -z "$id" ]]; then echo "No bundle id found for {{ app }}" >&2; exit 1; fi
    echo "$id"

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
