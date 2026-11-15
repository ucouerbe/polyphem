// @ts-check
// PM sidebar. Default role: inbox, routines, projects (worktrees as workspaces).
// props.role "footer": account usage meters and the New workspace button.
// Shared look lives in ./ui.js (copied from pm-shared/ui.js by pm-shared/sync.sh).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  shared, setShared, spaces, panes, agents, run, exec, openOverlay, focused, layout, window as win,
  pickFolder, nextCommand, notify, watchFolder, readTextFile, home, props, appHome, playSound,
} from "herdr";
import {
  C, SIZE, MONO, ICONS, icon, StatusDot, kindOf, colorOfKind, DiffPill, Kbd, SectionHeader, Sep, Row,
} from "./ui.js";

const RAIL_WIDTH = 76, FULL_WIDTH = 280;
const FALLBACK_MS = 60000;
const PR_MS = 5 * 60000;
const USAGE_MS = 5 * 60000;
const ROUTINE_MS = 30000;
const ROUTINES_SH = () => `${appHome()}/pm-shared/routines-sync.sh`;
const ROUTINE_COLORS = { ember: "#E0874F", amber: "#E3B341", green: "#7FBF7F", blue: "#6C9BD1", violet: "#9C86C9", stone: "#9A8F7E" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const USAGE_CACHE = "/tmp/claude/statusline-usage-cache.json";
const PALETTE = ["#E0874F", "#7FA7C9", "#9DBF7E", "#C9A7E0", "#E3B341", "#7FBFB4", "#D9649A"];
const URGENCY = { blocked: 4, done: 3, working: 2, idle: 1 };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const f = find(child, id);
    if (f) return f;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const base = (p) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// Copied from mods/worktree/main.js.
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const minutes = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function git(cwd, args) {
  try {
    const r = await exec("git", args, { cwd, timeout: 15000 });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// Every checkout of a repo (`git worktree list`), main first, then newest commit.
// Same logic as checkouts() in mods/worktree/main.js.
async function checkouts(repo) {
  const list = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return [];
  const refs = await git(repo, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"]);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => Number(b.main) - Number(a.main) || b.at - a.at);
}

// The main checkout of the repo containing `dir`, or null when it is not a repo.
async function mainOf(dir) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  return r.out.endsWith("/.git") ? r.out.slice(0, -5) : null;
}

export default class PmSidebar extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "sidebar";
    if (this.role === "titlebar") return;
    if (this.role === "footer") {
      this.usage = null;
      this.loadUsage(cx);
      cx.timer.every(USAGE_MS, (c) => this.loadUsage(c));
      return;
    }
    this.saved = JSON.parse(localStorage.getItem("pm.projects") ?? "[]");
    this.folded = new Set(JSON.parse(localStorage.getItem("pm.folded") ?? "[]"));
    this.archOpen = new Set(JSON.parse(localStorage.getItem("pm.archOpen") ?? "[]"));
    this.archHover = null;
    this.mainOfCache = {}; // dir -> main checkout | null
    this.projects = []; // { main, name, color, wts: [{path, branch, main, at, add, del}]}
    this.prs = [];
    this.routOpen = new Set(JSON.parse(localStorage.getItem("pm.routOpen") ?? "[]"));
    this.routReports = {}; // repo#name -> [{path, root, date, run}]
    this.routHover = null;
    this.routBusy = false;
    this.prSeen = shared("pm.pr") ?? {}; // sound transitions are judged against this, never on first load
    this.loaded = false;
    this.sig = "";
    this.busyPanes = {};
    this.checked = 0;
    this.watching = new Set();
    this.refreshing = false;
    this.again = false;
    this.refresh(cx);
    this.loadPrs(cx);
    this.pollRoutines(cx);
    cx.timer.every(ROUTINE_MS, (c) => this.pollRoutines(c));
    cx.timer.every(1500, (c) => this.tick(c));
    cx.timer.every(PR_MS, (c) => this.loadPrs(c));
    cx.spawn(async (c) => {
      for (;;) {
        const cmd = await nextCommand();
        this.command(cmd, c);
        c.notify();
      }
    });
  }

  // ---- data ----------------------------------------------------------------

  tick(cx) {
    const sp = spaces(), ps = panes();
    const sig = JSON.stringify([sp.map((s) => [s.id, place(s, ps)]), this.saved]);
    let due = sig !== this.sig;
    this.sig = sig;
    // An agent's turn (or a command) just ended: its diff may have moved.
    const busy = {};
    for (const p of ps) {
      if (!p.terminal) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busyPanes[p.pane] && !busy[p.pane]) due = true;
    }
    this.busyPanes = busy;
    if (win().active && Date.now() - this.checked > FALLBACK_MS) due = true;
    if (due) this.refresh(cx);
    this.prSounds();
  }

  /** Sound on a PR turning CI-failing or merged. Only transitions of known entries; on unless shared("pm.sounds") turns the key off. */
  prSounds() {
    const now = shared("pm.pr") ?? {};
    const prev = this.prSeen;
    if (now === prev) return;
    const on = shared("pm.sounds") ?? {};
    for (const [path, pr] of Object.entries(now)) {
      const was = prev[path];
      if (!was || was.number !== pr.number) continue;
      if (pr.state === "open" && pr.ci === "failing" && was.ci !== "failing" && on.ci !== false) playSound("blocked");
      else if (pr.state === "merged" && was.state !== "merged" && on.merged !== false) playSound("done");
    }
    this.prSeen = now;
  }

  refresh(cx) {
    if (this.refreshing) { this.again = true; return; }
    this.refreshing = true;
    this.checked = Date.now();
    cx.spawn(async (c) => {
      try {
        do {
          this.again = false;
          await this.collect(c);
          c.notify();
        } while (this.again);
      } finally {
        this.refreshing = false;
      }
    });
  }

  async collect(cx) {
    const sp = spaces(), ps = panes();
    const dirs = [...new Set([...this.saved, ...sp.filter((s) => !s.machine).map((s) => place(s, ps)).filter(Boolean)])];
    const mains = [];
    for (const d of dirs) {
      if (!(d in this.mainOfCache) || this.mainOfCache[d] === null) this.mainOfCache[d] = await mainOf(d);
      const m = this.mainOfCache[d];
      if (m && !mains.includes(m)) mains.push(m);
    }
    // Keep discovered projects after their space closes.
    const known = new Set(this.saved);
    const fresh = mains.filter((m) => !known.has(m));
    if (fresh.length) {
      this.saved = [...this.saved, ...fresh];
      localStorage.setItem("pm.projects", JSON.stringify(this.saved));
    }
    const order = this.saved.filter((m) => mains.includes(m));
    const out = [];
    for (const main of order) {
      const wts = await checkouts(main);
      if (!wts.length) continue;
      const baseRef = await this.baseOf(main);
      for (const w of wts) {
        w.add = 0; w.del = 0;
        if (w.main || !baseRef) continue;
        const mb = await git(w.path, ["merge-base", baseRef, "HEAD"]);
        const d = await git(w.path, ["diff", "--numstat", mb.ok ? mb.out : baseRef]);
        for (const l of d.out.split("\n")) {
          const [a, b] = l.split("\t");
          if (a && a !== "-") w.add += Number(a) || 0;
          if (b && b !== "-") w.del += Number(b) || 0;
        }
      }
      const name = base(main);
      const color = PALETTE[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PALETTE.length];
      out.push({ main, name, color, wts });
      this.watch(main, cx);
    }
    this.projects = out;
    this.loaded = true;
  }

  async baseOf(main) {
    const head = await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.ok && head.out) return head.out;
    for (const b of ["main", "master"]) if ((await git(main, ["rev-parse", "--verify", "-q", b])).ok) return b;
    return null;
  }

  // Refresh when a repo's git folder changes (commits, checkouts, new worktrees).
  watch(main, cx) {
    if (this.watching.has(main)) return;
    this.watching.add(main);
    cx.spawn(async (c) => {
      try {
        for (;;) {
          await watchFolder(`${main}/.git`);
          this.refresh(c);
        }
      } catch {
        this.watching.delete(main);
      }
    });
  }

  loadPrs(cx) {
    cx.spawn(async (c) => {
      try {
        const r = await exec("gh", ["search", "prs", "--review-requested=@me", "--state=open", "--json", "number,title,repository,updatedAt,url,author", "--limit", "20"], { timeout: 20000 });
        this.prs = r.code === 0 ? JSON.parse(r.stdout || "[]") : [];
      } catch {
        this.prs = [];
      }
      c.notify();
    });
  }

  // ---- routines ------------------------------------------------------------

  /** routines-sync.sh state -> shared("pm.routines"). Also counts the changes of each run waiting for review. */
  pollRoutines(cx) {
    if (this.routBusy) return;
    this.routBusy = true;
    cx.spawn(async (c) => {
      try {
        const r = await exec(ROUTINES_SH(), ["state", ...this.projects.map((p) => p.main)], { timeout: 60000 });
        const list = parseJson(r.stdout ?? "");
        if (Array.isArray(list)) {
          for (const x of list) {
            for (const run of x.runs ?? []) {
              const b = await git(run.worktree, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
              const d = await git(run.worktree, ["diff", "--name-only", `${b.ok && b.out ? b.out : "main"}...HEAD`]);
              run.changes = d.out.split("\n").filter((f) => f && !f.startsWith(".routines/")).length;
            }
          }
          const next = list.map((x) => ({
            project: x.project, repo: x.repo, name: x.name, title: x.title, icon: x.icon, color: x.color, schedule: x.schedule,
            next: x.next, status: x.status, lastRun: x.lastRun, reportPath: x.reportPath, toReview: x.toReview, runs: x.runs ?? [],
          }));
          if (JSON.stringify(next) !== JSON.stringify(shared("pm.routines") ?? null)) setShared("pm.routines", next);
          for (const key of this.routOpen) await this.loadReports(key, next);
        }
      } catch { /* script missing or engine down: keep the last state */ }
      this.routBusy = false;
      c.notify();
    });
  }

  routines() {
    const l = shared("pm.routines");
    return Array.isArray(l) ? l : [];
  }

  /** The last 4 reports of a routine: runs waiting for review first, then the merged ones in <repo>/.routines/<name>/reports. */
  async loadReports(key, list) {
    const x = (list ?? this.routines()).find((y) => `${y.repo}#${y.name}` === key);
    if (!x) return;
    const r = await exec("sh", ["-c", 'for f in "$1"/.routines/"$2"/reports/*.md; do [ -f "$f" ] && echo "$f"; done | sort -r | head -4', "sh", x.repo, x.name], { timeout: 5000 }).catch(() => null);
    const date = (f) => f.split("/").pop().replace(/\.md$/, "");
    const out = (x.runs ?? []).map((run) => ({ path: run.report.slice(run.worktree.length + 1), root: run.worktree, date: date(run.report), run }));
    for (const f of (r?.stdout ?? "").split("\n").filter(Boolean)) {
      if (out.some((o) => o.date === date(f))) continue;
      out.push({ path: f.slice(x.repo.length + 1), root: x.repo, date: date(f), run: null });
    }
    this.routReports[key] = out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  }

  toggleRoutine(x, cx) {
    const key = `${x.repo}#${x.name}`;
    if (this.routOpen.has(key)) this.routOpen.delete(key);
    else { this.routOpen.add(key); this.loadReports(key).then(() => cx.notify()); }
    localStorage.setItem("pm.routOpen", JSON.stringify([...this.routOpen]));
    cx.notify();
  }

  /** Opens a report: to-review runs get the report zone (worktree props), merged ones a plain Markdown tab. */
  openReport(x, rep) {
    const props = { path: rep.path, root: rep.root };
    if (rep.run) props.report = { worktree: rep.run.worktree, repo: x.repo, routine: x.name, title: x.title };
    run("tab.new", { name: rep.path.split("/").pop(), mod: "pm-md", props });
  }

  routineAction(verb, x, cx) {
    const args = verb === "run" ? ["run", x.repo, x.name] : [verb, x.repo, x.name];
    cx.spawn(async (c) => {
      const r = await exec(ROUTINES_SH(), args, { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Routine ${verb} failed`, body: String((r.stderr || r.stdout) ?? "").trim().split("\n").pop(), level: "error" });
      else if (verb === "run") notify({ title: "Routine started", body: x.title, level: "info", timeout: 3000 });
      this.routBusy = false;
      this.pollRoutines(c);
    });
  }

  openRoutineSettings(x) {
    run("tab.new", { name: x.title, mod: "pm-routine", props: { repo: x.repo, routine: x.name } });
  }

  newRoutine() {
    const p = this.selectedProject();
    run("tab.new", { name: "New routine", mod: "pm-routine", props: p ? { repo: p.main } : {} });
  }

  newLinear(issue) {
    const p = this.selectedProject();
    openOverlay({
      mod: "pm-workspace-new", kind: "dialog", width: 560, height: 640,
      props: { source: "linear", ...(issue ? { issue } : {}), ...(p ? { project: { main: p.main, name: p.name } } : {}) },
    });
  }

  openSettings() {
    const sp = spaces().find((s) => s.active);
    const tab = sp?.tabs.find((t) => t.name === "Settings");
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { name: "Settings", mod: "pm-settings", props: { section: "general" } });
  }

  routineStatus(x) {
    const mono = (t, color) => div().flex_none().font_family(MONO).text_size(SIZE.caps).text_color(color).child(t);
    const when = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
    if (x.status === "running") {
      const d = when(x.lastRun);
      return h_flex().flex_none().gap(5).items_center()
        .child(StatusDot("running", 10))
        .child(mono(`running \u00b7 ${d ? minutes(Date.now() - d.getTime()) : "now"}`, C.yellow));
    }
    if (x.status === "to-review") {
      const d = when(x.lastRun);
      return h_flex().flex_none().gap(6).items_center()
        .when(Boolean(d), (el) => el.child(mono(clock(d), C.muted)))
        .child(div().min_w(15).h(15).px(4).rounded(8).bg(C.ember).flex().items_center().justify_center()
          .text_size(10).font_semibold().text_color(C.bg).child(String(x.toReview)));
    }
    if (x.status === "paused") return mono("paused", C.dim);
    if (x.status === "failed") return h_flex().flex_none().gap(4).items_center().child(mono("failed", C.red)).child(icon("x", 10, C.red));
    if (x.status === "missed") return h_flex().flex_none().gap(4).items_center().child(mono("missed", C.muted)).child(icon("ring", 10, C.muted));
    const d = when(x.next);
    return mono(d ? `${DAYS[d.getDay()]} ${clock(d)}` : "", C.muted);
  }

  routineRows(body) {
    const list = this.routines();
    body.child(SectionHeader({ id: "routines", label: "Routines", onAdd: () => this.newRoutine(), addTip: "New routine" }));
    if (!list.length) {
      if (!this.loaded) return;
      body.child(v_flex().id("routine-empty").px(16).pb(2).gap(3).cursor_pointer().on_click(() => this.newRoutine())
        .child(div().text_size(12.5).text_color(C.text2).child("Schedule Claude to do recurring work"))
        .child(div().text_size(SIZE.meta).text_color(C.muted).child("A morning brief, a weekly PR review, a Linear triage."))
        .child(h_flex().mt(3).gap(5).items_center()
          .child(div().text_size(SIZE.meta).text_color(C.ember).child("New routine"))
          .child(div().font_family(MONO).text_size(SIZE.meta).text_color(C.ember).child("\u2318\u21e7N"))));
      return;
    }
    for (const x of list) {
      const key = `${x.repo}#${x.name}`;
      const open = this.routOpen.has(key);
      const hot = this.routHover === key;
      const off = x.status === "paused";
      const tint = off ? C.dim : (ROUTINE_COLORS[x.color] ?? ROUTINE_COLORS.ember);
      const act = (id, tip, name, fn) => div().id(`${id}-${key}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .tooltip(tip).hover((s) => s.bg(C.raised))
        .on_mouse_down("left", (_e, c) => c.stop_propagation())
        .on_click((_e, c) => { c.stop_propagation(); fn(c); })
        .child(icon(name, 12, C.muted));
      body.child(Row({ id: `routine-${key}`, height: 30, onClick: (_e, c) => this.toggleRoutine(x, c) })
        .on_hover((h, c) => { if (h) this.routHover = key; else if (this.routHover === key) this.routHover = null; c.notify(); })
        .child(div().w(12).flex_none().flex().justify_center().child(icon(open ? "chevron-down" : "chevron-right", 12, C.dim)))
        .child(svg(`mods/pm-routine/lucide/${x.icon || "clock"}.svg`).size(16).flex_none().text_color(tint))
        .child(div().id(`routine-title-${key}`).flex_1().min_w(0).truncate().text_color(off ? C.dim : C.text2).cursor_pointer()
          .hover((s) => s.text_color(C.text))
          .on_click((_e, c) => { c.stop_propagation(); this.openRoutineSettings(x); }).child(x.title))
        .when(hot, (el) => el.child(h_flex().flex_none().gap(2)
          .child(act("rrun", "Run now", "play", (c) => this.routineAction("run", x, c)))
          .child(off ? act("rres", "Resume", "circle-play", (c) => this.routineAction("resume", x, c))
            : act("rpause", "Pause", "pause", (c) => this.routineAction("pause", x, c)))))
        .child(this.routineStatus(x)));
      if (!open) continue;
      const reps = this.routReports[key] ?? [];
      if (!reps.length) body.child(h_flex().h(24).flex_none().mx(8).pl(36).items_center().text_size(SIZE.meta).text_color(C.dim).child("No reports yet"));
      for (const rep of reps) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(rep.date);
        const label = m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : rep.date;
        body.child(Row({ id: `rep-${key}-${rep.date}`, height: 24, onClick: () => this.openReport(x, rep) }).pl(36)
          .child(icon("file-text", 12, C.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(SIZE.meta).text_color(rep.run ? C.text2 : C.muted).child(label))
          .child(rep.run ? div().flex_none().font_family(MONO).text_size(SIZE.caps).text_color(C.ember).child("to review") : div()));
      }
    }
  }

  async loadUsage(cx) {
    cx.spawn(async (c) => {
      try {
        const txt = await readTextFile(USAGE_CACHE);
        this.usage = txt ? JSON.parse(txt) : null;
      } catch {
        this.usage = null;
      }
      c.notify();
    });
  }

  // ---- derived -------------------------------------------------------------

  // Agent states per checkout path (deepest checkout containing the pane's folder wins).
  states() {
    const ps = panes(), sp = spaces();
    const paths = this.projects.flatMap((p) => p.wts.map((w) => w.path));
    const by = {};
    for (const a of agents()) {
      const cwd = ps.find((p) => p.pane === a.pane)?.cwd;
      if (!cwd) continue;
      const path = paths.filter((p) => inside(cwd, p)).sort((x, y) => y.length - x.length)[0];
      if (!path) continue;
      const tab = sp.find((s) => s.id === a.space)?.tabs.find((tb) => tb.id === a.tab);
      const cur = by[path] ?? { status: "idle", since: null, agents: [] };
      cur.agents.push(a);
      if ((URGENCY[a.status] ?? 0) > (URGENCY[cur.status] ?? 0)) cur.status = a.status;
      if (a.status === "working" && tab?.working_since) cur.since = Math.min(cur.since ?? Infinity, tab.working_since);
      by[path] = cur;
    }
    return by;
  }

  activePath() {
    const sp = spaces().find((s) => s.active);
    const cwd = focused()?.cwd || (sp ? place(sp, panes()) : null);
    if (!cwd) return null;
    const paths = this.projects.flatMap((p) => p.wts.map((w) => w.path));
    return paths.filter((p) => inside(cwd, p)).sort((x, y) => y.length - x.length)[0] ?? null;
  }

  selectedProject() {
    const ap = this.activePath();
    return this.projects.find((p) => p.wts.some((w) => w.path === ap)) ?? this.projects[0] ?? null;
  }

  /** Order: questions, CI failing, routine reports, review requests, Linear. */
  inbox(states) {
    const items = [];
    for (const [path, st] of Object.entries(states)) {
      for (const a of st.agents.filter((x) => x.status === "blocked")) {
        const pr = this.projects.find((p) => p.wts.some((w) => w.path === path));
        const w = pr?.wts.find((x) => x.path === path);
        items.push({ kind: "agent", key: `a-${a.address}`, agent: a, title: w ? this.wtName(w) : a.space_name, sub: "Claude is waiting" });
      }
    }
    const prMap = shared("pm.pr") ?? {};
    for (const p of this.projects) for (const w of p.wts) {
      const pr = prMap[w.path];
      if (w.main || !pr || pr.state !== "open" || pr.ci !== "failing") continue;
      items.push({ kind: "ci", key: `ci-${w.path}`, wt: w, title: this.wtName(w), sub: `PR #${pr.number} \u00b7 CI failing` });
    }
    for (const x of this.routines()) for (const r of x.runs ?? []) {
      const m = /(\d{4})-(\d{2})-(\d{2})/.exec(r.report.split("/").pop());
      const date = m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
      const n = r.changes ?? 0;
      items.push({
        kind: "report", key: `rr-${r.worktree}`, x, rep: { path: r.report.slice(r.worktree.length + 1), root: r.worktree, run: r },
        title: x.title, sub: [date, n ? `${n} change${n === 1 ? "" : "s"} to review` : "report to review"].filter(Boolean).join(" \u00b7 "),
      });
    }
    const prs = [...this.prs].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    for (const p of prs) {
      const repo = (p.repository?.nameWithOwner ?? p.repository?.name ?? "").split("/").pop();
      const at = Date.parse(p.updatedAt ?? "");
      items.push({ kind: "pr", key: `pr-${p.url}`, url: p.url, title: `${repo} #${p.number}`, sub: "review requested", time: at ? ago(at / 1000) : "" });
    }
    const lin = shared("pm.linear");
    if (Array.isArray(lin)) {
      for (const i of lin.filter((x) => /^(backlog|todo|to do|triage|unstarted)$/i.test(x.state ?? "")).slice(0, 3)) {
        items.push({ kind: "linear", key: `lin-${i.id}`, issue: i, title: i.identifier, sub: i.title });
      }
    }
    return items;
  }

  // Local spaces whose folder is not inside any known checkout (e.g. the home folder).
  others() {
    const ps = panes();
    const paths = this.projects.flatMap((p) => p.wts.map((w) => w.path));
    const list = spaces().filter((s) => {
      if (s.machine) return false;
      const at = place(s, ps);
      return at && !paths.some((p) => inside(at, p));
    });
    const ids = new Set(list.map((s) => s.id));
    let status = "idle";
    for (const a of agents()) if (ids.has(a.space) && (URGENCY[a.status] ?? 0) > (URGENCY[status] ?? 0)) status = a.status;
    const urg = (s) => Math.max(0, ...agents().filter((a) => a.space === s.id).map((a) => URGENCY[a.status] ?? 0));
    const best = [...list].sort((x, y) => urg(y) - urg(x))[0];
    return { list, status, best, active: list.some((s) => s.active) };
  }

  openHome() {
    const o = this.others();
    if (o.list.some((s) => s.active)) return;
    if (o.best) run("space.select", { id: o.best.id });
    else run("space.new", { folder: home(), name: "~", tab: "claude", argv: ["claude"] });
  }

  wtName(w) { return w.branch ? w.branch.split("/").pop() : base(w.path); }

  // ---- actions -------------------------------------------------------------

  spaceFor(path) {
    const ps = panes();
    const paths = this.projects.flatMap((p) => p.wts.map((w) => w.path));
    return spaces().find((s) => {
      if (s.machine) return false;
      const at = place(s, ps);
      if (!at || !inside(at, path)) return false;
      return !paths.some((o) => o !== path && o.length > path.length && inside(at, o));
    });
  }

  openWorktree(w) {
    const s = this.spaceFor(w.path);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: w.path, name: this.wtName(w) });
  }

  openProject(p) {
    const w = p.wts.find((x) => !x.main && this.spaceFor(x.path)) ?? p.wts.find((x) => !x.main) ?? p.wts[0];
    if (w) this.openWorktree(w);
  }

  scratch(p) {
    if (!p) return;
    const argv = ["claude", "--permission-mode", "plan"];
    const s = this.spaceFor(p.main);
    if (!s) { run("space.new", { folder: p.main, name: p.name, tab: "scratch", argv }); return; }
    run("space.select", { id: s.id });
    const tab = s.tabs.find((t) => t.name === "scratch");
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { space: s.id, name: "scratch", folder: p.main, argv });
  }

  openItem(it) {
    if (it.kind === "pr") { exec("open", [it.url]).catch(() => {}); return; }
    if (it.kind === "ci") { this.openWorktree(it.wt); return; }
    if (it.kind === "report") { this.openReport(it.x, it.rep); return; }
    if (it.kind === "linear") { this.newLinear(it.issue.id); return; }
    const a = it.agent;
    run("space.select", { id: a.space });
    run("tab.select", { id: a.tab });
    run("pane.focus", { pane: a.pane });
  }

  async addProject(cx) {
    const dir = await pickFolder({ prompt: "Add project" });
    if (!dir) return;
    const main = await mainOf(dir);
    if (!main) { notify({ title: "Not a git repository", body: dir, level: "warning" }); return; }
    if (!this.saved.includes(main)) {
      this.saved = [...this.saved, main];
      localStorage.setItem("pm.projects", JSON.stringify(this.saved));
    }
    this.mainOfCache[dir] = main;
    this.refresh(cx);
  }

  importConductor(cx) {
    cx.spawn(async (c) => {
      const r = await exec("sh", ["-c", "ls -d ~/conductor/workspaces/*/* 2>/dev/null"], { timeout: 10000 }).catch(() => null);
      for (const d of (r?.stdout ?? "").split("\n").filter(Boolean)) {
        const m = await mainOf(d);
        if (m && !this.saved.includes(m)) this.saved.push(m);
      }
      localStorage.setItem("pm.projects", JSON.stringify(this.saved));
      this.refresh(c);
    });
  }

  toggleFold(main, cx) {
    this.folded.has(main) ? this.folded.delete(main) : this.folded.add(main);
    localStorage.setItem("pm.folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  command(cmd, cx) {
    const states = this.states();
    if (cmd === "toggle") {
      run("layout.resize", { id: "sidebar", px: narrow() ? FULL_WIDTH : RAIL_WIDTH });
    } else if (cmd === "scratch") {
      this.scratch(this.selectedProject());
    } else if (cmd === "inbox") {
      const first = this.inbox(states)[0];
      if (first) this.openItem(first);
    } else if (cmd === "new") {
      this.newWorkspace();
    } else if (cmd === "new-linear") {
      this.newLinear();
    } else if (cmd === "new-routine") {
      this.newRoutine();
    } else if (cmd === "settings") {
      this.openSettings();
    } else if (/^ws[1-9]$/.test(cmd)) {
      const w = this.projects.flatMap((p) => p.wts.filter((x) => !x.main))[Number(cmd.slice(2)) - 1];
      if (w) this.openWorktree(w);
    }
    void cx;
  }

  newWorkspace() {
    const p = this.selectedProject();
    openOverlay({
      mod: "pm-workspace-new", kind: "dialog", width: 560, height: 640,
      props: p ? { project: { main: p.main, name: p.name } } : {},
    });
  }

  toggleArchived(main, cx) {
    this.archOpen.has(main) ? this.archOpen.delete(main) : this.archOpen.add(main);
    localStorage.setItem("pm.archOpen", JSON.stringify([...this.archOpen]));
    cx.notify();
  }

  archivedOf(p) {
    const list = shared("pm.archived");
    return Array.isArray(list) ? list.filter((r) => r && r.main === p.main) : [];
  }

  archivedRows(p, body) {
    const recs = this.archivedOf(p);
    if (!recs.length) return;
    const open = this.archOpen.has(p.main);
    body.child(Row({ id: `arch-${p.main}`, height: 26, onClick: (_e, c) => this.toggleArchived(p.main, c) })
      .child(div().w(12).flex_none().flex().justify_center().child(icon(open ? "chevron-down" : "chevron-right", 12, C.dim)))
      .child(div().flex_1().text_size(SIZE.meta).text_color(C.muted).child(`Archived \u00b7 ${recs.length}`)));
    if (!open) return;
    for (const rec of recs) {
      const key = `${rec.main}#${rec.branch}`;
      const hot = this.archHover === key;
      body.child(Row({ id: `archrow-${key}`, height: 28 })
        .on_hover((h, c) => { if (h) this.archHover = key; else if (this.archHover === key) this.archHover = null; c.notify(); })
        .child(div().w(12).flex_none().flex().justify_center().child(icon("archive", 12, C.dim)))
        .child(div().flex_1().min_w(0).truncate().text_color(C.dim).child(rec.name ?? rec.branch))
        .child(hot
          ? h_flex().flex_none().gap(8).items_center()
            .child(div().id(`restore-${key}`).text_size(SIZE.meta).text_color(C.ember).cursor_pointer()
              .on_click(() => openOverlay({ mod: "pm-git", kind: "dialog", width: 340, height: 96, props: { restore: rec } })).child("Restore"))
            .child(div().id(`forget-${key}`).size(16).flex().items_center().justify_center().rounded(4).cursor_pointer()
              .tooltip("Forget").hover((s) => s.bg(C.raised))
              .on_click((_e, c) => { c.stop_propagation(); this.forget(rec, c); })
              .child(icon("x", 12, C.muted)))
          : rec.pr ? div().flex_none().font_family(MONO).text_size(SIZE.caps).text_color(C.dim).child(`PR #${rec.pr}`) : div()));
    }
  }

  /** Drops an archived entry; deletes its local branch only if fully merged (git branch -d, never -D). */
  forget(rec, cx) {
    const list = shared("pm.archived");
    setShared("pm.archived", (Array.isArray(list) ? list : []).filter((r) => !(r && r.main === rec.main && r.branch === rec.branch)));
    if (this.archHover === `${rec.main}#${rec.branch}`) this.archHover = null;
    if (!rec.branch) return;
    cx.spawn(async (c) => {
      const has = await git(rec.main, ["rev-parse", "--verify", "-q", `refs/heads/${rec.branch}`]);
      if (!has.ok) return;
      const d = await git(rec.main, ["branch", "-d", rec.branch]);
      if (!d.ok) notify({ title: `Kept branch ${rec.branch}`, body: "It has commits that aren't merged.", level: "info" });
      this.refresh(c);
    });
  }

  // ---- render --------------------------------------------------------------

  render(cx) {
    if (this.role === "footer") return this.renderFooter();
    if (this.role === "titlebar") return this.renderTitlebar();
    return this.renderSidebar(cx);
  }

  renderTitlebar() {
    // Native traffic lights sit at the left (layout traffic_lights); the name sits right.
    const bar = h_flex().size_full().px(16).items_center().justify_end().gap(8);
    return narrow() ? bar : bar
      .child(div().id("open-settings").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .tooltip("Settings").hover((s) => s.bg(C.raised))
        .on_mouse_down("left", (_e, c) => c.stop_propagation())
        .on_click(() => this.openSettings()).child(icon("cog", 14, C.muted)))
      .child(div().text_size(SIZE.body).font_semibold().text_color(C.text).child("herdr"));
  }

  scratchSelected(p, ap) {
    const sp = spaces().find((s) => s.active);
    return sp?.tabs.find((t) => t.active)?.name === "scratch" && p.wts.some((w) => w.path === ap);
  }

  renderSidebar(cx) {
    const states = this.states();
    const collapsed = narrow();
    const items = this.inbox(states);
    const root = v_flex().size_full().min_h(0).text_size(SIZE.body).text_color(C.text2);
    if (collapsed) return root.child(this.rail(states, items));
    const body = v_flex().flex_1().min_h(0).gap(1).overflow_y_scrollbar().pb(12);
    // Inbox is always there; empty, it says so in one dim row.
    body.child(SectionHeader({ id: "inbox", label: "Inbox", count: items.length, countColor: items.length ? C.ember : C.dim, hint: "\u2318 0" }).mt(4));
    for (const it of items) body.child(this.inboxRow(it));
    if (!items.length) body.child(Row({ id: "inbox-clear", height: 28 })
      .child(div().w(12).flex_none().flex().justify_center().child(icon("check", 12, C.dim)))
      .child(div().flex_1().text_size(12.5).text_color(C.dim).child("All clear")));
    body.child(Sep(10, 8));
    this.routineRows(body);
    body.child(Sep(13, 8));
    if (!this.loaded) return root.child(body);
    if (!this.projects.length) body.child(this.empty());
    body.child(SectionHeader({ id: "projects", label: "Projects", onAdd: (_e, c) => this.addProject(c), addTip: "Add project" }));
    const sel = this.activePath();
    const current = this.selectedProject();
    let index = 0, first = true;
    const head = (id, name, fold, dots, onClick) => {
      const row = Row({ id, height: 30, onClick })
        .child(icon(fold ? "chevron-right" : "chevron-down", 12, C.dim))
        .child(div().flex_1().truncate().text_color(C.text).font_semibold().child(name))
        .when(fold && dots.length > 0, (el) => el.child(h_flex().gap(4).children(dots.map((k) => div().size(6).rounded(3).bg(colorOfKind(k))))));
      if (!first) row.mt(10);
      first = false;
      return row;
    };
    // Spaces outside any repo (home folder, plain folders) live under "~".
    const o = this.others();
    const hf = this.folded.has("~");
    body.child(head("proj-home", "~", hf, o.status !== "idle" ? [kindOf(o.status)] : [], (_e, c) => this.toggleFold("~", c)));
    if (!hf) {
      body.child(Row({ id: "scratch-home", height: 28, selected: o.active, onClick: () => this.openHome() })
        .child(div().w(12).flex_none().flex().justify_center().child(icon("message-square", 12, C.muted)))
        .child(div().flex_1().text_color(o.active ? C.text : C.muted).when(o.active, (el) => el.font_medium()).child("Scratch"))
        .when(o.status !== "idle", (el) => el.child(div().w(12).flex_none().flex().justify_center().child(StatusDot(kindOf(o.status), 12)))));
    }
    for (const p of this.projects) {
      const fold = this.folded.has(p.main);
      const dots = [...new Set(p.wts.map((w) => states[w.path]?.status).filter((x) => x && x !== "idle"))].map(kindOf);
      body.child(head(`proj-${p.main}`, p.name, fold, dots, (_e, c) => this.toggleFold(p.main, c)));
      if (fold) { index += p.wts.filter((w) => !w.main).length; continue; }
      const on = this.scratchSelected(p, sel);
      body.child(Row({ id: `scratch-${p.main}`, height: 28, selected: on, onClick: () => this.scratch(p) })
        .child(div().w(12).flex_none().flex().justify_center().child(icon("message-square", 12, C.muted)))
        .child(div().flex_1().text_color(on ? C.text : C.muted).when(on, (el) => el.font_medium()).child("Scratch"))
        .when(current === p, (el) => el.child(Kbd("\u2318J"))));
      for (const w of p.wts.filter((x) => !x.main)) {
        index += 1;
        body.child(this.worktreeRow(w, states[w.path], sel === w.path && !on, index, p));
      }
      this.archivedRows(p, body);
    }
    return root.child(body);
  }

  tile(p, size) {
    return div().size(size).flex_none().flex().items_center().justify_center().rounded(4).bg(C.raised)
      .text_size(size > 20 ? 15 : 10.5).font_semibold().text_color(p.color).child([...p.name][0]?.toUpperCase() ?? "?");
  }

  aggregate(p, states) {
    let best = "idle";
    for (const w of p.wts) {
      const s = states[w.path]?.status;
      if (s && (URGENCY[s] ?? 0) > (URGENCY[best] ?? 0)) best = s;
    }
    return best;
  }

  inboxRow(it) {
    return Row({ id: it.key, height: 28, onClick: () => this.openItem(it) })
      .child(div().w(12).flex_none().flex().justify_center()
        .child(it.kind === "agent" ? StatusDot("waiting", 12)
          : it.kind === "ci" ? StatusDot("failed", 12)
          : it.kind === "report" ? icon("file-text", 12, C.ember)
          : it.kind === "linear" ? icon("circle-dot", 12, C.muted)
          : icon("git-pull-request", 12, C.muted)))
      .child(h_flex().flex_1().min_w(0).gap(4).text_size(12.5)
        .child(div().flex_none().max_w(150).truncate().text_color(C.text).when(it.kind === "linear", (el) => el.font_family(MONO)).child(it.title))
        .child(div().flex_1().min_w(0).truncate().text_color(C.muted).child(`\u00b7 ${it.sub}`)))
      .when(Boolean(it.time), (el) => el.child(div().flex_none().text_size(SIZE.caps).text_color(C.dim).child(it.time)));
  }

  archiveWorktree(w, p) {
    openOverlay({ mod: "pm-git", kind: "dialog", width: 340, height: 96, props: { archive: { path: w.path, repo: base(p.main), main: p.main, name: this.wtName(w), branch: w.branch } } });
  }

  worktreeRow(w, st, selected, index, p) {
    const status = st?.status ?? "idle";
    let line2, color;
    if (status === "blocked") { line2 = "Claude is waiting"; color = C.ember; }
    else if (status === "working") { line2 = `Claude working \u00b7 ${st.since ? minutes(Date.now() - st.since) : "now"}`; color = C.muted; }
    else if (status === "done") { line2 = "Claude finished"; color = "#7FC27F"; }
    else { line2 = w.at ? `idle \u00b7 ${ago(w.at)} ago` : "idle"; color = C.muted; }
    let prIcon = null;
    if (status === "idle" || status === "done") {
      const pr = (shared("pm.pr") ?? {})[w.path];
      if (pr && pr.state === "open") {
        if (pr.ci === "failing") { line2 = `PR #${pr.number} \u00b7 CI failing`; color = C.red; prIcon = ["x", C.red]; }
        else if (pr.ci === "pending") { line2 = `PR #${pr.number} \u00b7 checks running`; color = C.yellow; prIcon = ["git-pull-request", C.yellow]; }
        else if (pr.ci === "passing" && pr.review !== "changes" && pr.review !== "required") { line2 = `PR #${pr.number} \u00b7 Ready to merge`; color = C.greenText; prIcon = ["git-branch", C.green]; }
      }
    }
    const hot = this.wtHover === w.path;
    return Row({ id: `wt-${w.path}`, selected, onClick: () => this.openWorktree(w) })
      .py(6).items_start()
      .on_hover((h, c) => { if (h) this.wtHover = w.path; else if (this.wtHover === w.path) this.wtHover = null; c.notify(); })
      .child(div().w(12).h(18).flex_none().flex().items_center().justify_center().child(StatusDot(kindOf(status), 12)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().h(18).text_color(selected ? C.text : C.text2).when(selected, (el) => el.font_medium()).child(this.wtName(w)))
          .child(DiffPill(w.add, w.del)))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().flex_1().min_w(0).gap(4).items_center().h(14)
            .when(Boolean(prIcon), (el) => el.child(icon(prIcon[0], 10, prIcon[1])))
            .child(div().flex_1().min_w(0).truncate().text_size(SIZE.caps).text_color(color).child(line2)))
          .child(hot
            ? div().id(`archive-${w.path}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
              .tooltip("Archive")
              .on_mouse_down("left", (_e, c) => c.stop_propagation())
              .on_click((_e, c) => { c.stop_propagation(); this.archiveWorktree(w, p); })
              .on_hover((h, c) => { this.archBtn = h ? w.path : null; c.notify(); })
              .child(icon("archive", 13, this.archBtn === w.path ? C.ember : C.muted))
            : index <= 9 ? Kbd(`\u2318${index}`) : div())));
  }

  empty() {
    return v_flex().px(16).pt(28).gap(10).items_start()
      .child(icon("folder-plus", 20, C.muted))
      .child(div().text_size(SIZE.title).text_color(C.text).child("No projects yet"))
      .child(div().text_size(SIZE.meta).text_color(C.muted).child("Add a git repository to start working with Claude."))
      .child(div().id("add-project").h(30).px(12).flex().items_center().rounded(7).bg(C.ember).text_color(C.bg).font_medium()
        .cursor_pointer().on_click((_e, c) => this.addProject(c)).child("Add project"))
      .child(div().id("import-conductor").text_size(SIZE.meta).text_color(C.link).cursor_pointer()
        .on_click((_e, c) => this.importConductor(c)).child("Import Conductor workspaces"));
  }

  rail(states, items) {
    const col = v_flex().flex_1().min_h(0).items_center().gap(6).pt(8).overflow_y_scrollbar();
    const dot = (kind) => div().absolute().right(2).bottom(2).size(9).rounded(5).border_2().border_color(C.bg).bg(colorOfKind(kind));
    const tile = (id, tip, letter, color, on, kind, onClick) =>
      div().id(id).relative().size(40).flex_none().flex().items_center().justify_center().rounded(10)
        .bg(on ? "#2C261F" : "#201C17").when(on, (el) => el.border_1().border_color("#E0874F66"))
        .tooltip(tip).hover((s) => s.bg(C.raised)).on_click(onClick)
        .child(div().text_size(14).font_semibold().text_color(color).child(letter))
        .when(kind !== "idle", (el) => el.child(dot(kind)));
    col.child(div().id("rail-inbox").relative().size(40).flex_none().flex().items_center().justify_center().rounded(9)
      .tooltip(items.length ? `Inbox \u00b7 ${items.length}` : "Inbox").hover((s) => s.bg(C.raised))
      .on_click(() => { const f = items[0]; if (f) this.openItem(f); })
      .child(icon("inbox", 18, items.length ? C.text2 : C.dim))
      .when(items.length > 0, (el) => el.child(div().absolute().top(3).right(2).min_w(15).h(15).px(4).rounded(8).bg(C.ember).flex().items_center().justify_center()
        .text_size(10).font_semibold().text_color(C.bg).child(String(items.length)))));
    col.child(div().w(32).h(1).flex_none().my(8).bg(C.line1));
    const o = this.others();
    col.child(tile("rail-home", "~", "~", C.muted, o.active, o.status === "idle" ? "idle" : kindOf(o.status), () => this.openHome()));
    const sel = this.activePath();
    for (const p of this.projects) {
      const agg = this.aggregate(p, states);
      const on = p.wts.some((w) => w.path === sel);
      col.child(tile(`rail-${p.main}`, p.name, [...p.name][0]?.toUpperCase() ?? "?", p.color, on, agg === "idle" ? "idle" : kindOf(agg), () => this.openProject(p)));
    }
    col.child(div().flex_1());
    col.child(div().id("rail-settings").size(40).flex_none().flex().items_center().justify_center().rounded(10).mb(6)
      .tooltip("Settings").hover((s) => s.bg(C.raised)).on_click(() => this.openSettings()).child(icon("cog", 16, C.muted)));
    return col;
  }

  // ---- footer --------------------------------------------------------------

  meter(label, pct, resetIso, style, accent, labelColor) {
    const p = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
    const fill = p == null ? C.dim : p > 90 ? C.red : p > 70 ? C.yellow : accent;
    const d = resetIso ? new Date(resetIso) : null;
    let when = "\u00b7";
    if (d && !Number.isNaN(d.getTime())) {
      when = style === "time"
        ? `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "a" : "p"}`
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    }
    return h_flex().h(16).gap(8).items_center().font_family(MONO).text_size(SIZE.caps)
      .child(div().w(26).flex_none().text_color(labelColor).child(label))
      .child(div().flex_1().h(3).rounded(2).bg(C.line2).overflow_hidden()
        .child(div().h(3).rounded(2).bg(fill).w(`${p ?? 0}%`)))
      .child(h_flex().w(68).flex_none().justify_end().gap(4)
        .child(div().text_color(p != null && p > 70 ? fill : accent).child(p == null ? "\u00b7" : `${p}%`))
        .child(div().text_color(C.dim).child(when)));
  }

  renderFooter() {
    const u = this.usage;
    const now = Date.now();
    // The cache is written by the Claude Code statusline: ignore it once its window has reset.
    const fresh = (w) => w && w.resets_at && new Date(w.resets_at).getTime() > now ? w : null;
    const five = fresh(u?.five_hour), week = fresh(u?.seven_day);
    const compact = narrow();
    const button = div().id("new-workspace").h(32).flex().items_center().justify_center().gap(8).rounded(compact ? 10 : 7)
      .border_1().border_color(C.line3).text_size(SIZE.body).text_color(C.text).cursor_pointer()
      .hover((s) => s.bg(C.raised)).on_click(() => this.newWorkspaceFromFooter())
      .when(compact, (el) => el.size(40).tooltip("New workspace").child(icon("plus", 16, C.ember)))
      .when(!compact, (el) => el.mx(16).px(10).justify_start()
        .child(icon("plus", 14, C.ember)).child(div().flex_1().child("New workspace"))
        .child(div().font_family(MONO).text_size(SIZE.caps).text_color(C.muted).child("\u2318N")));
    if (compact) {
      const pct = five ? Math.max(0, Math.min(100, Math.round(five.utilization))) : 0;
      return v_flex().size_full().items_center().justify_end().gap(4).pb(14)
        .child(v_flex().items_center().gap(4).pb(6).tooltip("5h usage")
          .child(div().size(30).flex().items_center().justify_center().child(svg(`${ICONS}${five ? `ring-p${String(Math.round(pct / 5) * 5).padStart(3, "0")}` : "ring-p000"}.svg`).size(30).flex_none().text_color(pct > 90 ? C.red : pct > 70 ? C.yellow : five ? C.ember : C.dim)))
          .child(div().font_family(MONO).text_size(10).text_color(C.ember).child(five ? `5h ${pct}%` : "5h \u00b7")))
        .child(button);
    }
    return v_flex().size_full().justify_end().gap(12).py(14).border_t(1).border_color(C.line1)
      .child(v_flex().px(18).gap(5)
        .child(this.meter("5h", five?.utilization, five?.resets_at, "time", C.ember, C.text2))
        .child(this.meter("wk", week?.utilization, week?.resets_at, "day", C.dim, C.dim)))
      .child(button);
  }

  newWorkspaceFromFooter() {
    run("pm-sidebar.new");
  }

}
