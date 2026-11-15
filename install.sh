#!/bin/sh
# PolypheM installer: copies the layout, theme, mods and scripts into Herdr's config folder.
#
#   ./install.sh            install or update (re-run after every git pull)
#   ./install.sh --dry-run  show what would change, touch nothing
#
# Never touches Herdr's shipped layouts or mods (layouts/main.json stays yours).
# Files it replaces are backed up first in <herdr>/.polyphem-backup/<timestamp>/.
# Target folder: $HERDR_APP_HOME, default ~/.config/herdr-app.

set -eu
SRC="$(cd "$(dirname "$0")" && pwd)/herdr"
DEST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DRY=false; [ "${1:-}" = "--dry-run" ] && DRY=true

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
run()  { if $DRY; then say "would: $*"; else "$@"; fi; }

# ---- prerequisites --------------------------------------------------------------
missing=""
for t in git jq; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
[ -z "$missing" ] || { say "Missing required tools:$missing (brew install$missing)"; exit 1; }
for t in gh claude herdr-app; do command -v "$t" >/dev/null 2>&1 || warn "$t not found on PATH (see README, Requirements)"; done
[ -d "$DEST" ] || { say "No Herdr config at $DEST. Install and open Herdr once, or set HERDR_APP_HOME."; exit 1; }

# ---- back up what gets replaced ---------------------------------------------------
STAMP=$(date +%Y%m%d-%H%M%S); BK="$DEST/.polyphem-backup/$STAMP"
for p in mods/pm $(cd "$SRC" && ls -d mods/pm-*) pm-shared layouts/pm.json themes/warm.json keys.json; do
  [ -e "$DEST/$p" ] || continue
  run mkdir -p "$BK/$(dirname "$p")"
  run cp -R "$DEST/$p" "$BK/$p"
done

# ---- copy -----------------------------------------------------------------------------
run mkdir -p "$DEST/mods" "$DEST/layouts" "$DEST/themes"
for d in "$SRC"/mods/pm "$SRC"/mods/pm-*; do
  run rsync -a --delete --exclude .DS_Store "$d" "$DEST/mods/"
done
run rsync -a --delete --exclude .DS_Store "$SRC/pm-shared" "$DEST/"
run cp "$SRC/layouts/pm.json" "$DEST/layouts/pm.json"
run cp "$SRC/themes/warm.json" "$DEST/themes/warm.json"
run chmod +x "$DEST/pm-shared/routines-sync.sh" "$DEST/pm-shared/sync.sh"

# ---- keys: replace only the "layout:pm" section, keep everything else ---------------
KEYS="$DEST/keys.json"
if $DRY; then say "would: set \"layout:pm\" in $KEYS"
else
  [ -s "$KEYS" ] || echo '{}' > "$KEYS"
  tmp=$(mktemp)
  jq --slurpfile pm "$SRC/keys.pm.json" '.["layout:pm"] = $pm[0]' "$KEYS" > "$tmp" && mv "$tmp" "$KEYS"
fi

# ---- shared UI code into every mod (mods cannot import outside their folder) ----------
run sh "$DEST/pm-shared/sync.sh" >/dev/null

# ---- check -----------------------------------------------------------------------------
if ! $DRY && command -v herdr-app >/dev/null 2>&1 && [ "$DEST" = "$HOME/.config/herdr-app" ]; then
  fail=0
  for d in "$DEST"/mods/pm-*; do
    (cd "$DEST/mods" && herdr-app check "$(basename "$d")" >/dev/null 2>&1) || { warn "herdr-app check failed: $(basename "$d")"; fail=1; }
  done
  [ $fail -eq 0 ] && say "All mods pass herdr-app check."
fi

say ""
say "PolypheM installed in $DEST."
[ -d "$BK" ] && say "Previous files backed up in $BK."
say "Switch Herdr to it: herdr-app do layout.switch '{\"name\":\"pm\"}'  (ctrl-shift-l cycles layouts)."
