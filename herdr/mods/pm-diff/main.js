// @ts-check
// Side-by-side diff as a tab (screen 04).
// Open: run("tab.new", { name, mod: "pm-diff", props: { root, path, base?, on? } })
//   root: worktree folder, path: file shown first, base: branch to diff against (merge-base with HEAD,
//   working tree included); without base it diffs against HEAD. A file without changes is shown whole.
// Click a line number to comment; "Send all to Claude" sends one message to the workspace's Claude terminal.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { nextCommand, exec, hc, readTextFile, run, notify, props, agents, panes } from "herdr";
import { C, SIZE, MONO, icon } from "./ui.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbcfc96d";
const MAX_LINES = 20000;
const RED_ROW = "#2A1716", GREEN_ROW = "#1B2416";
const RED_NUM = "#3A1D1B", GREEN_NUM = "#233019";

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - ((s.length - 1) % 4) + 4));

async function git(cwd, args, on, timeout) {
  try {
    const r = await exec("git", [...READ, ...args], { cwd, on, ...(timeout ? { timeout } : {}) });
    return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
  } catch (e) { return { ok: false, out: "", err: String(e) }; }
}

/** Rows of a unified diff: hunk headers, and lines with old/new numbers. */
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = untab(line.slice(1)) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, neu: next++, text };
    if (kind === " ") return { kind, old: old++, neu: next++, text };
    return { kind: "@", text: line };
  });
}

/** Pairs removed and added lines into left/right columns. */
function pairRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "@") { out.push({ hunk: r.text }); i++; continue; }
    if (r.kind === " ") { out.push({ l: { n: r.old, text: r.text }, r: { n: r.neu, text: r.text }, ctx: true }); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "-") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "+") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ l: dels[k] ? { n: dels[k].old, text: dels[k].text } : null, r: adds[k] ? { n: adds[k].neu, text: adds[k].text } : null });
    }
  }
  return out;
}

/** The refs and file list of the tab: working tree against base (merge-base) or HEAD. */
async function changed(root, on, base) {
  const head = await git(root, ["rev-parse", "--verify", "HEAD"], on);
  let ref = head.ok ? "HEAD" : EMPTY_TREE;
  if (base && head.ok) {
    const mb = await git(root, ["merge-base", base, "HEAD"], on);
    if (mb.ok && mb.out.trim()) ref = mb.out.trim();
  }
  const [names, nums, fresh] = await Promise.all([
    git(root, ["diff", ref, "--name-status", "-z", "--no-renames"], on),
    git(root, ["diff", ref, "--numstat", "-z", "--no-renames"], on),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"], on),
  ]);
  const stats = {};
  for (const e of nums.out.split("\0")) {
    const [a, d, ...rest] = e.split("\t");
    if (rest.length) stats[rest.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0 };
  }
  const files = [];
  const t = names.out.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < t.length; i += 2) files.push({ path: t[i + 1], status: t[i][0] === "D" ? "D" : t[i][0] === "A" ? "A" : "M", ...(stats[t[i + 1]] ?? { add: 0, del: 0 }) });
  const seen = new Set(files.map((f) => f.path));
  for (const p of fresh.out.split("\0").filter(Boolean).slice(0, 200)) {
    if (seen.has(p)) continue;
    const text = await readTextFile(`${root}/${p}`, { on }).catch(() => null);
    const n = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
    files.push({ path: p, status: "A", fresh: true, add: n, del: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ref, files };
}

async function loadDiff(root, on, ref, path, file) {
  const asContext = async (prefix, label) => {
    const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
    if (text === null) return { note: "Cannot preview this file (binary, too large, or unreadable)", lines: [] };
    if (text.includes("\0")) return { note: "Binary file: no text diff", lines: [] };
    const body = text.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
    return { note: label, lines: [`@@ -${prefix ? 0 : 1},${prefix ? 0 : body.length} +1,${body.length} @@`, ...body.map((l) => `${prefix || " "}${l}`)] };
  };
  if (file?.fresh) return asContext("+", null);
  const r = await git(root, ["diff", ref, "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "--", path], on, 60000);
  if (!r.ok) return { note: r.err, lines: [] };
  const all = r.out.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return file ? { note: "Binary file or mode change: no text diff", lines: [] } : asContext("", "No changes in this file. Showing it whole.");
  return { note: null, lines: all.slice(first, first + MAX_LINES).map((l) => (l.length > 3000 ? `${l.slice(0, 3000)}…` : l)) };
}

const isClaude = (a) => a.program?.key === "claude" || /claude/i.test(a.app ?? "");

/** Sends one message to the Claude terminal running in `root`, or starts one there. */
export async function sendToClaude(root, text) {
  const inside = (cwd) => cwd && (cwd === root || cwd.startsWith(`${root}/`));
  const paneCwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  const found = agents().filter((a) => isClaude(a) && inside(paneCwd.get(a.pane)));
  const claude = found.find((a) => a.focused) ?? found[0];
  if (claude) {
    const r = await hc(["send", claude.address, text]);
    if (r.code !== 0) { notify({ title: "Could not send to Claude", body: r.stderr.trim(), level: "error" }); return false; }
    run("agent.focus", { terminal: claude.address });
  } else run("tab.new", { name: "claude", folder: root, argv: ["claude"], task: text });
  return true;
}

export default class PmDiff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.uid = Math.random().toString(36).slice(2, 7);
    this.root = p.root; this.on = p.on ?? null; this.base = p.base ?? null;
    this.path = p.path ?? ""; this.files = []; this.ref = "HEAD";
    this.mode = "split"; this.rows = []; this.pairs = []; this.note = null; this.loading = true;
    this.comments = []; this.editing = null; this.editor = null; this.nextId = 1;
    this.dirty = true; this.items = []; this.sizes = [];
    this.loadAll(cx);
  }

  loadAll(cx) {
    cx.spawn(async (cx) => {
      try {
        const { ref, files } = await changed(this.root, this.on, this.base);
        this.ref = ref; this.files = files;
        this.branch = (await git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], this.on)).out.trim();
      } catch (e) { this.note = String(e); }
      await this.loadFile(cx);
    });
  }

  async loadFile(cx) {
    const path = this.path;
    this.loading = true; cx.notify();
    const file = this.files.find((f) => f.path === path);
    const r = await loadDiff(this.root, this.on, this.ref, path, file);
    if (path !== this.path) return;
    this.note = r.note; this.rows = diffRows(r.lines); this.pairs = pairRows(this.rows);
    this.loading = false; this.dirty = true; cx.notify();
  }

  /** Commands (`herdr-app do pm-diff.<cmd>` or keys.json "pm-diff:<cmd>"): split, unified, next, prev,
   *  comment:<R|L><line>:<text> (adds a comment without the mouse), send. */
  command(cmd, cx) {
    if (cmd === "split" || cmd === "unified") { this.mode = cmd; this.dirty = true; }
    else if (cmd === "next") this.go(1, cx);
    else if (cmd === "prev") this.go(-1, cx);
    else if (cmd === "send") this.send(cx);
    else if (cmd.startsWith("comment:")) {
      const [, anchor, ...rest] = cmd.split(":");
      const row = this.rows.find((r) => (anchor[0] === "L" ? r.kind !== "+" && r.old === Number(anchor.slice(1)) : r.kind !== "-" && r.neu === Number(anchor.slice(1))));
      if (row) this.comments.push({ id: this.nextId++, path: this.path, anchor, line: Number(anchor.slice(1)), quote: row.text, text: rest.join(":") });
      this.dirty = true;
    }
    cx.notify();
  }

  go(delta, cx) {
    const i = this.files.findIndex((f) => f.path === this.path);
    const j = i + delta;
    if (j < 0 || j >= this.files.length) return;
    this.path = this.files[j].path; this.editing = null; this.rows = []; this.pairs = [];
    this.loadFile(cx);
  }

  // ---- comments -----------------------------------------------------------------

  startEdit(anchor, line, quote, cx) {
    if (!this.editor) {
      this.editor = TextareaState.new({ placeholder: "Comment for Claude (Enter to add)", rows: 3 });
      this.editor.on("submit", (_e, cx) => this.addComment(cx));
    } else this.editor.set_value("");
    this.editing = { anchor, line, quote };
    this.dirty = true; cx.notify();
    cx.spawn(async (cx) => { this.editor.focus(); cx.notify(); });
  }

  addComment(cx) {
    const text = this.editor?.value().trim();
    if (!text || !this.editing) return;
    this.comments.push({ id: this.nextId++, path: this.path, ...this.editing, text });
    this.editing = null; this.editor.set_value(""); this.dirty = true; cx.notify();
  }

  removeComment(id, cx) { this.comments = this.comments.filter((c) => c.id !== id); this.dirty = true; cx.notify(); }

  async send(cx) {
    if (!this.comments.length || this.sending) return;
    this.sending = true; cx.notify();
    const text = `Review comments on ${this.branch || "this branch"} (${this.comments.length}). Address each one:\n\n`
      + this.comments.map((c) => `${c.path}:${c.line}${c.anchor[0] === "L" ? " (removed line)" : ""}\n> ${c.quote.trim()}\n${c.text}`).join("\n\n");
    const ok = await sendToClaude(this.root, text);
    this.sending = false;
    if (ok) {
      notify({ title: `${this.comments.length} comment${this.comments.length === 1 ? "" : "s"} sent to Claude`, level: "info", timeout: 4000 });
      this.comments = []; this.dirty = true;
    }
    cx.notify();
  }

  // ---- display list ---------------------------------------------------------------

  build() {
    const items = [], sizes = [];
    this.byKey = new Map();
    const push = (it, h) => { it.key = `${items.length}`; this.byKey.set(it.key, it); items.push(it); sizes.push(h); };
    const extras = (anchors) => {
      for (const c of this.comments) {
        if (c.path === this.path && anchors.includes(c.anchor)) push({ comment: c }, 14 + 18 * Math.max(1, c.text.split("\n").reduce((n, l) => n + (Math.ceil(l.length / 110) || 1), 0)));
      }
      if (this.editing && anchors.includes(this.editing.anchor)) push({ editor: true }, 96);
    };
    if (this.mode === "split") {
      for (const r of this.pairs) {
        if (r.hunk !== undefined) { push({ hunk: r.hunk }, 26); continue; }
        const side = r.r ? { anchor: `R${r.r.n}`, line: r.r.n, quote: r.r.text } : { anchor: `L${r.l.n}`, line: r.l.n, quote: r.l.text };
        push({ ...r, target: side }, 20);
        extras([r.r && `R${r.r.n}`, r.l && `L${r.l.n}`].filter(Boolean));
      }
    } else {
      for (const r of this.rows) {
        if (r.kind === "@") { push({ hunk: r.text }, 26); continue; }
        const del = r.kind === "-";
        push({ u: r, target: { anchor: del ? `L${r.old}` : `R${r.neu}`, line: del ? r.old : r.neu, quote: r.text } }, 20);
        extras([del ? `L${r.old}` : `R${r.neu}`]);
      }
    }
    this.items = items; this.sizes = sizes; this.dirty = false;
  }

  /** The list's one click handler: a code line opens a comment on it, a comment row removes it. */
  clicked(key, cx) {
    const it = this.byKey?.get(key);
    if (!it) return;
    if (it.comment) this.removeComment(it.comment.id, cx);
    else if (it.target) this.startEdit(it.target.anchor, it.target.line, it.target.quote, cx);
  }

  hasComment(anchor) { return this.comments.some((c) => c.path === this.path && c.anchor === anchor); }

  num(anchor, n, bg, w = 48) {
    const has = n !== undefined && this.hasComment(anchor);
    return div().w(w).flex_none().h_full().pr(8).text_right().bg(bg).text_color(has ? C.ember : C.dim).child(n === undefined ? "" : String(n));
  }

  cell(side, c, kind) {
    if (!c) {
      return h_flex().flex_1().min_w(0).h(20).overflow_hidden().relative().bg("#1A1612")
        .child(svg("mods/pm-diff/hatch.svg").w(1600).h(20).flex_none().absolute().top(0).left(0).text_color("#2A241D"));
    }
    const anchor = `${side}${c.n}`;
    const bg = kind === "-" ? RED_ROW : kind === "+" ? GREEN_ROW : "#00000000";
    const nbg = kind === "-" ? RED_NUM : kind === "+" ? GREEN_NUM : "#00000000";
    return h_flex().flex_1().min_w(0).h(20).overflow_hidden().bg(bg)
      .child(this.num(anchor, c.n, nbg))
      .child(div().flex_1().min_w(0).px(8).truncate().text_color(kind === "-" ? "#E9B3A9" : kind === "+" ? "#C5DDB0" : C.text2).child(c.text));
  }

  hunkRow(text) {
    const m = /^(@@[^@]*@@)(.*)$/.exec(text);
    return h_flex().w_full().h(26).flex_none().px(16).items_center().gap(8).bg("#1A1612").text_color(C.dim)
      .child(div().child(m ? m[1] : text)).child(div().min_w(0).truncate().text_color("#554C41").child(m ? m[2].trim() : ""));
  }

  commentRow(c) {
    return h_flex().w_full().flex_none().px(16).py(6).gap(10).items_start().bg("#211B15").font_family("Geist").text_size(SIZE.body)
      .child(div().flex_none().mt(1).font_semibold().text_color(C.ember).child("You"))
      .child(div().flex_none().mt(2).text_size(SIZE.caps).text_color(C.dim).child(`line ${c.line}`))
      .child(div().flex_1().min_w(0).text_color(C.text).child(c.text))
      .child(div().flex_none().text_size(SIZE.caps).text_color(C.dim).child("click to remove"));
  }

  editorRow() {
    return v_flex().w_full().flex_none().px(16).py(8).gap(6).bg("#211B15").font_family("Geist").text_size(SIZE.body)
      .child(h_flex().gap(8).text_size(SIZE.meta).text_color(C.muted)
        .child(div().text_color(C.ember).font_semibold().child("Comment"))
        .child(div().font_family(MONO).min_w(0).truncate().child(`line ${this.editing.line} \u00b7 ${this.editing.quote.trim().slice(0, 80)}`)))
      .child(div().h(54).rounded(6).border_1().border_color(C.line3).px(8).py(4).child(Textarea.new(this.editor).size_full().text_color(C.text)));
  }

  item(it) {
    if (it.hunk !== undefined) return this.hunkRow(it.hunk);
    if (it.comment) return this.commentRow(it.comment);
    if (it.editor) return this.editorRow();
    if (it.u) {
      const r = it.u, k = r.kind;
      const bg = k === "-" ? RED_ROW : k === "+" ? GREEN_ROW : "#00000000";
      const nbg = k === "-" ? RED_NUM : k === "+" ? GREEN_NUM : "#00000000";
      const anchor = k === "-" ? `L${r.old}` : `R${r.neu}`;
      return h_flex().w_full().h(20).flex_none().overflow_hidden().bg(bg)
        .child(k === "-" ? this.num(anchor, r.old, nbg) : div().w(48).flex_none().h_full().pr(8).text_right().bg(nbg).text_color(C.dim).child(r.old === undefined ? "" : String(r.old)))
        .child(k === "-" ? div().w(48).flex_none().h_full().bg(nbg) : this.num(anchor, r.neu, nbg))
        .child(div().w(18).flex_none().text_color(C.dim).child(k === " " ? "" : k))
        .child(div().flex_1().min_w(0).truncate().text_color(k === "-" ? "#E9B3A9" : k === "+" ? "#C5DDB0" : C.text2).child(r.text));
    }
    return h_flex().w_full().h(20).flex_none()
      .child(this.cell("L", it.l, it.l && !it.ctx ? "-" : it.ctx ? " " : null).border_r(1).border_color(C.line1))
      .child(this.cell("R", it.r, it.r && !it.ctx ? "+" : it.ctx ? " " : null));
  }

  // ---- header ---------------------------------------------------------------------

  seg(id, label, mode) {
    const on = this.mode === mode;
    return div().id(`seg-${id}-${this.uid}`).h(24).px(10).flex().items_center().rounded(6).text_size(SIZE.meta + 0.5).cursor_pointer()
      .bg(on ? C.raised : "#00000000").text_color(on ? C.text : C.muted).hover((s) => s.text_color(C.text))
      .on_click((_e, cx) => { this.mode = mode; this.dirty = true; cx.notify(); }).child(label);
  }

  arrow(id, name, delta, enabled) {
    return div().id(`${id}-${this.uid}`).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(C.raised)).on_click((_e, cx) => this.go(delta, cx)))
      .child(icon(name, 14, enabled ? C.text2 : C.line3));
  }

  header() {
    const i = this.files.findIndex((f) => f.path === this.path), f = this.files[i];
    const slash = this.path.lastIndexOf("/"), name = this.path.slice(slash + 1);
    return h_flex().h(44).flex_none().px(16).gap(10).items_center().border_b(1).border_color(C.line1)
      .child(div().flex_none().text_size(SIZE.body).font_semibold().text_color(C.text).child(name))
      .child(div().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).child(this.path))
      .when(Boolean(f), (e) => e.child(h_flex().flex_none().gap(6).font_family(MONO).text_size(SIZE.meta)
        .child(div().text_color(C.greenText).child(`+${f.add}`)).child(div().text_color(C.red).child(`−${f.del}`))))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(2).items_center()
        .child(this.arrow("prev", "chevron-left", -1, i > 0)).child(div().font_family(MONO).text_size(SIZE.caps + 1).text_color(C.dim).child(this.files.length ? `${i + 1}/${this.files.length}` : ""))
        .child(this.arrow("next", "chevron-right", 1, i >= 0 && i < this.files.length - 1)))
      .child(h_flex().flex_none().gap(2).child(this.seg("split", "Side by side", "split")).child(this.seg("uni", "Unified", "unified")));
  }

  footer() {
    const n = this.comments.length;
    const btn = (id, label, primary, fn) => div().id(`${id}-${this.uid}`).h(28).px(12).flex().items_center().rounded(7).text_size(SIZE.meta + 0.5).font_medium().cursor_pointer()
      .when(primary, (e) => e.bg(C.ember).text_color("#1B140D").hover((x) => x.opacity(0.88)))
      .when(!primary, (e) => e.text_color(C.muted).hover((x) => x.text_color(C.text)))
      .on_click((_e, cx) => fn(cx)).child(label);
    return h_flex().h(44).flex_none().px(16).gap(10).items_center().border_t(1).border_color(C.line1)
      .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body).text_color(C.text2)
        .child(this.editing ? `Commenting on line ${this.editing.line}` : `${n} comment${n === 1 ? "" : "s"}`))
      .when(Boolean(this.editing), (e) => e.child(btn("ccancel", "Cancel", false, (cx) => { this.editing = null; this.dirty = true; cx.notify(); }))
        .child(btn("cadd", "Add comment", !n, (cx) => this.addComment(cx))))
      .when(n > 0, (e) => e.child(btn("send", this.sending ? "Sending\u2026" : "Send all to Claude", true, (cx) => this.send(cx))));
  }

  render(cx) {
    if (!this.cmdLoop) {
      this.cmdLoop = true;
      cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); } });
    }
    if (this.dirty) this.build();
    const id = `vl-${this.uid}-${this.mode}`;
    return v_flex().size_full().min_h(0).bg(C.surface).text_color(C.text2).text_size(SIZE.body).font_family("Geist")
      .child(this.header())
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(16).py(6).font_family("Geist").text_size(SIZE.meta).text_color(C.muted).child(this.note)))
      .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(11.5)
        .when(this.loading, (e) => e.child(div().p(16).font_family("Geist").text_color(C.dim).child("Loading diff…")))
        .when(!this.loading, (e) => e
          .child(div().absolute().inset_0().child(v_virtual_list(id, this.items.length, this.sizes, (i) => this.items[i].key,
            (range) => this.items.slice(range.start, range.end).map((it) => { try { return this.item(it); } catch (e) { return div().h(20).text_color("#f00").child(String(e)); } })).size_full().on_item_click((key, cx) => this.clicked(key, cx))))
          .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0())))
      .when(this.comments.length > 0 || Boolean(this.editing), (e) => e.child(this.footer()));
  }
}
