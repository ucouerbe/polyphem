// @ts-check
// Routine settings (screen 07) and icon picker popover (07b).
// Open: run("tab.new", { name: "<routine>", mod: "pm-routine", props: { repo: "<abs repo path>", routine: "<slug>" } })
//       without `routine` the page is empty (new routine). Command "pm-routine.new" opens an empty page.
// Source of truth: <repo>/.routines/<slug>/routine.md. The form and the live file on the right are two views of it.
// Save via PR: pm-shared/routines-sync.sh save (branch, PR, squash merge, jobs re-synced in herdr-automations).
// Publishes shared("pm.routines") every 30 s while a copy is open (see routines-sync.sh state).
// Popover mode (props.picker): the icon and color picker; it answers through shared("pm.routine.pick").

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Editor, EditorState, Popover } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, appHome, run, props, shared, setShared, nextCommand, notify, openOverlay, closeOverlay,
  focused,
} from "herdr";
import { svg } from "gpui-kit";
import { C, SIZE, MONO, icon } from "./ui.js";
import {
  COLORS, colorHex, MODELS, modelLabel, EFFORTS, effortLabel, emptyRoutine, slugOf, parseRoutine, serializeRoutine, nextRuns, fmtDay, fmtTime,
  PRESETS, presetOf, cronFor, collisions, shiftCron, parseCron,
} from "./routine.js";

const SCRIPT = () => `${appHome()}/pm-shared/routines-sync.sh`;
const lucide = (name, size, color) => svg(`mods/pm-routine/lucide/${name}.svg`).size(size).flex_none().text_color(color);
const SUGGESTED = ["sun", "moon", "calendar", "clock", "git-pull-request", "search", "align-left", "message-square", "trending-up", "star",
  "zap", "flag", "bell", "sticky-note", "mail", "users", "target", "globe", "code", "heart", "lock", "map-pin", "leaf", "flame",
  "cloud", "coffee", "rocket", "bug"];
const CATCH = [[-1, "never"], [60, "less than 1h late"], [120, "less than 2h late"], [240, "less than 4h late"]];
const tmpDir = () => `${appHome()}/data/tmp`;

/** Overwrites (or creates) a text file. */
async function putFile(path, text) {
  const cur = await readTextFile(path).catch(() => null);
  await writeTextFile(path, text, cur);
}
const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const lastJsonLine = (t) => parseJson((t ?? "").trim().split("\n").filter(Boolean).pop() ?? "");

async function mainOf(dir) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir }).catch(() => null);
  const out = r?.stdout.trim() ?? "";
  return r?.code === 0 && out.endsWith("/.git") ? out.slice(0, -5) : null;
}

// ---- shared state publisher (one per window is enough; cheap to repeat) -------------------------
let publishing = false;
async function publishState(extra = []) {
  try {
    const r = await exec(SCRIPT(), ["state", ...extra], { timeout: 60000 });
    const list = parseJson(r.stdout);
    if (Array.isArray(list)) {
      setShared("pm.routines", list.map((x) => ({
        project: x.project, name: x.name, icon: x.icon, color: x.color, schedule: x.schedule, next: x.next, status: x.status,
        lastRun: x.lastRun, reportPath: x.reportPath, toReview: x.toReview, repo: x.repo, title: x.title, runs: x.runs ?? [],
      })));
      return list;
    }
  } catch { /* script missing or engine down: keep the last state */ }
  return null;
}

export default class PmRoutine extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.p = p;
    this.uid = Math.random().toString(36).slice(2, 7);
    this.handle = cx.focus_handle();
    if (p.picker) { this.initPicker(cx); return; }
    this.mode = "page";
    this.menu = null; this.status = ""; this.statusKind = "dim"; this.busy = false; this.others = []; this.mcpAvail = [];
    this.repos = []; this.repo = null; this.slug = p.routine ?? null; this.loaded = false; this.syncing = false;
    this.r = emptyRoutine(); this.savedText = null; this.focusOn = null; this.pickSeen = null;
    this.mkWidgets(cx);
    cx.spawn(async (cx) => {
      const f = focused();
      const given = p.repo ?? (f?.cwd ? await mainOf(f.cwd) : null);
      this.repo = given;
      const known = (await readTextFile(`${appHome()}/data/pm-routine-repos.txt`).catch(() => "")) ?? "";
      this.repos = [...new Set([...(given ? [given] : []), ...known.split("\n").filter(Boolean)])];
      if (!this.repo) this.repo = this.repos[0] ?? null;
      if (this.repo && this.slug) {
        const text = await readTextFile(`${this.repo}/.routines/${this.slug}/routine.md`).catch(() => null);
        if (text !== null) { this.r = parseRoutine(text); this.savedText = serializeRoutine(this.r); }
      }
      this.loaded = true;
      this.pushForm();
      await this.loadRepoInfo();
      cx.notify();
      if (p.dev) await this.dev(p.dev, cx);
    });
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c, cx); cx.notify(); } });
    cx.spawn(async (cx) => {
      for (;;) {
        if (!publishing) { publishing = true; await publishState(this.repo ? [this.repo] : []); publishing = false; }
        await exec("sleep", ["25"]).catch(() => null);
      }
    });
  }

  // ---- widgets: the form owns Input/Textarea states, the file owns an Editor ------------------------
  mkWidgets(cx) {
    this.nameIn = InputState.new({ placeholder: "Routine name" });
    this.timeIn = InputState.new({ placeholder: "09:00" });
    this.cronIn = InputState.new({ placeholder: "0 9 * * 1" });
    this.bodyIn = TextareaState.new({ placeholder: "What should Claude do on each run?", rows: 6 });
    this.fileEd = EditorState.new({ language: "markdown", value: serializeRoutine(this.r), line_numbers: false, soft_wrap: true, folding: false, font_family: MONO, font_size: 12 });
    const on = (st, name) => { st.on("focus", (_e, cx) => { this.focusOn = name; cx.notify(); }); };
    on(this.nameIn, "name"); on(this.timeIn, "time"); on(this.cronIn, "cron"); on(this.bodyIn, "body");
    this.nameIn.on("change", (_e, cx) => { if (this.syncing) return; this.r.name = this.nameIn.value(); this.fromForm(cx); });
    this.bodyIn.on("change", (_e, cx) => { if (this.syncing) return; this.r.body = this.bodyIn.value(); this.fromForm(cx); });
    this.timeIn.on("change", (_e, cx) => {
      if (this.syncing) return;
      const c = cronFor(this.preset(), this.timeIn.value());
      if (c) { this.r.schedule = c; this.fromForm(cx); }
    });
    this.cronIn.on("change", (_e, cx) => {
      if (this.syncing) return;
      this.r.schedule = this.cronIn.value().trim(); this.cronMode = true; this.fromForm(cx);
    });
    this.fileEd.on("change", (_e, cx) => {
      if (this.syncing) return;
      this.r = { ...parseRoutine(this.fileEd.value()) };
      this.pushForm(true); cx.notify();
    });
  }

  /** Form changed: rewrite the file view. */
  fromForm(cx) {
    this.syncing = true;
    const text = serializeRoutine(this.r);
    if (this.fileEd.value() !== text) this.fileEd.set_value(text);
    this.syncing = false;
    this.collide();
    cx.notify();
  }

  /** File changed (or loaded): rewrite the form widgets that differ. */
  pushForm(skipFile = false) {
    this.syncing = true;
    const r = this.r, pr = presetOf(r.schedule);
    const set = (st, v) => { if (st.value() !== v) st.set_value(v); };
    set(this.nameIn, r.name); set(this.bodyIn, r.body);
    if (pr.time) set(this.timeIn, pr.time);
    set(this.cronIn, r.schedule);
    if (pr.preset !== "cron") this.cronMode = false;
    if (!skipFile) { const t = serializeRoutine(r); if (this.fileEd.value() !== t) this.fileEd.set_value(t); }
    this.syncing = false;
    this.collide();
  }

  preset() { return this.cronMode ? "cron" : presetOf(this.r.schedule).preset; }

  async loadRepoInfo() {
    this.others = []; this.mcpAvail = [];
    if (!this.repo) return;
    const mcp = parseJson((await readTextFile(`${this.repo}/.mcp.json`).catch(() => null)) ?? "null");
    this.mcpAvail = Object.keys(mcp?.mcpServers ?? {});
    const list = await publishState([this.repo]);
    this.others = (list ?? []).filter((x) => !(x.repo === this.repo && x.name === this.slug));
    this.collide();
  }

  collide() { this.hits = parseCron(this.r.schedule) ? collisions(this.r.schedule, this.others) : []; }

  command(c, cx) {
    if (this.p.picker) return;
    if (c === "new") run("tab.new", { name: "New routine", mod: "pm-routine", props: { repo: this.repo } });
    else if (c === "save") this.save(cx);
    else if (c === "test") this.testRun(cx);
  }

  /** Two-step delete: the button turns into a confirmation in place. */
  deleteSection() {
    const btn = (id, label, danger, onClick) => h_flex().id(`${id}-${this.uid}`).h(28).px(12).items_center().rounded(7).cursor_pointer().text_size(SIZE.body)
      .when(danger, (e) => e.bg(C.red).text_color("#17140F").font_medium()).when(!danger, (e) => e.border_1().border_color(C.line3).text_color(C.text2))
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    if (!this.confirmDelete) {
      return v_flex().gap(8).items_start()
        .child(div().text_size(SIZE.meta).text_color(C.dim).child("Removes the routine and its reports from the project, through a PR merged right away. Reports stay in git history."))
        .child(h_flex().id(`del-${this.uid}`).h(28).px(12).items_center().rounded(7).cursor_pointer().text_size(SIZE.body).text_color(C.red)
          .border_1().border_color(C.line3).hover((s) => s.bg(C.raised))
          .on_click((_e, cx) => { this.confirmDelete = true; cx.notify(); }).child("Delete routine…"));
    }
    return v_flex().gap(8).items_start()
      .child(div().text_size(SIZE.body).text_color(C.text).child(`Delete “${this.r.name || this.slug}” and its reports?`))
      .child(h_flex().gap(8)
        .child(btn("del-yes", this.busy ? "Deleting…" : "Delete", true, (_e, cx) => this.remove(cx)))
        .child(btn("del-no", "Cancel", false, (_e, cx) => { this.confirmDelete = false; cx.notify(); })));
  }

  remove(cx) {
    if (this.busy || !this.slug || !this.repo) return;
    const tab = focused()?.tab, slug = this.slug, name = this.r.name || slug;
    cx.spawn(async (cx) => {
      this.busy = true; this.say("Deleting: branch, PR, merge…", "yellow"); cx.notify();
      try {
        const r = await exec(SCRIPT(), ["delete", this.repo, slug], { timeout: 300000 });
        const out = lastJsonLine(r.stdout);
        if (r.code !== 0 || !out) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "delete failed");
        notify({ title: out.pr ? `Routine deleted · PR #${out.pr} merged` : "Routine removed from the schedule", body: name, level: "success", timeout: 4000 });
        if (tab) run("tab.close", { id: tab });
      } catch (e) { this.say(String(e.message ?? e), "red"); this.confirmDelete = false; }
      this.busy = false; cx.notify();
    });
  }

  say(text, kind = "dim") { this.status = text; this.statusKind = kind; }

  // ---- actions --------------------------------------------------------------------------------------
  async stage(cx) {
    await exec("mkdir", ["-p", tmpDir()]);
    const file = `${tmpDir()}/routine-${this.uid}.md`;
    await putFile(file, serializeRoutine(this.r));
    return file;
  }

  save(cx) {
    if (this.busy) return;
    const slug = this.slug ?? slugOf(this.r.name);
    if (!this.repo) { this.say("Pick a project first", "red"); cx.notify(); return; }
    if (!slug) { this.say("Give the routine a name", "red"); cx.notify(); return; }
    if (!parseCron(this.r.schedule)) { this.say("The cron expression is not valid", "red"); cx.notify(); return; }
    cx.spawn(async (cx) => {
      this.busy = true; this.say("Saving: branch, PR, merge…", "yellow"); cx.notify();
      try {
        const file = await this.stage(cx);
        const r = await exec(SCRIPT(), ["save", this.repo, slug, file], { timeout: 300000 });
        const out = lastJsonLine(r.stdout);
        if (r.code !== 0 || !out) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "save failed");
        this.slug = slug; this.savedText = serializeRoutine(this.r);
        this.say(out.pr ? `Merged PR #${out.pr} · rescheduled` : "Nothing to save", "green");
        notify({ title: out.pr ? `Routine saved · PR #${out.pr} merged` : "Routine already up to date", body: this.r.name, level: "success", timeout: 4000 });
        await this.loadRepoInfo();
      } catch (e) { this.say(String(e.message ?? e), "red"); }
      this.busy = false; cx.notify();
    });
  }

  testRun(cx) {
    const slug = this.slug ?? slugOf(this.r.name);
    if (!this.repo || !slug) { this.say("Name the routine first", "red"); cx.notify(); return; }
    cx.spawn(async (cx) => {
      this.say("Starting test run…", "yellow"); cx.notify();
      try {
        const file = await this.stage(cx);
        const r = await exec(SCRIPT(), ["run", this.repo, slug, "--test", file], { timeout: 60000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "run failed");
        this.say("Test run started: it opens as a new workspace", "green");
      } catch (e) { this.say(String(e.message ?? e), "red"); }
      cx.notify();
    });
  }

  rewrite(cx) {
    const text = this.bodyIn.value().trim();
    if (!text || this.busy) return;
    cx.spawn(async (cx) => {
      this.busy = true; this.say("Rewriting with Claude…", "yellow"); cx.notify();
      try {
        const prompt = "Rewrite these routine instructions for an unattended coding agent: clear, imperative, concrete, no preamble. " +
          `Keep the intent and any file names. Reply with the rewritten instructions only.\n\n${text}`;
        const r = await exec("claude", ["-p", "--model", this.r.model, prompt], { timeout: 120000 });
        if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || "claude returned nothing");
        this.bodyIn.set_value(r.stdout.trim());
        this.say("Rewritten. Review it, then save.", "green");
      } catch (e) { this.say(String(e.message ?? e), "red"); }
      this.busy = false; cx.notify();
    });
  }

  /** DEV: dev = { name, body, schedule, model, save, test, picker } from props to drive the page headlessly. */
  async dev(d, cx) {
    if (d.name) { this.nameIn.set_value(d.name); this.r.name = d.name; }
    if (d.body) { this.bodyIn.set_value(d.body); this.r.body = d.body; }
    if (d.schedule) { this.r.schedule = d.schedule; }
    if (d.model) this.r.model = d.model;
    if (d.icon) this.r.icon = d.icon;
    if (d.color) this.r.color = d.color;
    if (d.catch_up !== undefined) this.r.catch_up = d.catch_up;
    this.pushForm();
    cx.notify();
    if (d.picker) this.openPicker();
    if (d.save) this.save(cx);
    if (d.test) this.testRun(cx);
  }

  openPicker() {
    const side = shared("sidebar.collapsed") ? 76 : Number(shared("sidebar.width") ?? 280);
    openOverlay({
      mod: "pm-routine", kind: "popup", width: 460, height: 340, at: { x: side + 34, y: 190 },
      props: { picker: true, uid: this.uid, icon: this.r.icon, color: this.r.color },
    });
  }

  // ---- UI -------------------------------------------------------------------------------------------
  pill(id, label, on, onClick, mono = false) {
    return div().id(`${id}-${this.uid}`).h(26).px(10).flex().items_center().rounded(6).text_size(SIZE.body).cursor_pointer()
      .when(mono, (e) => e.font_family(MONO))
      .when(on, (e) => e.bg(C.raised).text_color(C.text)).when(!on, (e) => e.text_color(C.muted).hover((s) => s.text_color(C.text2)))
      .on_click(onClick).child(label);
  }

  row(label, sub, content) {
    return h_flex().gap(0).items_start().py(22).border_b(1).border_color(C.line1)
      .child(v_flex().w(134).flex_none().gap(3).pt(3).child(div().text_size(SIZE.body).text_color(C.muted).child(label))
        .when(Boolean(sub), (e) => e.child(div().text_size(SIZE.meta).text_color(C.dim).child(sub))))
      .child(div().flex_1().min_w(0).child(content));
  }

  kv(label, value) {
    return h_flex().h(34).items_center().min_w(0).child(div().w(100).flex_none().text_size(SIZE.body).text_color(C.dim).child(label)).child(div().flex_1().min_w(0).child(value));
  }

  dropdown(id, current, options, onPick) {
    const open = this.menu === id;
    // A Popover draws above the page: an absolute menu would be clipped by the row and covered by the next rows.
    return Popover.new(`dd-${id}-${this.uid}`).open(open)
      .on_open_change((o, cx) => { this.menu = o ? id : null; cx.notify(); })
      .trigger(h_flex().id(`ddt-${id}-${this.uid}`).h(26).min_w(0).gap(5).items_center().cursor_pointer().text_size(SIZE.body).text_color(C.text)
        .child(div().min_w(0).truncate().child(current)).child(icon("chevron-down", 10, C.dim)))
      .content(v_flex().w(200).p(4).rounded(8).bg(C.raised).border_1().border_color(C.line3)
        .children(options.map((o, i) => h_flex().id(`ddo-${id}-${i}-${this.uid}`).h(28).px(8).items_center().rounded(5).cursor_pointer().text_color(C.text)
          .hover((s) => s.bg("#352D24")).on_click((_e, cx) => { this.menu = null; onPick(o); this.fromForm(cx); }).child(o.label))));
  }

  stepBtn(id, label, onClick) {
    return div().id(`${id}-${this.uid}`).size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(C.muted)
      .hover((s) => s.bg(C.raised)).on_click((_e, cx) => { onClick(); this.fromForm(cx); }).child(label);
  }

  identity() {
    const col = colorHex(this.r.color);
    return h_flex().gap(14).items_center().pb(24)
      .child(div().id(`icon-${this.uid}`).size(44).flex_none().flex().items_center().justify_center().rounded(10).border_1().border_color(col)
        .cursor_pointer().hover((s) => s.bg(C.raised)).tooltip("Change icon and color").on_click(() => this.openPicker())
        .child(lucide(this.r.icon, 22, col)))
      .child(div().flex_1().min_w(0).child(Input.new(this.nameIn).w_full().text_size(SIZE.page).font_semibold().text_color(C.text)));
  }

  whenSection() {
    const pr = this.preset(), r = this.r, valid = parseCron(r.schedule);
    const runs = valid ? nextRuns(r.schedule, 3) : [];
    const hit = this.hits?.[0];
    const shifted = hit ? shiftCron(r.schedule, 30) : null;
    return v_flex().gap(8).min_w(0)
      .child(h_flex().flex_wrap().gap(2).items_center()
        .children(PRESETS.map((p) => this.pill(`pre-${p.id}`, p.label, pr === p.id, (_e, cx) => {
          if (p.id === "cron") { this.cronMode = true; cx.notify(); return; }
          this.cronMode = false;
          const t = presetOf(r.schedule).time ?? (this.timeIn.value() || "09:00");
          const c = cronFor(p.id, t);
          if (c) { r.schedule = c; this.pushForm(); this.fromForm(cx); }
        })))
        .child(div().w(14))
        .child(div().w(70).h(26).flex().items_center().px(8).rounded(6).border_1().border_color(this.focusOn === "time" ? C.ember : C.line2)
          .child(Input.new(this.timeIn).w_full().text_size(SIZE.body).font_family(MONO).text_color(C.text))))
      .when(pr === "cron", (e) => e.child(div().h(28).w(220).flex().items_center().px(8).rounded(6).border_1().border_color(this.focusOn === "cron" ? C.ember : C.line2)
        .child(Input.new(this.cronIn).w_full().text_size(SIZE.meta).font_family(MONO).text_color(C.text))))
      .child(div().font_family(MONO).text_size(11).text_color(valid ? C.dim : C.red)
        .child(valid ? `${r.schedule} · next: ${runs.map((d) => `${fmtDay(d)}`).join(", ")}` : "Not a valid cron expression (5 fields)"))
      .when(Boolean(hit), (e) => e.child(h_flex().gap(6).items_center().text_size(SIZE.meta).text_color(C.yellow)
        .child(`${hit.other} also runs ${fmtDay(hit.when).split(" ")[0]} ${fmtTime(hit.when)}.`)
        .when(Boolean(shifted), (x) => x.child(div().id(`shift-${this.uid}`).cursor_pointer().text_color(C.link).hover((s) => s.text_color(C.text))
          .on_click((_e, cx) => { r.schedule = shifted; this.pushForm(); this.fromForm(cx); })
          .child(`Shift to ${fmtTime(new Date(2000, 0, 1, +presetOf(shifted).time.slice(0, 2), +presetOf(shifted).time.slice(3)))}`)))));
  }

  instructions() {
    return v_flex().rounded(8).border_1().border_color(this.focusOn === "body" ? C.ember : C.line3).bg(C.surface)
      .child(div().h(150).px(14).py(12).child(Textarea.new(this.bodyIn).size_full().text_size(SIZE.body).text_color(C.text)))
      .child(h_flex().h(34).px(14).items_center().border_t(1).border_color(C.line2).text_size(SIZE.meta).text_color(C.dim)
        .child(div().flex_1().child("Markdown · @file to add context · saved in routine.md"))
        .child(div().id(`rewrite-${this.uid}`).cursor_pointer().text_color(C.muted).hover((s) => s.text_color(C.text))
          .on_click((_e, cx) => this.rewrite(cx)).child("Rewrite with Claude")));
  }

  agent() {
    const r = this.r, catchLabel = (CATCH.find((c) => c[0] === r.catch_up) ?? [0, `${r.catch_up} min late`])[1];
    const mcpAll = [...new Set([...this.mcpAvail, ...r.mcp])];
    return v_flex()
      .child(this.kv("Model", this.dropdown("model", modelLabel(r.model), MODELS.map((m) => ({ label: m.label, id: m.id })), (o) => { r.model = o.id; })))
      .child(this.kv("Effort", this.dropdown("effort", effortLabel(r.effort), EFFORTS.map((e) => ({ label: effortLabel(e), v: e })), (o) => { r.effort = o.v; })))
      .child(this.kv("MCP tools", h_flex().gap(8).items_center().text_size(SIZE.body)
        .children(mcpAll.map((n) => div().id(`mcp-${n}-${this.uid}`).cursor_pointer().text_color(r.mcp.includes(n) ? C.text : C.dim)
          .on_click((_e, cx) => { r.mcp = r.mcp.includes(n) ? r.mcp.filter((x) => x !== n) : [...r.mcp, n]; this.fromForm(cx); }).child(n)))
        .when(!mcpAll.length, (e) => e.child(div().text_color(C.dim).child("none (add servers in .mcp.json)")))))
      .child(this.kv("Context", h_flex().gap(4).items_center()
        .child(this.stepBtn("ctx-dec", "−", () => { r.context_reports = Math.max(0, r.context_reports - 1); }))
        .child(div().text_size(SIZE.body).text_color(C.text).child(r.context_reports === 0 ? "No previous reports" : `Last ${r.context_reports} report${r.context_reports > 1 ? "s" : ""}`))
        .child(this.stepBtn("ctx-inc", "+", () => { r.context_reports = Math.min(10, r.context_reports + 1); }))))
      .child(this.kv("Where", div().truncate().text_size(SIZE.body).text_color(C.text).child(`fresh worktree of ${(this.repo ?? "").split("/").pop() || "the project"}`)))
      .child(this.kv("Mac asleep", this.dropdown("catch", catchLabel === "never" ? "do not catch up" : `catch up if ${catchLabel}`,
        CATCH.map((c) => ({ label: c[0] === -1 ? "do not catch up" : `catch up if ${c[1]}`, v: c[0] })), (o) => { r.catch_up = o.v; })));
  }

  header() {
    const dirty = this.savedText !== serializeRoutine(this.r);
    const proj = (this.repo ?? "").split("/").pop() || "No project";
    const sc = { dim: C.dim, red: C.red, green: C.greenText, yellow: C.yellow }[this.statusKind] ?? C.dim;
    const canSave = !this.busy && (dirty || this.savedText === null);
    return h_flex().h(46).flex_none().px(20).gap(8).items_center().border_b(1).border_color(C.line1).text_size(SIZE.body)
      .child(this.slug || this.repos.length < 2
        ? div().text_color(C.muted).child(proj)
        : this.dropdown("project", proj, this.repos.map((x) => ({ label: x.split("/").pop(), repo: x })), (o) => { this.repo = o.repo; this.loadRepoInfo(); }))
      .child(div().text_color(C.dim).child("/")).child(div().text_color(C.muted).child("Routines")).child(div().text_color(C.dim).child("/"))
      .child(div().text_color(C.text).child(this.r.name || "New routine"))
      .child(div().flex_1())
      .child(div().text_size(SIZE.meta).text_color(sc).truncate().max_w(360).child(this.status || (dirty ? "unsaved changes" : "")))
      .child(h_flex().id(`test-${this.uid}`).h(30).px(12).items_center().rounded(7).cursor_pointer().text_color(C.muted).hover((s) => s.text_color(C.text))
        .on_click((_e, cx) => this.testRun(cx)).child("Test run"))
      .child(h_flex().id(`save-${this.uid}`).h(30).px(12).gap(6).items_center().rounded(7).font_medium()
        .bg(canSave ? C.ember : C.raised).text_color(canSave ? "#17140F" : C.dim)
        .when(canSave, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.save(cx)))
        .child("Save").child(div().text_size(SIZE.meta).font_normal().opacity(0.7).child(this.busy ? "saving…" : "via PR")));
  }

  renderPage(cx) {
    const pk = shared("pm.routine.pick");
    if (pk && pk.uid === this.uid && pk !== this.pickSeen) {
      this.pickSeen = pk;
      cx.spawn(async (cx) => { this.r.icon = pk.icon; this.r.color = pk.color; this.fromForm(cx); });
    }
    const file = this.slug ? `.routines/${this.slug}/routine.md` : `.routines/${slugOf(this.r.name) || "<name>"}/routine.md`;
    return v_flex().id(`pmr-${this.uid}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(C.surface).border_1().border_color(C.line1)
      .text_color(C.text2).text_size(SIZE.body).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.modifiers.platform && !e.modifiers.shift && e.key === "s") { cx.stop_propagation(); this.save(cx); } })
      .on_click((_e, cx) => { if (this.menu) { this.menu = null; cx.notify(); } })
      .child(this.header())
      .child(h_flex().flex_1().min_h(0)
        .child(div().id(`form-${this.uid}`).flex_1().min_w(0).h_full().overflow_y_scroll().child(
          v_flex().w_full().max_w(760).px(40).pt(32).pb(40).mx_auto()
            .child(this.identity())
            .child(this.row("When", null, this.whenSection()))
            .child(this.row("Instructions", "What Claude receives at launch", this.instructions()))
            .child(this.row("Agent", null, this.agent()))
            .when(Boolean(this.slug && this.savedText !== null), (e) => e.child(this.row("Delete", null, this.deleteSection())))))
        .child(v_flex().w(380).flex_none().h_full().min_h(0).border_l(1).border_color(C.line1).bg(C.bg)
          .child(h_flex().h(40).flex_none().px(16).items_center().border_b(1).border_color(C.line1)
            .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(C.dim).child(file))
            .child(div().text_size(11).text_color(C.dim).child("everything is here")))
          .child(div().id(`file-${this.uid}`).flex_1().min_h(0).px(14).py(12).child(Editor.new(this.fileEd).size_full().text_color(C.text2)))
          .child(div().flex_none().px(16).py(12).border_t(1).border_color(C.line1).text_size(SIZE.meta).line_height("17px").text_color(C.dim)
            .child("herdr-automations reads this file. Editing it here or in the form is equivalent."))));
  }

  // ---- icon picker popover (07b) ----------------------------------------------------------------------
  initPicker(cx) {
    const p = this.p;
    this.mode = "picker"; this.icon = p.icon ?? "clock"; this.color = p.color ?? "ember"; this.index = []; this.q = "";
    this.search = InputState.new({ placeholder: "Search 2,359 icons (Lucide)" });
    this.search.on("change", (_e, cx) => { this.q = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.focus();
    cx.spawn(async (cx) => {
      const t = await readTextFile(`${appHome()}/mods/pm-routine/lucide-index.json`).catch(() => null);
      this.index = parseJson(t ?? "[]") ?? [];
      cx.notify();
    });
  }

  pick(icon_, color, cx, close) {
    this.icon = icon_; this.color = color;
    setShared("pm.routine.pick", { uid: this.p.uid, icon: icon_, color, t: Date.now() });
    if (close) closeOverlay(this.p.overlay);
    cx.notify();
  }

  renderPicker(cx) {
    const q = this.q;
    const list = q
      ? this.index.filter(([n, tags]) => n.includes(q) || tags.includes(q)).slice(0, 70).map((x) => x[0])
      : SUGGESTED;
    const col = colorHex(this.color);
    return v_flex().id("pmr-picker").size_full().min_h(0).p(10).gap(8).bg(C.surface).border_1().border_color(C.line3).rounded(10).text_color(C.text2)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(34).px(10).gap(8).items_center().rounded(7).border_1().border_color(C.line3).bg(C.bg)
        .child(icon("search", 13, C.dim)).child(div().flex_1().child(Input.new(this.search).w_full().text_size(SIZE.body).text_color(C.text))))
      .child(div().px(2).pt(2).text_size(11).font_semibold().text_color(C.dim).child(q ? `RESULTS · ${list.length}` : "SUGGESTED"))
      .child(div().id("pmr-grid").flex_1().min_h(0).overflow_y_scroll().child(
        h_flex().flex_wrap().gap(2).children(list.map((n) => div().id(`pi-${n}`).size(36).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(n === this.icon, (e) => e.bg(C.raised)).hover((s) => s.bg(C.raised)).tooltip(n)
          .on_click((_e, cx) => this.pick(n, this.color, cx, true))
          .child(lucide(n, 18, n === this.icon ? col : C.text2))))))
      .child(h_flex().h(34).flex_none().px(2).gap(8).items_center().border_t(1).border_color(C.line2)
        .child(div().flex_1().text_size(SIZE.meta).text_color(C.muted).child("Color"))
        .children(COLORS.map(([name, hex]) => div().id(`pc-${name}`).size(20).flex().items_center().justify_center().rounded_full().cursor_pointer()
          .when(name === this.color, (e) => e.border_2().border_color(C.text)).tooltip(name)
          .on_click((_e, cx) => this.pick(this.icon, name, cx, false)).child(div().size(14).rounded_full().bg(hex)))));
  }

  render(cx) {
    if (this.mode === "picker") return this.renderPicker(cx);
    if (!this.loaded) return div().p(20).text_size(SIZE.meta).text_color(C.dim).child("Loading…");
    return this.renderPage(cx);
  }
}
