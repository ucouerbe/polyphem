#!/bin/sh
# Routines glue between <repo>/.routines/<name>/routine.md (source of truth) and herdr-automations.
#
#   routines-sync.sh sync [repo...]          project routine.md files into herdr-automations jobs
#   routines-sync.sh run <repo> <name> [--test]   run now (--test: marked test run)
#   routines-sync.sh save <repo> <slug>      routine.md on stdin: branch, PR, merge, resync
#   routines-sync.sh delete <repo> <slug>    remove .routines/<slug>/: branch, PR, merge, drop the jobs
#   routines-sync.sh pause|resume <repo> <name>
#   routines-sync.sh state [repo...]         JSON list for shared("pm.routines")
#   routines-sync.sh approve <worktree>      merge the run PR (squash), mark report merged
#   routines-sync.sh keep-only <worktree>    revert non-report changes, merge, mark report-only
#   routines-sync.sh send <worktree> <text>  send answers to the run's Claude (resume if gone)
#   routines-sync.sh runs <repo> <name>      JSON: worktrees with a pending run report
#
# Needs: git, gh, jq, claude, hc, herdr-automations (all on PATH). No network except gh.
# Repos are remembered in $HERDR_APP_HOME/data/pm-routine-repos.txt.

set -u
HOME_APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME_APP/data"
REPOS="$DATA/pm-routine-repos.txt"
HA="${HERDR_AUTOMATIONS:-herdr-automations}"
PROMPTS_GLOBAL="$HOME_APP/mods/pm/prompts"
mkdir -p "$DATA" "$DATA/mcp"
touch "$REPOS"
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

die() { echo "routines-sync: $*" >&2; exit 1; }

# ---- routine.md parsing -------------------------------------------------------
# fm <file> <key>: frontmatter value, quotes and trailing comments stripped.
fm() {
  awk -v k="$2" '
    NR==1 && $0!="---" { exit }
    NR>1 && $0=="---" { exit }
    NR>1 {
      i = index($0, ":"); if (!i) next
      key = substr($0, 1, i-1); if (key != k) next
      v = substr($0, i+1)
      sub(/^[ \t]+/, "", v)
      if (v ~ /^"/) { sub(/^"/, "", v); sub(/".*$/, "", v) }
      else if (v ~ /^'"'"'/) { sub(/^'"'"'/, "", v); sub(/'"'"'.*$/, "", v) }
      else { sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v) }
      print v; exit
    }' "$1"
}
# body <file>: everything after the frontmatter.
body() { awk 'NR==1 && $0!="---" { p=1 } p { print; next } NR>1 && $0=="---" { p=1; next }' "$1" | sed '1{/^$/d;}'; }

slug() { printf %s "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//'; }
proj_of() { basename "$1"; }
auto_name() { echo "$(slug "$(proj_of "$1")")-$(slug "$2")"; }

remember() { for r in "$@"; do [ -d "$r/.git" ] || [ -f "$r/.git" ] || continue; r=$(cd "$r" && pwd -P); grep -qxF "$r" "$REPOS" || echo "$r" >> "$REPOS"; done; }
all_repos() { remember "$@"; cat "$REPOS"; }

# ---- prompt ------------------------------------------------------------------
harness() { # <repo> <routine> <n>
  f="$1/.herdr/prompts/routine-report.md"; [ -f "$f" ] || f="$PROMPTS_GLOBAL/routine-report.md"
  rep=""; [ "${3:-0}" -gt 0 ] 2>/dev/null && rep="For context, read the last $3 files in .routines/$2/reports/ before you start (skip if none)."
  [ -f "$f" ] || die "missing harness prompt $f"
  sed "s|{routine}|$2|g" "$f" | awk -v r="$rep" '{ gsub(/\{reports\}/, r); print }'
}

build_prompt() { # <repo> <routine> <file> <test:0|1>
  repo=$1; rn=$2; f=$3; test=$4
  n=$(fm "$f" context_reports); n=${n:-0}
  {
    echo "You are running the routine \"$rn\" of project $(proj_of "$repo"), unattended, in your own git worktree (a fresh branch, already checked out). The definition is .routines/$rn/routine.md."
    [ "$test" = 1 ] && echo "THIS IS A TEST RUN: add the line 'test: true' to the report frontmatter and prefix the PR title with [test]."
    echo "Nobody can approve shell commands during this run: use the Read and Grep tools to look at files, run no shell command except plain ls and date, and write the report with the Write tool."
    echo; echo "## Instructions"; body "$f"
    echo; echo "## Report"; harness "$repo" "$rn" "$n"
    cat <<EOF

## When the report is written
Do not run git, do not commit, do not open a PR: the harness commits, pushes and opens the PR when you stop.
Stop after writing the report, then wait: the user answers your questions in this terminal and decides from the app.
EOF
  }
}

SETTINGS='{"permissions":{"allow":["Bash(date:*)","Bash(ls:*)","Bash(cat:*)","Bash(git status:*)","Bash(git log:*)","Bash(git diff:*)","Bash(gh pr list:*)","Bash(gh pr view:*)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'"$HOME_APP/pm-shared/routines-sync.sh"' finalize"}]}]}}'

put_job() { # <name> <repo> <cron> <model> <catchup> <disabled> <prompt> <mcpfile> [effort]
  case "${9:-}" in ""|low|medium|high|xhigh|max) ;; *) die "bad effort: $9";; esac
  jq -n --arg name "$1" --arg repo "$2" --arg cron "$3" --arg model "$4" --argjson catch "$5" \
        --argjson dis "$6" --arg prompt "$7" --arg mcp "$8" --arg settings "$SETTINGS" --arg effort "${9:-}" '
    { name: $name, cron: $cron, repo: $repo, workspace: "worktree", agent: "claude", model: $model,
      prompt: $prompt, catch_up_minutes: $catch,
      agent_args: (["--permission-mode", "auto", "--settings", $settings] + (if $effort != "" then ["--effort", $effort] else [] end)) }
    + (if $dis then {disabled: true} else {} end)   # never un-pause: a pause made with `pause` survives a sync
    + (if $mcp != "" then {mcp_config: $mcp} else {} end)' > "$DATA/tmp-put.json"
  if "$HA" list --json | jq -e --arg n "$1" '.automations | map(.name) | index($n)' >/dev/null; then
    "$HA" put --original "$1" < "$DATA/tmp-put.json"
  else "$HA" put < "$DATA/tmp-put.json"; fi
}

mcp_file() { # <repo> <auto> <list>  -> path or empty
  list=$(printf %s "$3" | tr -d '[]' | tr ',' ' ')
  [ -n "$(echo $list)" ] && [ -f "$1/.mcp.json" ] || { echo ""; return; }
  out="$DATA/mcp/$2.json"
  names=$(printf '%s\n' $list | jq -R . | jq -s .)
  jq --argjson n "$names" '.mcpServers |= with_entries(select(.key as $k | $n | index($k)))' "$1/.mcp.json" > "$out" && echo "$out"
}

managed="$DATA/pm-routines-managed.txt"; touch "$managed"

cmd_sync() {
  seen=""
  for repo in $(all_repos "$@"); do
    [ -d "$repo/.routines" ] || continue
    for f in "$repo"/.routines/*/routine.md; do
      [ -f "$f" ] || continue
      rn=$(basename "$(dirname "$f")"); a=$(auto_name "$repo" "$rn")
      cron=$(fm "$f" schedule); [ -n "$cron" ] || { echo "skip $a: no schedule" >&2; continue; }
      model=$(fm "$f" model); model=${model:-sonnet}
      catch=$(fm "$f" catch_up); catch=${catch:-120}
      paused=$(fm "$f" paused)
      mcp=$(mcp_file "$repo" "$a" "$(fm "$f" mcp)")
      args="$repo $cron $model $catch"
      dis=false; [ "$paused" = true ] && dis=true
      prompt=$(build_prompt "$repo" "$rn" "$f" 0)
      put_job "$a" "$repo" "$cron" "$model" "$catch" "$dis" "$prompt" "$mcp" "$(fm "$f" effort)" | jq -c '{name: "'"$a"'", problem: .problem, next: .next}' 2>/dev/null
      seen="$seen $a"
    done
  done
  # remove jobs we created for routines that no longer exist
  for m in $(cat "$managed"); do
    case " $seen " in *" $m "*) ;; *) "$HA" rm "$m" >/dev/null 2>&1; echo "removed $m";; esac
  done
  for s in $seen; do echo "$s"; done | sort -u > "$managed"
}

repo_routine_file() { f="$1/.routines/$2/routine.md"; [ -f "$f" ] || die "no $f"; echo "$f"; }

cmd_run() {
  repo=$1; rn=$2; f=$(repo_routine_file "$repo" "$rn"); a=$(auto_name "$repo" "$rn")
  if [ "${3:-}" = "--test" ]; then
    t="$a-test"
    model=$(fm "$f" model); model=${model:-sonnet}
    [ -n "${4:-}" ] && f=$4
    prompt=$(build_prompt "$repo" "$rn" "$f" 1)
    put_job "$t" "$repo" "$(fm "$f" schedule)" "$model" 120 true "$prompt" "" "$(fm "$f" effort)" >/dev/null || die "put test job failed"
    "$HA" run "$t" --bg
  else
    "$HA" run "$a" --bg
  fi
}
# save <repo> <slug> [file]: routine.md from file or stdin -> branch, PR, squash merge, main checkout updated, jobs re-synced.
cmd_save() {
  repo=$1; slug=$2; tmp=$(mktemp); if [ -n "${3:-}" ]; then cat "$3" > "$tmp"; else cat > "$tmp"; fi
  [ -s "$tmp" ] || die "empty routine.md"
  rr=$(gh_repo "$repo") || die "no origin remote"
  base=$(gh repo view "$rr" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null); base=${base:-main}
  git -C "$repo" fetch -q --prune origin || die "fetch failed"
  br="routine/$slug-$(date +%s)"; wt="$DATA/tmp/save-$slug"; rm -rf "$wt"; mkdir -p "$DATA/tmp"
  git -C "$repo" worktree add -q -b "$br" "$wt" "origin/$base" || die "worktree failed"
  mkdir -p "$wt/.routines/$slug"; cp "$tmp" "$wt/.routines/$slug/routine.md"; rm -f "$tmp"
  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then git -C "$repo" worktree remove --force "$wt"; git -C "$repo" branch -D "$br" >/dev/null; echo '{"pr":null,"note":"no change"}'; return; fi
  git -C "$wt" commit -qm "routine($slug): update routine.md"
  git -C "$wt" push -q -u origin "$br" 2>/dev/null || die "push failed"
  url=$(gh pr create -R "$rr" --base "$base" --head "$br" --title "Routine $slug: update routine.md" --body "Saved from the routine settings page. The routine is rescheduled when this merges.") || die "pr create failed"
  git -C "$repo" worktree remove --force "$wt"
  n=${url##*/}
  gh pr merge "$n" -R "$rr" --squash --delete-branch >/dev/null 2>&1 || die "merge failed ($url)"
  git -C "$repo" branch -D "$br" >/dev/null 2>&1
  git -C "$repo" push -q origin --delete "$br" 2>/dev/null
  git -C "$repo" fetch -q --prune origin 2>/dev/null
  git -C "$repo" pull -q --ff-only origin "$base" 2>/dev/null || echo "main checkout not updated (local changes?)" >&2
  cmd_sync "$repo" >/dev/null
  jq -n --argjson n "$n" '{pr:$n, merged:true}'
}
# delete: removes .routines/<slug>/ (routine.md and its reports) through a PR merged right away, like save,
# then drops the routine's jobs from the engine. Reports stay in git history.
cmd_delete() {
  repo=$1; slug=$2
  case "$slug" in ""|*/*|.*) die "bad routine name";; esac
  rr=$(gh_repo "$repo") || die "no origin remote"
  base=$(gh repo view "$rr" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null); base=${base:-main}
  git -C "$repo" fetch -q --prune origin || die "fetch failed"
  br="routine/$slug-delete-$(date +%s)"; wt="$DATA/tmp/delete-$slug"; rm -rf "$wt"; mkdir -p "$DATA/tmp"
  git -C "$repo" worktree add -q -b "$br" "$wt" "origin/$base" || die "worktree failed"
  if [ ! -d "$wt/.routines/$slug" ]; then
    git -C "$repo" worktree remove --force "$wt"; git -C "$repo" branch -D "$br" >/dev/null
    "$HA" rm "$(auto_name "$repo" "$slug")" >/dev/null 2>&1; "$HA" rm "$(auto_name "$repo" "$slug")-test" >/dev/null 2>&1
    echo '{"pr":null,"note":"not on the default branch; engine jobs removed"}'; return
  fi
  git -C "$wt" rm -rq ".routines/$slug"
  git -C "$wt" commit -qm "routine($slug): delete"
  git -C "$wt" push -q -u origin "$br" 2>/dev/null || die "push failed"
  url=$(gh pr create -R "$rr" --base "$base" --head "$br" --title "Routine $slug: delete" --body "Deleted from the routine settings page. Its reports stay in git history.") || die "pr create failed"
  git -C "$repo" worktree remove --force "$wt"
  n=${url##*/}
  gh pr merge "$n" -R "$rr" --squash --delete-branch >/dev/null 2>&1 || die "merge failed ($url)"
  git -C "$repo" branch -D "$br" >/dev/null 2>&1
  git -C "$repo" push -q origin --delete "$br" 2>/dev/null
  git -C "$repo" fetch -q --prune origin 2>/dev/null
  git -C "$repo" pull -q --ff-only origin "$base" 2>/dev/null || echo "main checkout not updated (local changes?)" >&2
  "$HA" rm "$(auto_name "$repo" "$slug")-test" >/dev/null 2>&1
  cmd_sync "$repo" >/dev/null   # drops the scheduled job: its routine.md is gone
  jq -n --argjson n "$n" '{pr:$n, merged:true}'
}

# finalize: Stop hook of a run. Commits what the run wrote, pushes the branch, opens the PR once.
# Idempotent: runs after every turn, so answers sent later land on the same PR.
cmd_finalize() {
  sid=$(cat | jq -r '.session_id // empty' 2>/dev/null)
  w=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
  br=$(git -C "$w" rev-parse --abbrev-ref HEAD)
  case "$br" in auto/*) ;; *) exit 0;; esac
  rep=$(ls -t "$w"/.routines/*/reports/*.md 2>/dev/null | head -1)
  [ -n "$rep" ] || exit 0
  [ -n "$sid" ] && [ -z "$(fm "$rep" session)" ] && awk -v s="$sid" 'NR>1 && $0=="---" && !d { print "session: " s; d=1 } { print }' "$rep" > "$rep.tmp" && mv "$rep.tmp" "$rep"
  rn=$(basename "$(dirname "$(dirname "$rep")")"); date=$(basename "$rep" .md)
  git -C "$w" add -A
  git -C "$w" diff --cached --quiet || git -C "$w" commit -qm "routine($rn): report $date"
  git -C "$w" remote get-url origin >/dev/null 2>&1 || exit 0
  git -C "$w" push -q -u origin HEAD 2>/dev/null || exit 0
  rr=$(gh_repo "$w")
  [ -n "$(pr_number "$w" "$br")" ] && exit 0
  t=""; [ "$(fm "$rep" test)" = true ] && t="[test] "
  gh pr create -R "$rr" --base main --head "$br" --title "${t}Routine $rn $date" --body "Report: .routines/$rn/reports/$date.md" >/dev/null 2>&1
  exit 0
}
cmd_pause()  { "$HA" pause "$(auto_name "$1" "$2")"; }
cmd_resume() { "$HA" resume "$(auto_name "$1" "$2")"; }

# ---- run worktrees and reports -----------------------------------------------
# One line per worktree whose branch is auto/<auto>[-test]-<ts>: "<path>\t<branch>"
run_worktrees() { # <repo> <auto>
  git -C "$1" worktree list --porcelain 2>/dev/null | awk -v p="refs/heads/auto/$2" '
    /^worktree / { w = substr($0, 10) }
    /^branch / { b = substr($0, 8); if (index(b, p "-") == 1 && substr(b, length(p) + 2, 1) ~ /[0-9]/) print w "\t" b }'
}

cmd_runs() { # <repo> <name>  -> JSON array of runs with reports
  repo=$1; rn=$2; a=$(auto_name "$repo" "$rn")
  { run_worktrees "$repo" "$a"; run_worktrees "$repo" "$a-test"; } | while IFS="$(printf '\t')" read -r w b; do
    [ -n "$w" ] || continue
    for r in "$w"/.routines/"$rn"/reports/*.md; do
      [ -f "$r" ] || continue
      st=$(fm "$r" status)
      jq -n --arg w "$w" --arg b "${b#refs/heads/}" --arg r "$r" --arg st "$st" --arg run "$(fm "$r" run)" \
        '{worktree:$w, branch:$b, report:$r, status:$st, run:$run}'
    done
  done | jq -s 'map(select(.status=="to-review"))'
}

pr_number() { gh pr list -R "$(gh_repo "$1")" --head "$2" --state open --json number -q '.[0].number' 2>/dev/null; }
gh_repo() { git -C "$1" remote get-url origin | sed 's|.*github.com[:/]||; s|\.git$||'; }

set_status() { # <report> <status>
  tmp=$(mktemp); awk -v s="$2" 'NR>1 && /^status:/ && !d { print "status: " s; d=1; next } { print }' "$1" > "$tmp" && cat "$tmp" > "$1"; rm -f "$tmp"
}
main_checkout() { git -C "$1" worktree list --porcelain | awk 'NR==1 { print substr($0, 10); exit }'; }

finish_merge() { # <worktree> <final status>
  w=$1; st=$2
  br=$(git -C "$w" rev-parse --abbrev-ref HEAD); main=$(main_checkout "$w"); rr=$(gh_repo "$w")
  rep=$(ls "$w"/.routines/*/reports/*.md 2>/dev/null | tail -1)
  [ -n "$rep" ] && { set_status "$rep" "$st"; git -C "$w" add -A; git -C "$w" commit -qm "routine: report $st" >/dev/null 2>&1 || true; }
  git -C "$w" push -q origin HEAD 2>&1 | tail -1
  n=$(pr_number "$w" "$br"); [ -n "$n" ] || die "no open PR for $br"
  ok=""; for i in 1 2 3 4 5 6; do gh pr merge "$n" -R "$rr" --squash 2>$DATA/tmp-merge.err && { ok=1; break; }; sleep 4; done
  [ -n "$ok" ] || die "merge failed: $(tail -1 $DATA/tmp-merge.err)"
  git -C "$main" fetch -q origin && git -C "$main" merge -q --ff-only origin/HEAD 2>/dev/null || git -C "$main" pull -q --ff-only
  t=$(find_terminal "$w"); [ -n "$t" ] && hc kill "$t" >/dev/null 2>&1
  git -C "$main" worktree remove --force "$w" 2>&1 | tail -1
  git -C "$main" branch -D "$br" >/dev/null 2>&1
  git -C "$main" push -q origin --delete "$br" 2>/dev/null
  echo "merged PR #$n ($st)"
}

cmd_approve() { finish_merge "$1" merged; }
cmd_keep_only() {
  w=$1
  rep=$(ls "$w"/.routines/*/reports/*.md | tail -1); rrel=${rep#$w/}
  base=$(git -C "$w" symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)
  git -C "$w" fetch -q origin
  git -C "$w" diff --name-only "$base...HEAD" | while read -r f; do
    [ "$f" = "$rrel" ] && continue
    if git -C "$w" cat-file -e "$base:$f" 2>/dev/null; then git -C "$w" checkout "$base" -- "$f"; else git -C "$w" rm -qf -- "$f"; fi
  done
  git -C "$w" add -A; git -C "$w" commit -qm "routine: keep report only" >/dev/null 2>&1 || true
  finish_merge "$w" report-only
}

# Terminal of the run: label automation=<auto>, cwd inside the worktree.
find_terminal() { # <worktree>
  hc ls --json 2>/dev/null | jq -r --arg w "$1" '
    (.terminals // .) | map(select((.cwd // "") == $w)) | .[0].address // .[0].id // empty' 2>/dev/null
}
cmd_send() { # <worktree> <text>
  w=$1; text=$2
  t=$(find_terminal "$w")
  if [ -n "$t" ]; then hc send "$t" "$text"; return; fi
  rep=$(ls "$w"/.routines/*/reports/*.md | tail -1); sid=$(fm "$rep" session)
  [ -n "$sid" ] || sid=$(ls -t "$HOME/.claude/projects/$(printf %s "$w" | sed 's|[/.]|-|g')"/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)
  [ -n "$sid" ] || die "run terminal is gone and no session id is known"
  # Same mode and Stop hook (finalize) as the scheduled run, so the answers land on the run PR.
  (cd "$w" && hc run --bg --keep -- claude --resume "$sid" --permission-mode auto --settings "$SETTINGS" "$text")
}

# ---- state for the sidebar ----------------------------------------------------
cmd_state() {
  list=$("$HA" list --json 2>/dev/null || echo '{}')
  hist=$("$HA" history --json 2>/dev/null || echo '[]')
  for repo in $(all_repos "$@"); do
    [ -d "$repo/.routines" ] || continue
    for f in "$repo"/.routines/*/routine.md; do
      [ -f "$f" ] || continue
      rn=$(basename "$(dirname "$f")"); a=$(auto_name "$repo" "$rn")
      runs=$(cmd_runs "$repo" "$rn")
      jq -n --arg project "$(proj_of "$repo")" --arg repo "$repo" --arg name "$rn" --arg title "$(fm "$f" name)" \
        --arg icon "$(fm "$f" icon)" --arg color "$(fm "$f" color)" --arg schedule "$(fm "$f" schedule)" \
        --arg a "$a" --argjson list "$list" --argjson hist "$hist" --argjson runs "$runs" --arg paused "$(fm "$f" paused)" '
        ($list.automations // [] | map(select(.name == $a)) | .[0]) as $j
        | ($hist | map(select(.automation == $a or .automation == ($a + "-test"))) | .[0]) as $last
        | ($j.disabled // false) as $dis
        | { project: $project, repo: $repo, name: $name, title: (if $title == "" then $name else $title end),
            icon: (if $icon == "" then "clock" else $icon end), color: (if $color == "" then "ember" else $color end),
            schedule: $schedule, next: ($j.next // null),
            status: (if ($last.status // "") == "running" then "running"
                     elif ($runs | length) > 0 then "to-review"
                     elif $dis or $paused == "true" or ($list.paused // false) then "paused"
                     elif ($last.status // "") == "failed" then "failed"
                     elif ($last.status // "") == "missed" then "missed"
                     else "scheduled" end),
            lastRun: ($last.started // null), lastStatus: ($last.status // null),
            reportPath: ($runs | map(.report) | last // null),
            toReview: ($runs | length), runs: $runs }'
    done
  done | jq -s '.'
}

c=${1:-}; [ $# -gt 0 ] && shift
case "$c" in
  sync) cmd_sync "$@";;
  run) cmd_run "$@";;
  finalize) cmd_finalize;;
  save) cmd_save "$@";;
  delete) cmd_delete "$@";;
  pause) cmd_pause "$@";;
  resume) cmd_resume "$@";;
  state) cmd_state "$@";;
  runs) cmd_runs "$@";;
  approve) cmd_approve "$@";;
  keep-only) cmd_keep_only "$@";;
  send) cmd_send "$@";;
  *) sed -n 2,13p "$0"; exit 2;;
esac
