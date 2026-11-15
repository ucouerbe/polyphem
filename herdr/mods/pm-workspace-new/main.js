// @ts-check
// New workspace dialog (screen 09). Open it with:
//   openOverlay({ mod: "pm-workspace-new", kind: "dialog", width: 560, height: 640,
//                 props: { project: { main: "/abs/path/of/repo", name: "repo" } } })
// `project` may also be an absolute path string; without it the focused pane's repo is used.
// Creates ~/.herdr/worktrees/<repo>/<name> (git worktree add), a Herdr space there, and a
// tab running `claude --permission-mode plan|auto --model <id> "<first task>"`.
// Options come from <repo>/.herdr/project.json (spec 4.1): base, copy, setup, run, ports.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, appHome, readTextFile, shared, setShared } from "herdr";
import { C, SIZE, MONO, icon } from "./ui.js";

const LINEAR_BIN = () => `${home()}/.local/share/herdr-linear/app/0.14.5/herdr-linear`;
/** One request to herdr-linear's app CLI (JSON in, JSON out). Never rejects: { error, signedOut } on failure. */
async function linearAsk(req) {
  try {
    const r = await exec("sh", ["-c", '[ -x "$0" ] && exec "$0" app "$1"', LINEAR_BIN(), JSON.stringify(req)], { timeout: 45000 });
    return parse(r.stdout ?? "") ?? { error: (r.stderr || "herdr-linear is not installed").trim().split("\n").pop(), missing: r.code !== 0 && !r.stdout };
  } catch (e) { return { error: String(e), missing: true }; }
}

const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];
const SOURCES = [["main", "main"], ["branch", "Branch"], ["pr", "PR"], ["linear", "Linear issue"]];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

async function git(cwd, args, timeout) {
  try {
    const r = await exec("git", args, { cwd, timeout: timeout ?? 30000 });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
  } catch (e) { return { ok: false, out: "", err: String(e) }; }
}
async function mainOf(dir) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.ok && r.out.endsWith("/.git") ? r.out.slice(0, -5) : null;
}

/** Repos known from open spaces and panes, plus the one passed in. */
async function knownRepos(first) {
  const dirs = new Set();
  if (first) dirs.add(first);
  for (const s of spaces()) if (s.folder && !s.machine) dirs.add(s.folder);
  for (const p of panes()) if (p.cwd) dirs.add(p.cwd);
  const mains = new Map();
  for (const d of dirs) {
    const m = await mainOf(d);
    if (m && !mains.has(m)) mains.set(m, { main: m, name: m.split("/").pop() });
  }
  return [...mains.values()];
}

/** Port block: ports per workspace, starting at 4100, kept in shared("pm.ports"). */
function reservePort(path, size) {
  const map = { ...(shared("pm.ports") ?? {}) };
  if (map[path]) return map[path];
  const used = new Set(Object.values(map));
  let p = 4100;
  while (used.has(p)) p += size;
  map[path] = p;
  setShared("pm.ports", map);
  return p;
}

export default class PmWorkspaceNew extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const given = typeof p.project === "string" ? p.project : p.project?.main;
    this.repos = []; this.repo = null; this.source = p.source === "linear" ? "linear" : "main"; this.lin = { state: "idle", issues: [], picked: null }; this.demo = Boolean(p.demo); this.resume = typeof p.resume === "string" ? p.resume : null; this.wantIssue = p.issue ?? null; this.mode = "plan"; this.model = MODELS[0].id;
    this.menu = null; this.busy = false; this.error = ""; this.cfg = null; this.skip = new Set(); this.nameEdited = false;
    this.handle = cx.focus_handle(); this.handle.focus();
    const mk = (opts) => InputState.new(opts);
    this.nameIn = mk({ placeholder: "workspace-name" });
    this.refIn = mk({ placeholder: "branch name" });
    this.prIn = mk({ placeholder: "PR number" });
    this.linQ = mk({ placeholder: "Search your assigned issues" });
    this.linQ.on("change", (_e, cx) => cx.notify());
    this.linQ.on("focus", (_e, cx) => { this.focusOn = "linq"; cx.notify(); });
    this.task = TextareaState.new({ placeholder: "What should Claude work on first?", rows: 4 });
    this.nameIn.on("change", (_e, cx) => { const v = this.nameIn.value(); if (v !== this.autoName) this.nameEdited = true; cx.notify(); });
    this.nameIn.on("focus", (_e, cx) => { this.focusOn = "name"; cx.notify(); });
    this.task.on("focus", (_e, cx) => { this.focusOn = "task"; cx.notify(); });
    this.task.on("change", (_e, cx) => {
      if (!this.nameEdited) { this.autoName = slug(this.task.value().split(/\s+/).slice(0, 4).join("-")); this.nameIn.set_value(this.autoName); }
      cx.notify();
    });
    this.refIn.on("focus", (_e, cx) => { this.focusOn = "ref"; cx.notify(); });
    this.prIn.on("focus", (_e, cx) => { this.focusOn = "ref"; cx.notify(); });
    cx.spawn(async (cx) => {
      const f = focused();
      this.repos = await knownRepos(given ?? f?.cwd ?? null);
      const want = given ? await mainOf(given) : null;
      this.repo = this.repos.find((r) => r.main === want) ?? this.repos[0] ?? null;
      await this.loadCfg();
      if (this.source === "linear") this.loadLinear(cx);
      // Props may prefill { name, task, mode, create: true } (Promote, automation).
      const dev = p.name || p.task || p.create || p.source ? p : null;
      if (dev?.name) { this.nameEdited = true; this.nameIn.set_value(dev.name); }
      if (dev?.task) this.task.set_value(dev.task);
      if (dev?.mode) this.mode = dev.mode;
      if (dev?.demo) this.demo = true;
      if (dev?.source) { this.source = dev.source; if (dev.source === "linear") this.loadLinear(cx); }
      cx.notify();
      this.task.focus();
      if (dev?.create) this.go(cx);
    });
  }

  /** Assigned issues through herdr-linear; published to shared("pm.linear") for the Inbox. */
  loadLinear(cx) {
    if (this.lin.state === "loading" || this.lin.state === "ready") return;
    this.lin.state = "loading"; cx.notify();
    cx.spawn(async (cx) => {
      const st = await linearAsk({ op: "status", demo: this.demo });
      if (st.missing) { this.lin = { ...this.lin, state: "error", error: "herdr-linear is not installed." }; cx.notify(); return; }
      if (!st.workspaces?.length) { this.lin = { ...this.lin, state: "out" }; cx.notify(); return; }
      const r = await linearAsk({ op: "list", tab: "mine", demo: this.demo });
      if (r.error) { this.lin = { ...this.lin, state: r.signedOut ? "out" : "error", error: r.error }; cx.notify(); return; }
      const issues = r.issues ?? [];
      if (!this.demo) setShared("pm.linear", issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, url: i.url, state: i.state?.name ?? "" })));
      this.lin = { ...this.lin, state: "ready", issues };
      const want = this.wantIssue && issues.find((i) => i.id === this.wantIssue || i.identifier === this.wantIssue);
      this.wantIssue = null;
      if (want) this.pickIssue(want, cx);
      cx.notify();
    });
  }

  /** Picks an issue: Name from identifier + title, First task from title, description and URL. */
  pickIssue(i, cx) {
    this.lin.picked = i.id;
    this.nameEdited = true; this.autoName = slug(`${i.identifier} ${i.title}`);
    this.nameIn.set_value(this.autoName);
    this.task.set_value(`${i.identifier}: ${i.title}\n\n${i.url}`);
    cx.notify();
    cx.spawn(async (cx) => {
      const d = await linearAsk({ op: "detail", issue: i.id, demo: this.demo });
      if (d.error || this.lin.picked !== i.id) return;
      this.task.set_value(`${i.identifier}: ${i.title}\n\n${d.description ?? ""}\n\n${i.url}`.replace(/\n{3,}/g, "\n\n"));
      cx.notify();
    });
  }

  connectLinear() {
    this.close();
    run("space.new", { name: "Linear sign-in", argv: [LINEAR_BIN(), "login"] });
  }

  linearPanel(cx) {
    const l = this.lin;
    const box = (...kids) => v_flex().gap(8).children(kids);
    if (l.state === "idle" || l.state === "loading") return div().h(34).flex().items_center().text_size(SIZE.meta).text_color(C.dim).child("Asking Linear\u2026");
    if (l.state === "out") return box(
      div().text_size(SIZE.meta).text_color(C.muted).child("Linear is not connected. Sign-in opens in your browser."),
      h_flex().id("lin-connect").h(30).px(12).self_start().items_center().rounded(7).bg(C.ember).text_color("#1B140D").font_medium().cursor_pointer()
        .hover((s) => s.opacity(0.9)).on_click(() => this.connectLinear()).child("Connect Linear"));
    if (l.state === "error") return div().text_size(SIZE.meta).text_color(C.red).child(l.error ?? "Linear failed.");
    const q = this.linQ.value().toLowerCase();
    const rows = l.issues.filter((i) => !q || `${i.identifier} ${i.title} ${i.state?.name ?? ""}`.toLowerCase().includes(q));
    return box(
      div().h(34).px(10).flex().items_center().rounded(7).border_1().border_color(this.focusOn === "linq" ? C.ember : C.line3).bg(C.surface)
        .child(Input.new(this.linQ).w_full().text_size(SIZE.body).text_color(C.text)),
      v_flex().h(84).overflow_y_scrollbar().children(rows.map((i) => {
        const on = l.picked === i.id;
        return h_flex().id(`lin-${i.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(on ? C.raised : "#00000000").hover((s) => s.bg(on ? C.raised : "#221D17")).on_click((_e, cx) => this.pickIssue(i, cx))
          .child(div().w(58).flex_none().font_family(MONO).text_size(SIZE.meta).text_color(C.muted).child(i.identifier))
          .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body).text_color(on ? C.text : C.text2).child(i.title))
          .child(div().flex_none().text_size(SIZE.caps).text_color(C.dim).child(i.state?.name ?? ""));
      })),
      ...(rows.length ? [] : [div().text_size(SIZE.meta).text_color(C.dim).child("No assigned issue matches.")]));
  }

  async loadCfg() {
    this.skip = new Set();
    if (!this.repo) { this.cfg = null; return; }
    const text = await readTextFile(`${this.repo.main}/.herdr/project.json`).catch(() => null);
    this.cfg = { base: "main", copy: [], run: {}, ports: 10, ...(parse(text ?? "null") ?? {}) };
    const have = [];
    for (const f of this.cfg.copy ?? []) if ((await readTextFile(`${this.repo.main}/${f}`).catch(() => null)) !== null) have.push(f);
    this.cfg.copy = have;
  }

  /** What project.json will do on creation: [{ id, label }]. */
  steps() {
    const c = this.cfg;
    if (!c) return [];
    const out = [];
    for (const f of c.copy ?? []) out.push({ id: `copy:${f}`, label: `copy ${f}` });
    if (c.setup) out.push({ id: "setup", label: c.setup });
    if (Object.keys(c.run ?? {}).length) out.push({ id: "port", label: `port :${this.port ?? 4100}` });
    for (const name of Object.keys(c.run ?? {})) out.push({ id: `run:${name}`, label: `${name} tab` });
    return out;
  }

  close() { closeOverlay(props().overlay); }

  name() { return slug(this.nameIn.value()); }

  go(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      this.busy = true; this.error = ""; cx.notify();
      try { this.error = await this.create(); } catch (e) { this.error = String(e); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  async create() {
    const repo = this.repo, name = this.name(), task = this.task.value().trim();
    if (!repo) return "Pick a project.";
    if (!name) return "Give the workspace a name.";
    const base = this.cfg?.base ?? "main";
    const path = `${home()}/.herdr/worktrees/${repo.name}/${name}`;
    if ((await readTextFile(`${path}/.git`).catch(() => null)) !== null) return `${tilde(path)} already exists.`;
    await git(repo.main, ["fetch", "--quiet", "origin"], 60000); // no remote is fine
    const baseRef = (await git(repo.main, ["rev-parse", "--verify", "--quiet", `origin/${base}`])).ok ? `origin/${base}` : base;
    let add;
    if (this.source === "branch") {
      const b = this.refIn.value().trim();
      if (!b) return "Type the branch to start from.";
      const local = (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`])).ok;
      const remote = (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`])).ok;
      if (!local && !remote) return `No branch named ${b}.`;
      add = local ? ["worktree", "add", path, b] : ["worktree", "add", "-b", b, path, `origin/${b}`];
    } else if (this.source === "pr") {
      const n = this.prIn.value().trim().replace(/^#/, "");
      if (!/^\d+$/.test(n)) return "Type a PR number.";
      const view = await exec("gh", ["pr", "view", n, "--json", "headRefName"], { cwd: repo.main, timeout: 30000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      const head = parse(view.stdout ?? "")?.headRefName;
      if (view.code !== 0 || !head) return `Cannot read PR #${n}: ${(view.stderr || "").trim().split("\n")[0]}`;
      const f = await git(repo.main, ["fetch", "origin", `pull/${n}/head:${head}`], 60000);
      if (!f.ok) return f.err;
      add = ["worktree", "add", path, head];
    } else {
      if ((await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).ok) return `A branch named ${name} already exists.`;
      add = ["worktree", "add", "-b", name, path, baseRef];
    }
    const wt = await git(repo.main, add, 600000);
    if (!wt.ok) return wt.err || "git worktree add failed.";

    const steps = this.steps().filter((s) => !this.skip.has(s.id));
    const has = (id) => steps.some((s) => s.id === id);
    for (const f of this.cfg?.copy ?? []) if (has(`copy:${f}`)) await exec("cp", ["-p", `${repo.main}/${f}`, `${path}/${f}`]).catch(() => null);
    const port = has("port") ? reservePort(path, this.cfg.ports ?? 10) : null;
    const env = port ? `HERDR_PORT=${port} ` : "";

    const mode = this.mode === "plan" ? "plan" : "auto";
    let argv;
    if (this.resume) {
      // claude --resume only finds sessions of the current folder: copy the transcript into the new worktree's project folder.
      const enc = path.replace(/[/.]/g, "-");
      await exec("sh", ["-c", 'src=$(ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -1); [ -n "$src" ] && mkdir -p "$HOME/.claude/projects/$2" && cp -n "$src" "$HOME/.claude/projects/$2/"', "sh", this.resume, enc]).catch(() => null);
      argv = ["claude", "--resume", this.resume, "--permission-mode", mode, "--model", this.model];
    } else argv = ["claude", "--permission-mode", mode, "--model", this.model, ...(task ? [task] : [])];
    run("space.new", { folder: path, tab: "claude", argv });
    // run() returns nothing: find the new space by its folder.
    let created = null;
    for (let i = 0; i < 25 && !created; i++) {
      await exec("sleep", ["0.2"]);
      const sp = spaces().find((x) => x.folder === path);
      if (sp) created = { space: sp.id, tab: sp.tabs[0]?.id };
    }
    if (!created) return "";
    if (has("setup") && this.cfg.setup) run("tab.new", { space: created.space, name: "setup", folder: path, argv: ["sh", "-c", `${this.cfg.setup}; exec "$SHELL"`] });
    for (const [tabName, cmd] of Object.entries(this.cfg?.run ?? {})) {
      if (has(`run:${tabName}`)) run("tab.new", { space: created.space, name: `${tabName}${port ? ` :${port}` : ""}`, folder: path, argv: ["sh", "-c", `${env}${cmd.replace(/\$HERDR_PORT/g, port ?? "")}; exec "$SHELL"`] });
    }
    if (created.tab) run("tab.select", { id: created.tab });
    return "";
  }

  // ---- UI ---------------------------------------------------------------------

  select(id, value, options, onPick) {
    const open = this.menu === id;
    return v_flex().relative().flex_1().min_w(0)
      .child(h_flex().id(`sel-${id}`).h(34).px(10).gap(6).items_center().rounded(7).border_1().border_color(open ? C.ember : C.line3).bg(C.surface)
        .cursor_pointer().hover((s) => s.bg(C.raised)).on_click((_e, cx) => { this.menu = open ? null : id; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_color(C.text).child(value)).child(icon("chevron-down", 12, C.muted)))
      .when(open, (e) => e.child(v_flex().id(`menu-${id}`).absolute().top(38).left(0).w_full().p(4).rounded(8).bg(C.raised).border_1().border_color(C.line3)
        .children(options.map((o, i) => h_flex().id(`opt-${id}-${i}`).h(28).px(8).items_center().rounded(5).cursor_pointer().text_color(C.text)
          .hover((s) => s.bg("#352D24")).on_click((_e, cx) => { this.menu = null; onPick(o, cx); cx.notify(); }).child(o.label)))));
  }

  field(label, child, grow = false) {
    return v_flex().gap(6).when(grow, (e) => e.flex_1().min_w(0)).child(div().text_size(SIZE.meta).text_color(C.muted).child(label)).child(child);
  }

  inputBox(state, on, grow) {
    return div().h(34).px(10).flex().items_center().rounded(7).border_1().border_color(this.focusOn === on ? C.ember : C.line3).bg(C.surface)
      .when(grow, (e) => e.flex_1()).child(Input.new(state).w_full().text_size(SIZE.body).text_color(C.text).font_family(on === "name" ? MONO : "Geist"));
  }

  render(cx) {
    const t = theme();
    void t;
    const repoName = this.repo?.name ?? "";
    const name = this.name();
    const steps = this.steps();
    const path = this.repo ? `${tilde(home())}/.herdr/worktrees/${repoName}/${name || "<name>"}`.replace(`${tilde(home())}`, "~") : "";
    const canCreate = Boolean(this.repo && name && !this.busy);
    const seg = (id, label, off, hint) => h_flex().id(`src-${id}`).h(26).px(10).gap(6).items_center().rounded(6).text_size(SIZE.meta + 0.5)
      .bg(this.source === id ? C.raised : "#00000000").text_color(off ? C.dim : this.source === id ? C.text : C.muted)
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.bg(this.source === id ? C.raised : "#221D17")).on_click((_e, cx) => { this.source = id; if (id === "linear") this.loadLinear(cx); cx.notify(); }))
      .when(off, (e) => e.cursor_not_allowed().tooltip(hint ?? ""))
      .child(label).when(Boolean(hint), (e) => e.child(div().font_family(MONO).text_size(10).text_color(C.dim).child(hint)));
    const toggle = (id, label) => h_flex().id(`mode-${id}`).h(24).px(10).items_center().rounded(5).text_size(SIZE.meta + 0.5).cursor_pointer()
      .bg(this.mode === id ? C.raised : "#00000000").text_color(this.mode === id ? C.text : C.muted).on_click((_e, cx) => { this.mode = id; cx.notify(); }).child(label);
    return v_flex().id("pm-ws-new").track_focus(this.handle).size_full().min_h(0).bg(C.surface).text_size(SIZE.body).text_color(C.text2)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.menu) { this.menu = null; cx.notify(); } else this.close(); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) { this.go(cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(46).flex_none().px(18).items_center().border_b(1).border_color(C.line1)
        .child(div().flex_1().text_size(SIZE.title).font_semibold().text_color(C.text).child("New workspace"))
        .child(div().font_family(MONO).text_size(SIZE.caps).text_color(C.dim).child("esc")))
      .child(v_flex().flex_1().min_h(0).p(18).gap(16).overflow_y_scrollbar()
        .child(h_flex().gap(12).items_end()
          .child(this.field("Project", this.select("project", repoName || "No repository", this.repos.map((r) => ({ label: r.name, r })), (o, cx) => {
            this.repo = o.r; cx.spawn(async (cx) => { await this.loadCfg(); cx.notify(); });
          }), true))
          .child(this.field("Name", this.inputBox(this.nameIn, "name"), true)))
        .child(this.field("Start from", v_flex().gap(8)
          .child(h_flex().gap(2).p(2).w_auto().self_start().rounded(8).border_1().border_color(C.line2)
            .child(seg("main", this.cfg?.base ?? "main")).child(seg("branch", "Branch")).child(seg("pr", "PR")).child(seg("linear", "Linear issue")))
          .when(this.source === "branch", (e) => e.child(this.inputBox(this.refIn, "ref")))
          .when(this.source === "pr", (e) => e.child(this.inputBox(this.prIn, "ref")))
          .when(this.source === "linear", (e) => e.child(this.linearPanel(cx)))))
        .child(this.field("First task for Claude", v_flex().rounded(8).border_1().border_color(this.focusOn === "task" ? C.ember : C.line3).bg(C.surface)
          .child(div().h(84).px(10).py(8).child(Textarea.new(this.task).size_full().text_size(SIZE.body).text_color(C.text)))
          .child(h_flex().h(40).px(8).items_center().border_t(1).border_color(C.line2)
            .child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(C.line2).child(toggle("plan", "Plan")).child(toggle("auto", "Auto")))
            .child(div().flex_1())
            .child(div().w(150).child(this.select("model", MODELS.find((m) => m.id === this.model)?.label ?? this.model, MODELS.map((m) => ({ label: m.label, id: m.id })), (o) => { this.model = o.id; })))))
        )
        .child(v_flex().gap(8)
          .child(h_flex().gap(8).items_baseline().child(div().text_size(SIZE.meta).text_color(C.muted).child("On creation"))
            .child(div().font_family(MONO).text_size(SIZE.caps).text_color(C.dim).child(".herdr/project.json")))
          .child(h_flex().gap(14).flex_wrap().children(steps.map((s) => {
            const on = !this.skip.has(s.id);
            return h_flex().id(`step-${s.id}`).gap(6).items_center().cursor_pointer()
              .on_click((_e, cx) => { if (this.skip.has(s.id)) this.skip.delete(s.id); else this.skip.add(s.id); cx.notify(); })
              .child(icon(on ? "check" : "square", 12, on ? C.ember : C.dim))
              .child(div().font_family(MONO).text_size(SIZE.meta).text_color(on ? C.text2 : C.dim).child(s.label));
          })))
          .when(!steps.length, (e) => e.child(div().text_size(SIZE.meta).text_color(C.dim).child(this.cfg ? "Nothing to set up for this project." : "Pick a project.")))))
      .when(Boolean(this.error), (e) => e.child(div().px(18).pb(8).text_size(SIZE.meta).text_color(C.red).child(this.error)))
      .child(h_flex().h(60).flex_none().px(18).gap(10).items_center().border_t(1).border_color(C.line1)
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).child(path))
        .child(h_flex().id("cancel").h(32).px(14).items_center().rounded(8).cursor_pointer().text_color(C.text2).hover((s) => s.bg(C.raised)).on_click(() => this.close()).child("Cancel"))
        .child(h_flex().id("create").h(32).px(14).gap(8).items_center().rounded(8).bg(canCreate ? C.ember : C.raised).text_color(canCreate ? "#1B140D" : C.dim).font_medium()
          .when(canCreate, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.go(cx)))
          .child(this.busy ? "Creating…" : "Create").child(div().font_family(MONO).text_size(SIZE.caps).child("⌘↵"))));
  }
}
