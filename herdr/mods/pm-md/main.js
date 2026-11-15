// @ts-check
// Markdown tab (screens 05, 06, 17): Rendered | Source, Share menu.
// Open: run("tab.new", { name: "<file name>", mod: "pm-md", props: { path: "<relative to root>", root: "<abs folder>" } })
// Rendered view is editable block by block: click a block to edit its Markdown in place; Esc or a click elsewhere saves it.
// Commands (keys.json "pm-md.<cmd>"): copy-rich, reload, source, rendered, save, share; on a routine report also approve, keep-only, send.  Shared: shared("pm.md.dirty") = [tab names with unsaved edits].
// Overlay mode (props.menu): the Share popover.
// Routine report (screens 05, 06): props.report = { worktree, repo, routine } adds the run header and, below the report,
// the feedback zone: numbered questions, reply field, "Send to Claude", "Approve" (merge the PR), "Keep report only".
// Example: run("tab.new", { name: "Report · Nov 14", mod: "pm-md", props: { path: ".routines/morning-brief/reports/2026-11-14.md",
//   root: "<worktree>", report: { worktree: "<worktree>", repo: "<main checkout>", routine: "morning-brief" } } })

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, watchFolder, run, openOverlay, closeOverlay, notify, props,
  shared, setShared, nextCommand, spaces, settings, appHome,
} from "herdr";
import { C, SIZE, MONO, icon, Kbd } from "./ui.js";
import { toHtml, mdBlocks } from "./md.js";
import { parseReport, splitReport, runLine, answersMessage } from "./report.js";

const ROUTINES = () => `${appHome()}/pm-shared/routines-sync.sh`;
const MODEL_LABEL = { "claude-haiku-5-5": "Haiku 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5" };

// UTF-8 bytes as hex (no TextEncoder in the mod runtime).
const hex = (s) => unescape(encodeURIComponent(s)).split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const baseName = (p) => p.split("/").pop();

/** HTML + the raw Markdown as plain text on the clipboard (macOS), through osascript «class HTML». The app pasted into picks. */
async function copyRich(text) {
  const html = `<meta charset="utf-8">${toHtml(text)}`;
  const script = `set the clipboard to {«class HTML»:«data HTML${hex(html)}», «class utf8»:«data utf8${hex(text)}»}`;
  const r = await exec("osascript", ["-e", script]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "osascript failed");
  notify({ title: "Copied", body: "formatted in Slack, Notion or a mail; Markdown in GitHub or an editor", level: "success", timeout: 3500 });
}

const markDirty = (name, on) => {
  const list = /** @type {string[]} */ (shared("pm.md.dirty") ?? []);
  if (list.includes(name) === on) return;
  setShared("pm.md.dirty", on ? [...list, name] : list.filter((n) => n !== name));
};

export default class PmMd extends View {
  init(_p, cx) {
    const p = { path: "README.md", root: "/", ...(props() ?? {}) };
    this.p = p;
    this.handle = cx.focus_handle();
    this.uid = Math.random().toString(36).slice(2, 7);
    if (p.menu) { this.mode = "menu"; this.remote = undefined; this.initMenu(cx); return; }
    this.mode = "tab";
    this.view = "rendered";
    this.text = null; this.saved = null; this.dirty = false; this.error = null; this.editor = null;
    this.area = null; this.editAt = null; this.linkAt = 0; this.blocksOf = null; this.blocksCache = [];
    this.file = `${p.root}/${p.path}`;
    this.name = baseName(p.path);
    this.report = p.report ?? null;
    if (this.report) this.initReport(cx);
    this.load(cx);
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c, cx); cx.notify(); } });
    cx.spawn(async (cx) => {
      const dir = this.file.slice(0, this.file.lastIndexOf("/"));
      for (;;) {
        try { await watchFolder(dir); } catch { return; }
        if (!this.dirty && !this.area) this.load(cx);
      }
    });
  }

  command(c, cx) {
    if (this.mode !== "tab") return;
    if (c === "copy-rich") copyRich(this.current()).catch((e) => notify({ title: "Copy failed", body: String(e), level: "error" }));
    else if (c === "source" || c === "rendered") {
      this.commitBlock(cx);
      if (c === "source") this.ensureEditor(cx); else if (this.editor) this.text = this.editor.value();
      this.view = c;
    } else if (c === "save") this.save(cx);
    else if (c === "share") this.share({ x: 880, y: 68 });
    else if (this.report && c === "approve") this.finish("approve", cx);
    else if (this.report && c === "keep-only") this.finish("keep", cx);
    else if (this.report && c === "send") this.send(cx);
    else if (c === "reload") { this.dirty = false; markDirty(this.name, false); this.load(cx); }
  }

  current() { return this.editor ? this.editor.value() : this.text ?? ""; }

  load(cx) {
    if (this.report?.done) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.file, { on: this.p.on }).catch(() => null);
      if (text === null && this.report?.done) return;
      if (text === null) { this.error = "File not found or unreadable"; cx.notify(); return; }
      this.error = null;
      if (text === this.saved) return;
      this.saved = text; this.text = text;
      if (this.editor) this.editor.set_value(text);
      // DEV: props.dev = { edit: <block index>, value: "<new markdown>" } drives block editing headlessly.
      const dev = this.p.dev;
      if (dev && dev.edit !== undefined && !this.devDone) {
        this.devDone = true; this.editBlock(dev.edit, cx, false);
        if (dev.value !== undefined) { this.area?.set_value(dev.value); this.commitBlock(cx); }
      }
      cx.notify();
    });
  }

  ensureEditor(cx) {
    if (this.editor || this.text === null) return;
    this.editor = EditorState.new({
      language: "markdown", value: this.text, line_numbers: false, soft_wrap: true, folding: false,
      font_family: MONO, font_size: 13,
    });
    this.editor.on("change", (_e, cx) => {
      this.text = this.editor.value();
      const d = this.text !== this.saved;
      if (d !== this.dirty) { this.dirty = d; markDirty(this.name, d); cx.notify(); }
    });
  }

  save(cx) {
    if (this.area) { this.commitBlock(cx); return; }
    if (!this.editor) return;
    this.saveText(this.editor.value(), cx);
  }

  saveText(text, cx) {
    if (this.saved === null || text === this.saved) return;
    writeTextFile(this.file, text, this.saved).then(() => {
      this.saved = text; this.text = text; this.dirty = false; markDirty(this.name, false); cx.notify();
    }, (e) => {
      notify({ title: "File changed on disk", body: "Reload " + e, level: "warning", action: { name: "pm-md.reload" } });
    });
  }

  // ---- block editing (Rendered view) ---------------------------------------------

  blocks() {
    if (this.blocksOf !== this.text) { this.blocksOf = this.text; this.blocksCache = mdBlocks(this.text ?? ""); }
    return this.blocksCache;
  }

  /** Opens block i (or a new block at the end when i === blocks().length) as an in-place textarea. */
  editBlock(i, cx, focus = true) {
    if (this.area) this.commitBlock(cx);
    const bs = this.blocks(), b = bs[i];
    const text = this.text ?? "";
    this.editAt = b ? { start: b.start, end: b.end, src: b.src, i } : { start: text.length, end: text.length, src: "", i: bs.length, append: true };
    const area = TextareaState.new({ value: this.editAt.src, placeholder: "Write Markdown…" });
    area.set_auto_grow(1, 60);
    area.on("change", (_e, cx) => {
      const d = area.value() !== this.editAt?.src;
      if (d !== this.dirty) { this.dirty = d; markDirty(this.name, d); cx.notify(); }
    });
    area.on("blur", (_e, cx) => { if (this.area === area) { this.commitBlock(cx); cx.notify(); } });
    this.area = area;
    if (focus) area.focus();
    cx.notify();
  }

  /** Writes the edited block back into the file text, then saves. */
  commitBlock(cx) {
    const area = this.area, at = this.editAt;
    if (!area || !at) return;
    this.area = null; this.editAt = null;
    const value = area.value().replace(/\s+$/, "");
    area.release();
    if (value !== at.src) {
      const text = this.text ?? "";
      const next = at.append
        ? (value ? `${text.replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}${value}\n` : text)
        : text.slice(0, at.start) + value + text.slice(at.end);
      this.text = next;
      if (this.editor) this.editor.set_value(next);
      this.saveText(next, cx);
    } else if (this.dirty) { this.dirty = false; markDirty(this.name, false); }
    cx.notify();
  }

  blocksView() {
    const bs = this.blocks(), at = this.editAt;
    const shell = (id, el, onClick) => div().id(id).w_full().px(10).py(4).rounded(6).cursor_text()
      .hover((s) => s.bg("#221D17")).on_click(onClick).child(el);
    const row = (b, i) => {
      if (this.area && at && !at.append && at.i === i) {
        return div().id(`be-${this.uid}-${i}`).w_full().px(4)
          .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.commitBlock(cx); } })
          .child(Textarea.new(this.area).w_full().font_family(MONO).text_size(13).text_color(C.text).bg(C.bg).border_1().border_color(C.line3).rounded(6).px(10).py(6));
      }
      const open = (_e, cx) => { if (Date.now() - this.linkAt > 400) this.editBlock(i, cx); };
      const el = b.kind === "front"
        ? v_flex().items_start().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).children(b.src.split("\n").map((l) => h_flex().w_full().justify_start().child(l || " ")))
        : TextView.markdown(`mb-${this.uid}-${i}-${b.start}`, b.src).on_link_click((url, cx) => { this.linkAt = Date.now(); this.link(url, cx); });
      return shell(`b-${this.uid}-${i}`, el, open);
    };
    const tail = this.area && at?.append
      ? div().id(`be-${this.uid}-new`).w_full()
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.commitBlock(cx); } })
        .child(Textarea.new(this.area).w_full().font_family(MONO).text_size(13).text_color(C.text).bg(C.bg).border_1().border_color(C.line3).rounded(6).px(10).py(6))
      : div().id(`badd-${this.uid}`).w_full().min_h(48).px(10).py(6).rounded(6).cursor_text().text_size(SIZE.meta).text_color(C.dim)
        .hover((s) => s.text_color(C.muted)).on_click((_e, cx) => this.editBlock(bs.length, cx))
        .child(bs.length ? "" : "Empty file. Click to start writing.");
    return div().id(`blocks-${this.uid}`).flex_1().min_h(0).overflow_y_scroll().child(
      v_flex().w_full().max_w(700).mx_auto().px(14).py(20).gap(6).text_color(C.text2).text_size(14)
        .children(bs.map(row)).child(tail));
  }

  link(url, cx) {
    if (/^(https?:|mailto:)/i.test(url)) { exec("open", [url]); return; }
    const [rel] = url.split("#");
    if (!/\.md$/i.test(rel)) { exec("open", [url.startsWith("file:") ? url : `${this.file.slice(0, this.file.lastIndexOf("/"))}/${rel}`]); return; }
    const parts = `${this.p.path.split("/").slice(0, -1).join("/")}/${decodeURIComponent(rel)}`.split("/");
    const out = [];
    for (const s of parts) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }
    const path = out.join("/");
    run("tab.new", { name: baseName(path), mod: "pm-md", props: { path, root: this.p.root, on: this.p.on } });
  }


  // ---- routine report (screens 05, 06) ---------------------------------------------------------

  initReport(cx) {
    const r = this.report;
    this.key = `pm.report.answers:${this.file}`;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) ?? "null"); } catch { saved = null; }
    this.answers = saved?.answers ?? {}; this.skipped = saved?.skipped ?? []; this.cur = saved?.cur ?? 0;
    this.act = null; this.note = ""; this.noteKind = "dim"; this.model = ""; this.reply = InputState.new({ placeholder: "Answer Claude, or ask for a change…" });
    this.reply.on("submit", (_e, cx) => { this.answer(cx); });
    this.reply.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      const rt = await readTextFile(`${r.worktree}/.routines/${r.routine}/routine.md`).catch(() => null);
      const m = /^model:\s*(\S+)/m.exec(rt ?? "");
      this.model = m ? (MODEL_LABEL[m[1]] ?? m[1]) : "";
      // DEV: props.dev = { answer: "text for the current question", send: true } drives the zone headlessly.
      const dev = this.p.dev;
      if (dev?.answer) { this.reply.set_value(dev.answer); this.answer(cx); }
      if (dev?.send) this.send(cx);
      cx.notify();
    });
  }

  persist() {
    try { localStorage.setItem(this.key, JSON.stringify({ answers: this.answers, skipped: this.skipped, cur: this.cur })); } catch { /* storage unavailable */ }
  }

  parsed() { return parseReport(this.text ?? ""); }
  reportStatus() { return this.report?.done ?? this.parsed().front.status ?? ""; }
  reportStatusLabel() {
    const s = this.reportStatus();
    return s === "merged" ? "merged" : s === "report-only" ? "report only" : s === "to-review" ? "to review" : s;
  }
  questions() { return splitReport(this.parsed().body).questions; }
  answered() { return this.questions().filter((_q, i) => this.answers[i]).length; }

  /** Index of the question the field answers: this.cur, moved past answered or skipped ones. */
  curQ() {
    const n = this.questions().length;
    for (let k = 0; k < n; k++) { const i = (this.cur + k) % n; if (!this.answers[i] && !this.skipped.includes(i)) return i; }
    return -1;
  }

  answer(cx) {
    const v = this.reply.value().trim();
    const i = this.curQ();
    if (!v || this.act) return;
    if (i < 0) return; // free text without a pending question is sent with "Send to Claude"
    this.answers[i] = v; this.cur = i + 1; this.reply.set_value(""); this.persist(); cx.notify();
  }

  skip(cx) {
    const i = this.curQ();
    if (i < 0) return;
    this.skipped = [...this.skipped, i]; this.cur = i + 1; this.persist(); cx.notify();
  }

  say(text, kind = "dim") { this.note = text; this.noteKind = kind; }

  runScript(args, label, cx, done) {
    if (this.act) return;
    this.act = label; this.say(`${label}…`, "yellow"); cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(ROUTINES(), args, { timeout: 300000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "failed");
        done?.(r.stdout.trim());
      } catch (e) { this.say(String(e.message ?? e), "red"); }
      this.act = null; cx.notify();
    });
  }

  send(cx) {
    const qs = this.questions(), extra = this.reply.value().trim();
    const text = answersMessage(qs, this.answers, qs.length && this.curQ() >= 0 ? extra : extra);
    if (!Object.keys(this.answers).length && !extra) { this.say("Write an answer first", "red"); cx.notify(); return; }
    this.runScript(["send", this.report.worktree, text], "Sending to Claude", cx, () => {
      this.answers = {}; this.skipped = []; this.cur = 0; this.reply.set_value(""); this.persist();
      this.say("Sent. Claude is updating the report.", "green");
    });
  }

  /** Approve = squash-merge the PR; keep = revert everything but the report, then merge. Both end the run. */
  finish(kind, cx) {
    const r = this.report;
    const args = [kind === "keep" ? "keep-only" : "approve", r.worktree];
    this.runScript(args, kind === "keep" ? "Keeping the report only" : "Merging", cx, (out) => {
      r.done = kind === "keep" ? "report-only" : "merged";
      this.say(out || "Merged", "green");
      notify({ title: kind === "keep" ? "Report kept, changes dropped" : "Run approved and merged", body: r.routine, level: "success", timeout: 4000 });
      const sp = spaces().find((x) => x.folder === r.worktree);
      if (sp) run("space.close", { id: sp.id, confirmed: true });
    });
  }

  reportBody() {
    const { front, body } = this.parsed();
    const { before, questions, after } = splitReport(body);
    const cur = this.curQ();
    const fileDate = baseName(this.p.path).replace(/\.md$/, "");
    const q = (text, i) => {
      const a = this.answers[i], isCur = i === cur, skipped = this.skipped.includes(i) && !a;
      return h_flex().id(`q-${this.uid}-${i}`).gap(0).items_stretch().cursor_pointer()
        .on_click((_e, cx) => { this.skipped = this.skipped.filter((x) => x !== i); delete this.answers[i]; this.cur = i; this.persist(); cx.notify(); })
        .child(div().w(2).flex_none().rounded(1).bg(isCur ? C.ember : "#00000000"))
        .child(v_flex().flex_1().min_w(0).gap(3).px(14).py(8)
          .child(h_flex().gap(8).items_baseline()
            .child(div().text_size(14).text_color(isCur ? C.text : a || skipped ? C.muted : C.dim).child(`${i + 1}. ${text}`))
            .when(isCur, (e) => e.child(div().text_size(SIZE.meta).text_color(C.link).child("current"))))
          .when(Boolean(a), (e) => e.child(div().text_size(SIZE.body).text_color(C.dim).child(`You: ${a}`))));
    };
    return div().id(`rb-${this.uid}`).flex_1().min_h(0).overflow_y_scroll().child(
      div().w_full().max_w(680).mx_auto().px(24).pt(20).pb(28).text_color(C.text2).text_size(14)
        .child(div().font_family(MONO).text_size(SIZE.meta).text_color(C.muted).pb(8).child(`${this.report.title ?? this.report.routine} · ${runLine(front.run, fileDate)}${front.test === "true" ? " · test" : ""}`))
        .child(TextView.markdown(`md-${this.uid}`, before).selectable(true).on_link_click((url, cx) => this.link(url, cx)))
        .when(questions.length > 0, (e) => e.child(v_flex().pt(14).gap(2)
          .child(div().text_size(20).font_semibold().text_color(C.text).pb(8).child("Questions for you"))
          .children(questions.map(q))))
        .when(Boolean(after.trim()), (e) => e.child(TextView.markdown(`md2-${this.uid}`, after).selectable(true))));
  }

  feedbackZone(cx) {
    const qs = this.questions(), cur = this.curQ(), pending = this.reportStatus() === "to-review" && !this.report.done;
    const n = qs.length, got = this.answered();
    const btn = (id, label, kbd, primary, onClick, disabled) => h_flex().id(`${id}-${this.uid}`).h(28).px(10).gap(6).items_center().rounded(7).text_size(SIZE.meta)
      .when(primary && !disabled, (e) => e.bg(C.ember).text_color("#17140F").font_medium())
      .when(!primary || disabled, (e) => e.text_color(disabled ? C.dim : C.text2).border_1().border_color(C.line3))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .child(label).when(Boolean(kbd), (e) => e.child(div().font_family(MONO).text_size(10).opacity(0.7).child(kbd)));
    const sc = { dim: C.dim, red: C.red, green: C.greenText, yellow: C.yellow }[this.noteKind] ?? C.dim;
    return v_flex().flex_none().w_full().max_w(680).mx_auto().px(24).pb(14).gap(8)
      .child(h_flex().items_center().text_size(SIZE.meta).text_color(C.muted)
        .child(div().child(n ? `Your answers · ${got} of ${n} answered` : "Your reply"))
        .child(div().flex_1())
        .child(div().text_color(this.noteKind === "dim" ? C.dim : sc).child(this.note || "click a question to answer it")))
      .child(v_flex().rounded(10).border_1().border_color(C.line3).bg(C.bg)
        .when(cur >= 0, (e) => e.child(h_flex().mx(10).mt(10).h(28).px(8).gap(8).items_center().rounded(6).bg(C.raised).text_size(SIZE.meta).text_color(C.text2)
          .child(div().w(2).h(14).rounded(1).bg(C.ember))
          .child(div().flex_1().min_w(0).truncate().child(`Question ${cur + 1} of ${n} · \u201c${qs[cur]}\u201d`))))
        .child(div().px(14).py(10).child(Input.new(this.reply).w_full().text_size(14).text_color(C.text)))
        .child(h_flex().h(40).px(10).gap(8).items_center().border_t(1).border_color(C.line2)
          .child(div().flex_1().min_w(0).truncate().text_size(SIZE.meta).text_color(C.dim).child(`run conversation${this.model ? ` · ${this.model}` : ""}`))
          .when(cur >= 0, (e) => e.child(div().text_size(SIZE.caps).text_color(C.dim).child("\u21b5 answer and go to next")).child(div().id(`skip-${this.uid}`).text_size(SIZE.caps).text_color(C.dim).cursor_pointer().hover((s) => s.text_color(C.text2)).on_click((_e, cx) => this.skip(cx)).child("\u21e5 skip")))
          .child(btn("keep", "Keep report only", null, false, (_e, cx) => this.finish("keep", cx), !pending || Boolean(this.act)))
          .child(btn("approve", "Approve", "\u2318\u21b5", false, (_e, cx) => this.finish("approve", cx), !pending || Boolean(this.act)))
          .child(btn("send", "Send to Claude", "\u21b5", true, (_e, cx) => this.send(cx), !pending || Boolean(this.act)))));
  }

  // ---- tab ------------------------------------------------------------------------

  share(at) {
    const p = this.p;
    try {
      openOverlay({ mod: "pm-md", kind: "popup", width: 300, height: 82, ...(at ? { at } : {}), props: { menu: true, path: p.path, root: p.root, on: p.on, text: this.current() } });
    } catch (e) { notify({ title: "Share failed", body: String(e), level: "error" }); }
  }

  header() {
    const p = this.p, dir = p.path.split("/").slice(0, -1).join("/"), rootName = p.root.split("/").pop();
    const seg = (id, label) => div().id(`seg-${this.uid}-${id}`).h(22).px(10).flex().items_center().rounded(6).text_size(SIZE.meta).cursor_pointer()
      .when(this.view === id, (e) => e.bg(C.raised).text_color(C.text))
      .when(this.view !== id, (e) => e.text_color(C.muted).hover((s) => s.text_color(C.text2)))
      .on_click((_e, cx) => {
        this.commitBlock(cx);
        if (id === "source") this.ensureEditor(cx);
        else if (this.editor) this.text = this.editor.value();
        this.view = id; cx.notify();
      }).child(label);
    return h_flex().h(38).flex_none().px(14).gap(8).items_center().border_b(1).border_color(C.line1)
      .child(div().text_size(SIZE.body).font_medium().text_color(C.text).flex_none().child(this.name))
      .child(div().text_color(C.dim).flex_none().child("·"))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).child(dir ? `${rootName} / ${dir}` : rootName))
      .when(Boolean(this.report), (e) => e.child(div().flex_none().text_size(SIZE.meta).text_color(this.reportStatus() === "to-review" ? C.link : C.muted).child(this.reportStatusLabel())))
      .child(h_flex().id(`share-${this.uid}`).h(26).flex_none().px(10).gap(6).items_center().rounded(7).border_1().border_color(C.line3)
        .text_size(SIZE.meta).text_color(C.text2).cursor_pointer().hover((s) => s.bg(C.raised))
        .on_click(() => this.share())
        .child(icon("share", 13, C.muted)).child("Share").child(icon("chevron-down", 10, C.dim)))
      .child(h_flex().h(26).flex_none().p(2).gap(2).items_center().rounded(7).bg(C.bg).child(seg("rendered", "Rendered")).child(seg("source", "Source")));
  }

  body() {
    if (this.error) return div().p(16).text_size(SIZE.meta).text_color(C.red).child(this.error);
    if (this.text === null) return div().p(16).text_size(SIZE.meta).text_color(C.dim).child("Loading…");
    if (this.view === "source" && this.editor) {
      return div().id(`src-${this.uid}`).flex_1().min_h(0).px(16).py(12).child(Editor.new(this.editor).size_full().text_color(C.text2));
    }
    if (this.report) return this.reportBody();
    return this.blocksView();
  }

  // ---- menu -----------------------------------------------------------------------

  initMenu(cx) {
    const p = this.p;
    this.hasRemote = false; this.branch = null;
    cx.spawn(async (cx) => {
      const git = (...a) => exec("git", a, { cwd: p.root, on: p.on }).catch(() => ({ code: 1, stdout: "" }));
      const [remote, br] = await Promise.all([git("remote"), git("rev-parse", "--abbrev-ref", "HEAD")]);
      this.hasRemote = remote.code === 0 && remote.stdout.trim() !== "";
      this.branch = br.code === 0 ? br.stdout.trim() : null;
      cx.notify();
    });
  }

  menuItem(id, label, kbd, onClick, disabled = false) {
    return h_flex().id(`mi-${id}`).h(30).mx(4).px(8).gap(8).items_center().rounded(6).text_size(SIZE.body)
      .text_color(disabled ? C.dim : C.text2)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(C.raised)).on_click(onClick))
      .child(div().flex_1().child(label)).child(kbd ? Kbd(kbd) : div());
  }

  renderMenu() {
    const p = this.p, done = () => closeOverlay(p.overlay);
    const fail = (e) => notify({ title: "Share failed", body: String(e), level: "error" });
    return v_flex().size_full().py(4).bg(C.surface).text_color(C.text2)
      // One copy carries both flavors: HTML for Slack, Notion, mail; the raw Markdown as plain text for GitHub, editors, terminals.
      .child(this.menuItem("copy", "Copy", "⌘⇧C", () => { done(); copyRich(p.text).catch(fail); }))
      .child(div().h(1).my(3).mx(4).bg(C.line1))
      .child(this.menuItem("gh", "Open on GitHub", "↗", () => {
        const args = ["browse", p.path, "-n", ...(this.branch ? ["--branch", this.branch] : [])];
        done();
        exec("gh", args, { cwd: p.root, on: p.on }).then((r) => {
          const url = (r.stdout || r.stderr).trim();
          if (r.code !== 0) return fail(url);
          exec("open", [url]);
        }, fail);
      }, !this.hasRemote));
  }

  render(cx) {
    if (this.mode === "menu") return this.renderMenu();
    return v_flex().id(`md-${this.uid}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(C.surface).border_1().border_color(C.line1)
      .text_color(C.text2).text_size(SIZE.body).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.platform && !e.modifiers.shift && e.key === "s") { cx.stop_propagation(); this.save(cx); }
        // Approve with \u2318\u21b5 while this report has the keyboard (not a keys.json binding: it would take \u2318\u21b5 from terminals and dialogs).
        else if (e.modifiers.platform && !e.modifiers.shift && e.key === "enter" && this.report && this.reportStatus() === "to-review" && !this.report.done && !this.act) { cx.stop_propagation(); this.finish("approve", cx); }
      })
      .child(this.header()).child(this.body())
      .child(this.report && this.view === "rendered" && this.text !== null ? this.feedbackZone(cx) : div());
  }
}
