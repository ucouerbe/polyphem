#!/bin/sh
# Copies pm-shared/ui.js into every mods/pm-*/ui.js (mods cannot import outside their folder).
cd "$(dirname "$0")/.." || exit 1
for d in mods/pm-*/; do cp pm-shared/ui.js "$d/ui.js" && echo "synced $d"; done
