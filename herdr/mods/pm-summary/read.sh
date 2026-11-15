#!/bin/sh
# read.sh <transcript.jsonl> <byte offset> <project.jq>
# Prints projected records for the complete lines after <offset>, then
# {"k":"end","b":<bytes consumed>,"s":<file size>}. A line still being written
# (no trailing newline yet) is left for the next read.
F=$1; O=$2; S=$(stat -f %z "$F") || exit 1; L=$((S - O))
if [ "$L" -gt 0 ]; then
  if [ "$(tail -c +"$S" "$F" | head -c 1 | od -An -c | tr -d ' ')" != '\n' ]; then
    P=$(tail -c +$((O + 1)) "$F" | head -c "$L" | tail -n 1 | wc -c | tr -d ' ')
    L=$((L - P))
  fi
  [ "$L" -gt 0 ] && tail -c +$((O + 1)) "$F" | head -c "$L" | jq -cnR -f "$3"
else L=0; fi
echo "{\"k\":\"end\",\"b\":$L,\"s\":$S}"
