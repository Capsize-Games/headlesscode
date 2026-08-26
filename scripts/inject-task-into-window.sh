#!/usr/bin/env bash
# Find a VS Code window by a substring of its title (typically the
# worktree/folder name), activate it, paste the given task text into
# whatever's focused (Zoo Code's chat input has focus by default when
# a fresh window opens), and optionally submit it.
#
# This replaces the companion-extension autostart approach, which
# proved unreliable (task objects were created via Zoo Code's
# startNewTask() API but never visibly progressed, twice, with no
# error). Driving the UI directly via xdotool exercises the same code
# path a human uses — confirmed live: a real task submitted this way
# ran end-to-end successfully (API request -> thinking -> completed)
# where the API-based approach silently stalled every time.
#
# IMPORTANT: uses clipboard paste (xclip + Ctrl+V), not `xdotool type`.
# `xdotool type` sends each character as a real keystroke, including
# embedded newlines as Return keypresses — confirmed live that this
# truncates a multi-line task at the first line break and submits it
# prematurely. Clipboard paste inserts the whole block as one event,
# with no embedded-newline risk.
#
# Usage:
#   scripts/inject-task-into-window.sh <window-title-substring> <task-file> [--submit]
#
# Without --submit, the task text is pasted but NOT sent (Enter is not
# pressed) — use this to verify placement before committing to a real,
# billed task run. With --submit, it also presses Enter to send it.
#
# Requires: xdotool, wmctrl, xclip (all present on this machine).
# Requires an active X11 DISPLAY.

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <window-title-substring> <task-file> [--submit]" >&2
    exit 1
fi

TITLE_SUBSTR="$1"
TASK_FILE="$2"
SUBMIT="${3:-}"

if [ ! -f "$TASK_FILE" ]; then
    echo "ERROR: task file '$TASK_FILE' not found" >&2
    exit 1
fi

WINDOW_LINE="$(wmctrl -l | grep -F "$TITLE_SUBSTR" | head -1 || true)"
if [ -z "$WINDOW_LINE" ]; then
    echo "ERROR: no window found matching '$TITLE_SUBSTR'." >&2
    echo "Current windows:" >&2
    wmctrl -l >&2
    exit 1
fi

WINDOW_ID="$(echo "$WINDOW_LINE" | awk '{print $1}')"
echo "Found window: $WINDOW_LINE"

# --sync makes activation wait until the window actually has focus, so
# the subsequent keystrokes go to the right window.
xdotool windowactivate --sync "$WINDOW_ID"
sleep 0.5

# Load the task file into the X clipboard, then paste it as one block.
xclip -selection clipboard -in "$TASK_FILE"
sleep 0.2

# IMPORTANT: do NOT use `xdotool key --window <id>`. That delivers
# synthetic XSendEvent key events, which Electron/VS Code webviews (the
# Zoo Code chat panel is one) ignore — confirmed live: the paste and the
# Return went nowhere and the query was never sent. Sending keys WITHOUT
# --window routes them through the XTEST server input path, i.e. exactly
# what a physical keyboard produces, which the focused widget receives.
# --clearmodifiers guards against a stuck modifier (e.g. a previous
# ctrl+v leaving ctrl held) eating the paste or turning Return into
# Ctrl+Enter.
xdotool key --clearmodifiers ctrl+v
sleep 0.5

if [ "$SUBMIT" = "--submit" ]; then
    xdotool key --clearmodifiers Return
    echo "Submitted."
else
    echo "Pasted but NOT submitted (pass --submit to also press Enter)."
fi
