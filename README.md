<p align="center">
  <img src="assets/logo.svg" width="120" alt="PolypheM logo: a fleece with a single eye">
</p>

<h1 align="center">PolypheM</h1>

<p align="center">
  <b>One eye on your whole herd of Claude Code agents.</b><br>
  A product manager's workspace for Claude Code, built on <a href="https://herdr.dev">Herdr</a>.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-E0874F?style=flat-square&labelColor=1C1814"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-only-EDE3D3?style=flat-square&labelColor=1C1814">
  <img alt="Herdr 0.1.15+" src="https://img.shields.io/badge/Herdr-0.1.15%2B-EDE3D3?style=flat-square&labelColor=1C1814">
</p>

---

PolypheM turns Herdr into a cockpit for people who ship with Claude Code but don't live in a terminal: PMs, designers, founders. Every project is a git repo, every piece of work a worktree, every change a pull request. You read Claude's conversations as clean summaries, answer its questions with a click, schedule routines that write you a report every morning, and merge when the checks are green.

It's a layout, a theme, ten mods and a few scripts. Nothing to build, nothing running in the cloud.

## What you get

**Projects and workspaces**
- Sidebar of projects (git repos) and workspaces (git worktrees), each on two lines: branch, PR state, diff size.
- A `Scratch` conversation per project for quick questions, read-only, promotable to a real workspace.
- One-click archive with undo. New workspace from a blank branch or a Linear issue.

**Summary view of Claude Code**
- The conversation as you'd want to read it: messages, folded tool calls, files touched, sub-agents in tabs.
- Questions, permissions and plans become cards you answer with a click.
- Model, effort and fast mode in the composer. A single `Plan` switch: on, Claude proposes; off, it works.
- Hand off a plan to another model in one click. Drafts and scroll position are kept per conversation.

**Git and pull requests**
- Changes, checks and PR status in a side panel. `Create PR`, `Fix CI`, `Merge`, in that order, one button at a time.
- Side-by-side diff with comments. Sounds when CI fails or a PR merges.

**Routines**
- Scheduled Claude runs defined in `.routines/<name>/routine.md` inside each repo, so they travel with the project.
- Each run works in its own worktree, writes a report and opens a PR. You answer its questions inline, then `Approve` or `Keep report only`.

**Markdown**
- Rendered Markdown you edit block by block, in place. Source view when you need it.
- `Share`: one copy that pastes formatted in Slack, Notion or mail, and as Markdown in GitHub or an editor.

**Inbox and settings**
- An inbox that is always there: questions waiting for you, failing CI, reports to review, PRs to review.
- Settings for prompts, `CLAUDE.md`, skills and MCP servers, sounds and shortcuts.

## Requirements

| | |
|---|---|
| **Required** | macOS, [Herdr](https://herdr.dev) 0.1.15 or later, [Claude Code](https://claude.com/claude-code), `git`, `jq`, [`gh`](https://cli.github.com) signed in |
| **Routines** | [herdr-automations](https://github.com/DnzzL/herdr-automations) 0.12.1 |
| **Linear** | [herdr-linear](https://github.com/mrolafsson/herdr-linear) 0.14.5 |
| **Skills and MCP** | [skillshare](https://github.com/runkids/skillshare) 0.30.8 (`brew install`) |

The optional tools were read before being recommended. Install them from a reviewed clone at these versions, not with `curl | sh`, and re-read them before upgrading.

## Install

```sh
git clone https://github.com/ucouerbe/polyphem.git
cd polyphem
./install.sh --dry-run   # see what will change
./install.sh
herdr-app do layout.switch '{"name":"pm"}'
```

`install.sh` copies the layout, theme, mods and scripts into `~/.config/herdr-app` (or `$HERDR_APP_HOME`). It never touches Herdr's own layouts or mods, merges only its own section of `keys.json`, and backs up anything it replaces in `.polyphem-backup/`. Back to Herdr's default layout at any time with `ctrl-shift-l`.

**Update:** `git pull && ./install.sh`.

## Shortcuts

| Keys | |
|---|---|
| `⌘N` | New workspace |
| `⌘1` … `⌘9` | Jump to a workspace |
| `⌘J` | Scratch conversation |
| `⌘0` | Inbox |
| `⌘B` | Toggle the sidebar |
| `⌘⇧N` | New routine |
| `⌘⇧I` | New workspace from a Linear issue |
| `⌘⇧C` | Copy the open Markdown file |
| `⌘,` | Settings |

## How it fits together

```
herdr/
├── layouts/pm.json      the window: sidebar, tabs, conversation, side panel
├── themes/warm.json     the palette
├── keys.pm.json         shortcuts, merged into keys.json under "layout:pm"
├── pm-shared/           shared UI kit, icons, routines engine glue
└── mods/
    ├── pm               prompts (plan, handoff, PR, fix CI, review, routine report)
    ├── pm-sidebar       inbox, routines, projects
    ├── pm-tabs          tabs
    ├── pm-summary       Summary view of Claude Code
    ├── pm-git           changes, checks, PR actions
    ├── pm-diff, pm-pr   review
    ├── pm-md            Markdown tabs and routine reports
    ├── pm-routine       routine settings
    ├── pm-workspace-new new workspace dialog
    └── pm-settings      settings
```

Herdr mods can't import files outside their own folder, so `pm-shared/ui.js` is copied into every mod by `pm-shared/sync.sh`. Edit it there, then run the script.

## Contributing

Pull requests are welcome. Keep them small, check every mod you touch with `herdr-app check <mod>` and `herdr-app status`, and include a screenshot for anything visible. Nothing personal or internal in a PR: no repo names, prompts or captures from your work.

## Why "PolypheM"

Herdr herds agents. In the *Odyssey*, Polyphemus is the shepherd: a cyclops with one eye, counting his sheep every morning as they leave the cave. Ulysses escaped him clinging under a ram. Here you keep the single eye, and the sheep do the work.

The `pm` prefix on every mod was there first. The name just caught up with it.

## License

[Apache 2.0](LICENSE). Includes modified Herdr mods and Lucide icons, see [NOTICE](NOTICE).
