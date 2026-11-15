// @ts-check
// Summary: the Claude Code conversation of the active tab, drawn natively from its JSONL
// transcript, with question / permission / plan cards and a composer that drives the real
// terminal through herdr-core. Two roles, both placed by layouts/pm.json:
//   props.role "header": the 38 px bar above the tab ("Claude Code · repo / workspace · status ·
//     [Summary | Terminal]"). It also keeps the layout in step: it selects the "main-stack" child
//     (the tab's panes, or the "summary" block) and collapses itself on tabs without a terminal.
//   default: the Summary block, the stack's other child. The terminal stays alive underneath.
// The view per tab lives in shared("pm.view"): { [tabId]: "terminal" | "summary" } (default summary).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, Scrollbar, ScrollHandle, Popover } from "gpui-base";
import {
  exec, home, appHome, props, readTextFile, panes, agents, spaces, layout, shared, setShared, run, openOverlay,
  watchFolder, nextCommand, notify, terminals,
} from "herdr";
import { C, MONO, SANS, icon } from "./ui.js";
import * as cc from "./claude.js";

const HEAD = 38;
const POLL = 3000;
const WINDOW = 80; // rows drawn at once; "Show earlier" adds more
const CONTEXT = 1_000_000; // the 5.x models' window, as Claude Code's footer reports it
const BUBBLE = "#2C261F", CARD = "#1D1914";

const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
const short = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? (s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`) : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-");
function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
const isClaude = (p) => p.program?.key === "claude" || p.app === "claude-code";

/** The active tab, its Claude pane (focused one first) and what the header needs. */
function target() {
  const sp = spaces().find((s) => s.active);
  const tab = sp?.tabs.find((t) => t.active);
  if (!tab) return null;
  const ps = panes().filter((p) => p.tab === tab.id);
  const cl = ps.filter((p) => p.terminal && isClaude(p));
  const pane = cl.find((p) => p.focused) ?? cl[0] ?? null;
  const any = ps.find((p) => p.terminal && p.focused) ?? ps.find((p) => p.terminal) ?? null;
  return { sp, tab, pane, term: pane?.terminal ?? null, cwd: pane?.cwd ?? any?.cwd ?? null, any, scratch: tab.name === "scratch" };
}
const viewOf = (tabId) => (shared("pm.view") ?? {})[tabId] ?? "summary";
function setView(tabId, v) { setShared("pm.view", { ...(shared("pm.view") ?? {}), [tabId]: v }); }

/** Opens pm-diff on the worktree: the branch against the repo's default branch, one file selected when given. */
function openDiff(path, root) {
  const rel = path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root, timeout: 10000 })
    .then((r) => (r.code === 0 ? r.stdout.trim() : null), () => null)
    .then((b) => run("tab.new", { name: rel ? base(rel) : "Diff", mod: "pm-diff", props: { root, path: rel ?? "", base: b || null } }));
}

// What a user string is: a prompt, a slash command, or harness noise to hide.
function userText(text) {
  text = text.replace(/^<hc from="[^"]*">([\s\S]*)<\/hc>$/, "$1");
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) { const a = /<command-args>([^<]*)<\/command-args>/.exec(text); return `${cmd[1]}${a?.[1] ? ` ${a[1]}` : ""}`; }
  if (/^<(task-notification|system|local-command|bash-|user-memory)/.test(text)) return null;
  if (text.startsWith("[Request interrupted")) return null;
  return text;
}
function toolLabel(tu) {
  if (tu.name === "Agent" || tu.name === "Task") return `Agent · ${tu.desc ?? tu.sub ?? ""}`;
  if (tu.file) return `${tu.name} ${base(tu.file)}`;
  if (tu.desc) return `${tu.name} · ${tu.desc}`;
  return tu.name.replace(/^mcp__([^_]+)__/, "$1 · ");
}
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** One transcript read incrementally (read.sh: byte offset, complete lines only). */
class Feed {
  constructor(file) { this.file = file; this.offset = 0; this.recs = []; this.loaded = false; this.error = null; this.bad = 0; this.unknown = {}; this.lines = 0; }
  async pull() {
    const dir = `${appHome()}/mods/pm-summary`;
    const r = await exec("sh", [`${dir}/read.sh`, this.file, String(this.offset), `${dir}/project.jq`], { timeout: 120000 });
    if (r.code !== 0) { this.error = r.stderr.trim() || `read failed (${r.code})`; return true; }
    let end = null, added = 0;
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { this.bad++; continue; }
      if (rec.k === "end") { end = rec; continue; }
      this.lines++;
      if (rec.k === "bad") { this.bad++; continue; }
      if (rec.k === "x") { this.unknown[rec.t] = (this.unknown[rec.t] ?? 0) + 1; continue; }
      this.recs.push(rec); added++;
    }
    if (end && end.s < this.offset) { this.offset = 0; this.recs = []; this.bad = 0; this.unknown = {}; this.lines = 0; return this.pull(); }
    if (end) this.offset += end.b;
    const first = !this.loaded;
    this.loaded = true;
    return added > 0 || first;
  }
  /** Schema drift: most lines unreadable, or a big file with no conversation in it. */
  broken() {
    if (this.error) return true;
    if (this.lines >= 20 && this.bad / this.lines > 0.5) return true;
    return this.offset > 20000 && !this.recs.some((r) => r.k === "u" || r.k === "a");
  }
}

/** Turns records into rows: user bubbles, folded tool runs, assistant text, file chips. */
function buildRows(recs, expanded, metas = []) {
  const finished = new Map(metas.map((m) => [m.toolUseId, Boolean(m.finished)]));
  const rows = [], results = new Map();
  let model = null, ctx = 0, effort = null, fast = false, turn = null, n = 0, mode = null, title = null, firstPrompt = null;
  const flush = (done) => {
    if (!turn) return;
    const k = turn.key, steps = turn.steps;
    const texts = steps.filter((s) => s.k === "a");
    const last = steps[steps.length - 1];
    const final = (done || last?.k === "a") ? texts[texts.length - 1] : null;
    const folded = steps.filter((s) => s !== final);
    const nTools = folded.filter((s) => s.k === "tu").length, nMsgs = folded.filter((s) => s.k === "a").length;
    if (folded.length) {
      rows.push({ kind: "fold", key: `${k}:fold`, nTools, nMsgs, open: expanded.has(`${k}:fold`), nFiles: turn.files.size, done });
      if (expanded.has(`${k}:fold`)) for (const s of folded) {
        if (s.k === "a") rows.push({ kind: "assistant", key: `${k}:a:${s.i}`, text: s.text, inner: true });
        else rows.push({ kind: "step", key: `${k}:t:${s.i}`, text: toolLabel(s), err: results.get(s.id)?.err });
      }
    }
    for (const s of steps) if (s.k === "tu" && (s.name === "Agent" || s.name === "Task"))
      rows.push({ kind: "agent", key: `agent:${s.id}`, id: s.id, desc: s.desc, sub: s.sub, model: s.model, done: finished.get(s.id) ?? results.has(s.id) });
    if (final) rows.push({ kind: "assistant", key: `${k}:final`, text: final.text });
    if (turn.files.size) rows.push({ kind: "files", key: `${k}:files`, files: [...turn.files.entries()] });
    if (done && turn.dur != null) rows.push({ kind: "meta", key: `${k}:meta`, text: ago(turn.dur), copy: final?.text ?? null });
    // Scratch: an edit Claude was refused (read-only) is what "Claude wants to edit" points at.
    const denied = steps.filter((s) => s.k === "tu" && EDIT_TOOLS.has(s.name) && results.get(s.id)?.err).pop();
    if (denied) rows.push({ kind: "wants", key: `${k}:wants`, file: denied.file });
    turn = null;
  };
  for (const r of recs) {
    n++;
    if (r.k === "u") {
      const set = /Set model to\W*(\w+ [\d.]+)/.exec(r.text);
      if (set) { model = cc.MODELS.find((x) => x.label === set[1])?.id ?? model; continue; }
      const text = userText(r.text);
      if (text == null) continue;
      flush(true);
      if (firstPrompt == null && !text.startsWith("/")) firstPrompt = text;
      rows.push({ kind: "user", key: `u:${n}`, text });
      turn = { key: `turn:${n}`, steps: [], files: new Map(), dur: null };
      continue;
    }
    if (r.k === "m") { if (r.model && r.model !== "<synthetic>") { model = r.model; ctx = r.ctx; effort = r.effort ?? effort; fast = Boolean(r.fast); } continue; }
    if (r.k === "pm") { mode = r.mode; continue; }
    if (r.k === "title") { title = r.text; continue; }
    if (r.k === "c") { flush(true); rows.push({ kind: "meta", key: `c:${n}`, text: "Conversation compacted" }); continue; }
    if (!turn) turn = { key: `turn:${n}`, steps: [], files: new Map(), dur: null };
    if (r.k === "a" && r.text.trim()) turn.steps.push({ ...r, i: n });
    else if (r.k === "tu") turn.steps.push({ ...r, i: n });
    else if (r.k === "tr") {
      results.set(r.id, r);
      if (r.file && (r.add || r.del) && !r.file.startsWith(`${home()}/.claude/`)) {
        const f = turn.files.get(r.file) ?? { add: 0, del: 0 };
        f.add += r.add ?? 0; f.del += r.del ?? 0; turn.files.set(r.file, f);
      }
    } else if (r.k === "d") turn.dur = r.ms;
  }
  const openTurn = turn;
  flush(turn?.dur != null);
  const pending = openTurn ? openTurn.steps.filter((s) => s.k === "tu" && !results.has(s.id)) : [];
  return { rows, model, ctx, effort, fast, pending, mode, title, firstPrompt };
}

export default class Summary extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "summary";
    this.issued = {};
    if (this.role === "header") { this.nameInfo = {}; return; }
    this.term = null; this.cwd = null; this.root = null; this.main = null;
    this.feeds = new Map(); // file -> Feed
    this.session = null; this.sid = null;
    this.view = "main"; // or a sub-agent id
    this.metas = [];
    this.expanded = new Set();
    this.busy = false; this.note = null; this.err = null;
    this.report = null; // herdr-core's agent report: {state, kind, msg}
    this.dialog = []; // numbered choices of the dialog on screen
    this.mode = null; this.modelOverride = null; this.effortOverride = null; this.fastOverride = null;
    this.q = { id: null, index: 0, hi: 0 };
    this.menu = null; // "model" | "approve"
    this.acting = false;
    this.shown = false;
    this.unavailable = false;
    this.scroll = ScrollHandle.new();
    this.lastCount = 0;
    // Scroll memory. ScrollHandle can't report its offset, so it is derived from pointer events:
    // a row's on-screen top (position - local_position) against its measured place in the list.
    this.follow = true;      // stick to the newest message; off once the person scrolls up
    this.unseen = 0;         // messages that arrived while scrolled up
    this.rowH = new Map();   // row key -> measured height (padding included)
    this.order = [];         // keys of the drawn rows, in order (index = child index of #conv)
    this.convBox = null;     // { top, height } of the scroll area
    this.offset = 0;         // px scrolled from the top of the list
    this.restoreKey = null;  // row to bring back to the bottom edge after a conversation switch
    this.window = WINDOW;
    this.cardFocus = cx.focus_handle();
    // Multi-line: long messages wrap and the box grows (up to 10 rows). Enter sends, Shift+Enter breaks the line.
    this.input = TextareaState.new({ placeholder: "Reply to Claude…" });
    this.input.set_auto_grow(1, 10);
    this.input.set_soft_wrap(true);
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("change", (_e, cx) => { this.keepDraft(); cx.notify(); });
    this.perTerm = new Map(); // term -> what the person left on that conversation's screen
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => { if (this.visible()) this.refresh(cx); if (this.report?.state === "working") cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  /** Key commands (keys.json: "pm-summary.<command>"): focus, approve, handoff, interrupt, skip,
   *  answer-1..9, allow, always, deny, toggle, plan, yolo, promote, sub-0 (Main) .. sub-N. */
  command(c, cx) {
    if (c === "focus") { this.input.focus(); return; }
    if (c === "toggle") { const t = target(); if (t?.pane) setView(t.tab.id, viewOf(t.tab.id) === "terminal" ? "summary" : "terminal"); return; }
    if (c === "interrupt") { this.interrupt(cx); return; }
    if (c === "promote") { this.promote(this.data(), cx); return; }
    const sub = /^sub-(\d+)$/.exec(c);
    if (sub) { const n = Number(sub[1]); this.openSub(n === 0 ? "main" : this.metas[n - 1]?.agentId ?? "main", cx); return; }
    if (c === "plan" || c === "yolo") { this.togglePlan(cx, c === "plan" ? (this.mode ?? this.data().mode) !== "plan" : false); return; }
    const card = this.cardKind(this.data());
    if (!card) return;
    const m = /^answer-([1-9])$/.exec(c);
    if (m && card.kind === "question") this.pick(cx, card, Number(m[1]) - 1);
    else if (c === "skip" && card.kind === "question") this.skip(cx, card);
    else if (c === "approve" && card.kind === "plan") this.approve(cx, card.plan);
    else if (c === "handoff" && card.kind === "plan") this.handOff(cx, card.plan);
    else if (card.kind === "permission" && (c === "allow" || c === "always" || c === "deny")) this.permission(cx, c === "allow" ? "once" : c);
  }

  visible() { return find(layout(), "main-stack")?.active === "summary"; }

  // ---- data -----------------------------------------------------------------------------

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const t = target();
        const term = t?.term ?? null;
        if (term !== this.term) {
          // Leaving a conversation keeps its screen state; coming back restores it (draft, sub-agent, folds, history depth).
          if (this.term) this.perTerm.set(this.term, { draft: this.input.value(), view: this.view, window: this.window, expanded: this.expanded, sid: this.sid, session: this.session, workMode: this.workMode, follow: this.follow, anchor: this.follow ? null : this.bottomRow() });
          const back = term ? this.perTerm.get(term) : null;
          this.term = term; this.view = back?.view ?? "main"; this.metas = []; this.report = null; this.dialog = [];
          this.mode = null; this.modelOverride = null; this.effortOverride = null; this.fastOverride = null; this.lastCount = 0; this.window = back?.window ?? WINDOW; this.unavailable = false;
          this.expanded = back?.expanded ?? new Set(); this.workMode = back?.workMode ?? null;
          this.follow = back?.follow ?? true; this.restoreKey = back?.anchor ?? null; this.unseen = 0; this.rowH = new Map();
          this.sid = back?.sid ?? null; this.session = back?.session ?? null;
          this.input.set_value(back?.draft ?? (this.sid ? this.storedDraft(this.sid) : ""));
          this.cwd = t?.cwd ?? null; this.root = await cc.toplevel(this.cwd); this.main = await cc.mainCheckout(this.cwd);
        }
        if (!term) { this.session = null; cx.notify(); return; }
        const inf = await cc.info(term);
        const was = this.report?.state;
        this.report = inf?.status ?? null;
        const s = await cc.sessionFile(inf?.foreground?.pid, this.cwd);
        if (!s) { this.session = null; this.err = "No conversation yet"; cx.notify(); return; }
        if (s.file !== this.session) {
          const first = this.session === null;
          this.session = s.file; this.sid = s.sid; this.metas = []; this.lastCount = 0;
          if (!first) { this.view = "main"; this.expanded = new Set(); this.window = WINDOW; }
          // A draft typed before Herdr restarted (or before this view was rebuilt) comes back.
          if (!this.input.value()) { const d = this.storedDraft(s.sid); if (d) this.input.set_value(d); }
        }
        this.watch(cx, s.file);
        this.err = null;
        let changed = await this.feed(s.file).pull();
        await this.loadMetas(s.file);
        if (this.view !== "main") changed = (await this.feed(this.subFile(this.view)).pull()) || changed;
        // The screen: the dialog's numbered choices while blocked, else the footer's mode.
        const sc = await cc.screen(term, this.report?.state === "blocked" ? 40 : 8);
        if (this.report?.state === "blocked") {
          this.dialog = cc.choices(sc);
          // Multi-question progress, from the dialog's tab strip ("☒ Deploy  ☐ Notify  ✔ Submit").
          const strip = /←\s+(.*?)\s+✔ Submit/.exec(sc);
          if (strip) this.qDone = (strip[1].match(/☒/g) ?? []).length;
        } else { this.qDone = null; this.dialog = []; const m = cc.modeOf(sc); if (m) this.mode = m; if (m && m !== "plan") this.workMode = m; }
        // ExitPlanMode's logged input can be stale: the plan file it names is the truth.
        const pl = this.report?.state === "blocked" ? [...buildRows(this.feed(s.file).recs, new Set(), []).pending].reverse().find((x) => x.name === "ExitPlanMode") : null;
        this.planText = pl?.planFile ? await readTextFile(pl.planFile).catch(() => null) : null;
        if (this.feed(s.file).broken() && !this.unavailable) {
          this.unavailable = true;
          const tt = target();
          if (tt?.tab && tt.term === term) setView(tt.tab.id, "terminal");
        }
        if (changed || was !== this.report?.state) cx.notify();
        else cx.notify();
      } catch (e) {
        this.err = String(e?.message ?? e); cx.notify();
      } finally { this.busy = false; }
    });
  }

  watch(cx, file) {
    const dir = file.replace(/\/[^/]+$/, "");
    if (this.watching === dir) return;
    this.watching = dir;
    cx.spawn(async (cx) => {
      while (this.watching === dir) {
        try { await watchFolder(dir); } catch { return; }
        if (this.watching !== dir) return;
        if (this.visible()) this.refresh(cx);
      }
    });
  }

  feed(file) {
    let f = this.feeds.get(file);
    if (!f) { f = new Feed(file); this.feeds.set(file, f); }
    return f;
  }
  subFile(id) { return `${this.session.replace(/\.jsonl$/, "")}/subagents/agent-${id}.jsonl`; }

  async loadMetas(file) {
    const dir = `${file.replace(/\.jsonl$/, "")}/subagents`;
    const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && for f in *.meta.json; do [ -f "$f" ] && j="${f%.meta.json}.jsonl" && printf "%s\\t%s\\t%s\\n" "$f" "$(stat -f "%B %m" "$j" 2>/dev/null)" "$(tr -d "\\n" < "$f")"; done', "sh", dir]);
    const metas = [];
    for (const line of r.stdout.split("\n")) {
      const [name, times, json] = line.split("\t");
      if (!json) continue;
      const [born, mod] = (times ?? "").split(" ").map(Number);
      try { metas.push({ agentId: name.replace(/^agent-|\.meta\.json$/g, ""), born: born * 1000, mod: mod * 1000, ...JSON.parse(json) }); } catch { /* being written */ }
    }
    this.metas = metas.sort((a, b) => a.born - b.born);
  }

  // ---- actions on the terminal ----------------------------------------------------------

  act(cx, fn) {
    if (this.acting || !this.term) return;
    this.acting = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(cx, this.term); } catch (e) { this.note = String(e?.message ?? e); }
      this.acting = false; this.menu = null;
      await cx.sleep(400);
      this.refresh(cx);
      cx.notify();
    });
  }

  /** Drafts survive a restart: one per conversation, in this mod's localStorage. */
  storedDraft(sid) { try { return localStorage.getItem(`draft:${sid}`) ?? ""; } catch { return ""; } }
  keepDraft() {
    if (!this.sid) return;
    const v = this.input.value();
    try { if (v.trim()) localStorage.setItem(`draft:${this.sid}`, v); else localStorage.removeItem(`draft:${this.sid}`); } catch { /* storage unavailable: the in-memory draft still works */ }
  }

  /** Pointer over a row: its top on screen gives the scroll offset. */
  track(key, e) {
    if (!this.convBox) return;
    let top = 28; // #conv's top padding
    for (const k of this.order) { if (k === key) break; top += this.rowH.get(k) ?? 0; }
    const onScreen = e.position.y - e.local_position.y;
    this.offset = Math.max(0, top - (onScreen - this.convBox.top));
  }

  contentHeight() { let h = 28 + 12; for (const k of this.order) h += this.rowH.get(k) ?? 0; return h; }
  atBottom() { return this.offset + (this.convBox?.height ?? 0) >= this.contentHeight() - 40; }

  /** The last row at least partly visible: the anchor that restores this viewport (row precision). */
  bottomRow() {
    const edge = this.offset + (this.convBox?.height ?? 0);
    let y = 28;
    for (const k of this.order) { y += this.rowH.get(k) ?? 0; if (y >= edge) return k; }
    return this.order[this.order.length - 1] ?? null;
  }

  toBottom(cx) {
    this.follow = true; this.unseen = 0;
    this.scroll.scroll_to_item(this.order.length - 1);
    cx?.notify();
  }

  submit(cx) {
    const text = this.input.value().trim();
    if (!text || this.view !== "main" || !this.term) return;
    this.toBottom(null);
    const data = this.data();
    const card = this.cardKind(data);
    this.input.set_value(""); this.keepDraft();
    if (card?.kind === "question") { this.answerText(cx, card, text); return; }
    if (card?.kind === "plan") {
      // "Tell Claude what to change": Claude rewrites the plan.
      const opt = this.dialog.find((o) => /change|feedback|keep planning/i.test(o.label));
      this.act(cx, async (cx, term) => { if (opt) { await cc.keys(term, opt.key); await cx.sleep(300); } await cc.send(term, text, true); });
      return;
    }
    if (this.report?.state === "blocked") { this.note = "Answer the card first"; cx.notify(); return; }
    this.act(cx, async (_cx, term) => { const r = await cc.send(term, text); if (r.code !== 0) this.note = r.stderr.trim() || "send failed"; });
  }

  interrupt(cx) { this.act(cx, async (_cx, term) => { await cc.keys(term, "escape"); }); }

  pick(cx, card, i) {
    const n = card.questions.length;
    this.act(cx, async (cx, term) => {
      await cc.keys(term, String(i + 1));
      await this.afterAnswer(cx, term, n);
    });
  }

  answerText(cx, card, text) {
    const q = card.questions[this.q.index] ?? card.questions[0];
    const n = card.questions.length, other = (q.options ?? []).length + 1;
    this.act(cx, async (cx, term) => {
      await cc.keys(term, String(other));
      await cx.sleep(300);
      await cc.send(term, text, true);
      await this.afterAnswer(cx, term, n);
    });
  }

  skip(cx, card) {
    this.act(cx, async (_cx, term) => { await cc.keys(term, "right"); });
    this.q.index = Math.min(card.questions.length - 1, this.q.index + 1);
  }

  async afterAnswer(cx, term, n) {
    this.q.index += 1;
    if (this.q.index < n) return;
    await cx.sleep(450);
    if (/Ready to submit your answers\?/.test(await cc.screen(term, 30))) await cc.keys(term, "1");
  }

  permission(cx, which) {
    const d = this.dialog;
    const yes = d.find((o) => /^yes\b/i.test(o.label));
    const always = d.find((o) => /^yes, and (always|don.t ask)/i.test(o.label)) ?? d.find((o) => /^yes, and/i.test(o.label) && !/auto mode|accept edits|bypass/i.test(o.label));
    const no = d.find((o) => /^no\b/i.test(o.label));
    this.act(cx, async (_cx, term) => {
      if (which === "once") await cc.keys(term, yes?.key ?? "1");
      else if (which === "always" && always) await cc.keys(term, always.key);
      else if (which === "deny") await cc.keys(term, no?.key ?? "escape");
    });
  }

  /** Approve: execute in the session's working mode (the one before Plan, auto by default), never bypass. PLAN.md is written first. */
  approve(cx, plan) {
    this.act(cx, async (cx, term) => {
      if (this.root) await cc.writePlan(this.root, plan);
      const d = this.dialog, work = this.workMode ?? "auto";
      const direct = d.find((o) => (work === "auto" ? /auto mode/i : /accept edits/i).test(o.label));
      const manual = d.find((o) => /manually approve/i.test(o.label));
      if (direct) { await cc.keys(term, direct.key); return; }
      if (!manual) { this.note = "Approve in the terminal: unexpected dialog"; return; }
      await cc.keys(term, manual.key);
      await cx.sleep(500);
      await this.leavePlan(term, cx);
    });
  }

  /** Back to the working mode; auto when unknown, accept edits if auto isn't in this session's cycle. */
  async leavePlan(term, cx) {
    const work = this.workMode ?? "auto";
    if (!(await cc.setMode(term, work, cx)) && work !== "acceptEdits") await cc.setMode(term, "acceptEdits", cx);
  }

  /**
   * Hand off: the plan goes to PLAN.md, the planning turn is closed (Esc), the same terminal
   * switches model with /model, leaves Plan (back to its working mode), and is told to implement PLAN.md. Doing it in this
   * order avoids queuing /model behind a running turn, where it would arrive as plain text.
   */
  handOff(cx, plan, model = cc.HANDOFF) {
    this.act(cx, async (cx, term) => {
      if (this.root) await cc.writePlan(this.root, plan);
      await cc.keys(term, "escape");
      await cc.waitLeave(term, "blocked", cx);
      await cc.waitLeave(term, "working", cx);
      await cc.setModel(term, model.id, cx);
      this.modelOverride = model.id;
      await this.leavePlan(term, cx);
      await cc.send(term, "The plan is approved. Implement it now, following PLAN.md at the repo root.");
    });
  }

  keepPlanning(cx) { this.menu = null; this.input.focus(); cx.notify(); }

  pickModel(cx, m) {
    this.menu = null;
    if (this.report?.state !== "idle" && this.report?.state !== "done") { this.note = "Switch the model when Claude is idle"; cx.notify(); return; }
    this.act(cx, async (cx, term) => { await cc.setModel(term, m.id, cx); this.modelOverride = m.id; });
  }

  pickEffort(cx, level) {
    if (this.report?.state !== "idle" && this.report?.state !== "done") { this.note = "Change the effort when Claude is idle"; cx.notify(); return; }
    this.effortOverride = level;
    this.act(cx, async (cx, term) => { await cc.setEffort(term, level, cx); });
  }

  pickFast(cx, on) {
    if (this.report?.state !== "idle" && this.report?.state !== "done") { this.note = "Toggle fast mode when Claude is idle"; cx.notify(); return; }
    this.fastOverride = on;
    this.act(cx, async (cx, term) => { await cc.setFast(term, on, cx); });
  }

  /** Plan on or off. Off returns to the mode the session worked in before (auto for most sessions). */
  togglePlan(cx, on) {
    if (this.report?.state === "blocked") { this.note = "Answer the card first"; cx.notify(); return; }
    this.mode = on ? "plan" : (this.workMode ?? "auto");
    this.act(cx, async (cx, term) => { if (on) await cc.setMode(term, "plan", cx); else await this.leavePlan(term, cx); });
  }

  /** Files dropped from Finder: copied into <worktree>/inputs/, cited as @inputs/<name>. */
  drop(cx, paths) {
    if (!paths?.length) return;
    cx.spawn(async (cx) => {
      const refs = [];
      for (const p of paths) {
        // Scratch is read-only on main: cite the file where it is instead of copying it in.
        if (!this.root || target()?.scratch) { refs.push(`@${p}`); continue; }
        const r = await exec("sh", ["-c", 'mkdir -p "$1/inputs" && n=$(basename "$2") && d="$1/inputs/$n" && i=1 && while [ -e "$d" ]; do d="$1/inputs/${n%.*}-$i.${n##*.}"; [ "${n%.*}" = "$n" ] && d="$1/inputs/$n-$i"; i=$((i+1)); done && cp -R "$2" "$d" && basename "$d"', "sh", this.root, p]);
        if (r.code === 0) refs.push(`@inputs/${r.stdout.trim()}`); else this.note = r.stderr.trim() || "copy failed";
      }
      const cur = this.input.value();
      this.input.set_value(`${cur}${cur && !cur.endsWith(" ") ? " " : ""}${refs.join(" ")} `);
      this.input.focus();
      cx.notify();
    });
  }

  /** Scratch → workspace: the New workspace dialog, prefilled; the session continues there. */
  promote(data, cx) {
    const t = target();
    const name = slug(data.title ?? data.firstPrompt ?? "scratch") || "scratch";
    openOverlay({
      mod: "pm-workspace-new", kind: "dialog", width: 560, height: 640,
      props: {
        project: this.main ? { main: this.main, name: base(this.main) } : undefined,
        name, task: data.firstPrompt ?? "", resume: this.sid, from: { tab: t?.tab.id, terminal: this.term },
      },
    });
    // Once the workspace runs `claude --resume <sid>`, this Scratch is done: close it so the next one starts empty.
    const sid = this.sid, term = this.term, tab = t?.tab.id;
    if (!cx || !sid || !tab) return;
    cx.spawn(async (cx) => {
      for (let i = 0; i < 90; i++) {
        await cx.sleep(2000);
        const moved = terminals().some((x) => x.address !== term && JSON.stringify(x.argv ?? x.foreground?.argv ?? []).includes(sid));
        if (moved) { run("tab.close", { id: tab, confirmed: true }); return; }
      }
    });
  }

  copy(text) { exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]).catch(() => null); notify({ title: "Copied", level: "success", timeout: 2000 }); }

  fork() {
    if (!this.sid || !this.cwd) return;
    run("tab.new", { name: "fork", folder: this.cwd, argv: ["claude", "--resume", this.sid, "--fork-session"] });
  }

  // ---- derived --------------------------------------------------------------------------

  data() {
    const file = this.view === "main" ? this.session : this.session && this.subFile(this.view);
    const feed = file ? this.feeds.get(file) : null;
    const d = feed ? buildRows(feed.recs, this.expanded, this.metas) : { rows: [], model: null, ctx: 0, pending: [], mode: null, title: null, firstPrompt: null };
    d.feed = feed;
    return d;
  }

  /** Which card the blocked terminal needs, from its report, the transcript and the dialog on screen. */
  cardKind(data) {
    if (this.view !== "main" || this.report?.state !== "blocked") return null;
    const p = data.pending;
    const auq = [...p].reverse().find((s) => s.name === "AskUserQuestion" && Array.isArray(s.q) && s.q.length);
    if (auq && this.report?.kind === "question") {
      if (this.q.id !== auq.id) this.q = { id: auq.id, index: this.qDone ?? 0, hi: 0 };
      else if (this.qDone != null && this.qDone > this.q.index) this.q.index = this.qDone;
      const opts = auq.q[Math.min(this.q.index, auq.q.length - 1)]?.options ?? [];
      if (this.q.hiFor !== this.q.index) { this.q.hiFor = this.q.index; this.q.hi = Math.max(0, opts.findIndex((o) => /recommended/i.test(o.label))); }
      return { kind: "question", id: auq.id, questions: auq.q };
    }
    const plan = [...p].reverse().find((s) => s.name === "ExitPlanMode");
    if (plan || /approve plan/i.test(this.report?.msg ?? "")) return { kind: "plan", plan: this.planText ?? plan?.plan ?? "", tool: plan };
    const tu = p[p.length - 1];
    return { kind: "permission", tool: tu, msg: this.report?.msg ?? "" };
  }

  // ---- rows -----------------------------------------------------------------------------

  bubbleWidth(text) {
    const max = Math.min(440, Math.max(240, Math.round((this.width ?? 800) * 0.72)));
    const longest = Math.max(...text.split("\n").map((l) => l.length));
    return Math.min(max, Math.ceil(longest * 6.9) + 30);
  }

  fileChip(file, f, id) {
    return h_flex().id(id).gap(6).py(3).pr(10).rounded(6).items_center().cursor_pointer().hover((s) => s.bg(C.raised))
      .tooltip("Open the diff")
      .on_click(() => openDiff(file, this.root))
      .child(div().font_family(MONO).text_size(11).text_color(C.text2).child(base(file)))
      .when(f.add > 0, (e) => e.child(div().font_family(MONO).text_size(11).text_color(C.greenText).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().font_family(MONO).text_size(11).text_color(C.red).child(`−${f.del}`)));
  }

  row(r, data) {
    switch (r.kind) {
      case "user":
        return h_flex().justify_end().child(
          div().w(this.bubbleWidth(r.text)).flex_none().bg(BUBBLE).rounded(12).rounded_br(4).px(14).py(10)
            .text_color(C.text).text_size(13).line_height("20px").child(r.text));
      case "assistant":
        return div().when(r.inner, (e) => e.pl(16).opacity(0.85)).text_size(13).line_height("20px").text_color(C.text)
          .child(TextView.markdown(`md-${r.key}`, r.text));
      case "fold": {
        const parts = [r.nTools ? `${r.nTools} tool call${r.nTools > 1 ? "s" : ""}` : null, r.nMsgs ? `${r.nMsgs} message${r.nMsgs > 1 ? "s" : ""}` : null].filter(Boolean).join(", ");
        return h_flex().gap(8).text_size(12).cursor_pointer()
          .child(div().w(8).text_color(C.dim).child(r.open ? "⌄" : "›"))
          .child(div().text_color(C.muted).child(`${parts}${r.done && !r.nFiles && target()?.scratch ? " · read only" : ""}`));
      }
      case "step":
        return h_flex().pl(16).text_size(12).font_family(MONO).text_color(r.err ? C.red : C.dim).child(div().truncate().child(r.text));
      case "agent": {
        const m = this.metas.find((x) => x.toolUseId === r.id);
        return h_flex().gap(8).items_center().text_size(12).cursor_pointer()
          .child(div().text_color(r.done ? C.greenText : C.yellow).child(r.done ? "✓" : "●"))
          .child(div().text_color(C.text2).truncate().child(r.desc ?? "Sub-agent"))
          .child(div().text_color(C.dim).child([r.sub, r.model].filter(Boolean).join(" · ")))
          .when(Boolean(m), (e) => e.child(div().text_color(C.link).child("open ›")));
      }
      case "files": {
        const shown = r.files.slice(0, 4);
        return h_flex().gap(6).flex_wrap()
          .children(shown.map(([file, f], i) => this.fileChip(file, f, `chip-${r.key}-${i}`)))
          .when(r.files.length > 4, (e) => e.child(div().id(`more-${r.key}`).py(3).text_size(11).text_color(C.link).cursor_pointer()
            .on_click(() => openDiff(null, this.root)).child(`${r.files.length} files changed`)));
      }
      case "meta":
        return h_flex().gap(4).text_size(11).text_color(C.dim)
          .child(r.text)
          .when(Boolean(r.copy), (e) => e
            .child("·").child(div().id(`copy-${r.key}`).cursor_pointer().hover((s) => s.text_color(C.text2)).on_click(() => this.copy(r.copy)).child("copy"))
            .child("·").child(div().id(`fork-${r.key}`).cursor_pointer().hover((s) => s.text_color(C.text2)).on_click(() => this.fork()).child("fork")));
      case "wants":
        return target()?.scratch ? this.wantsRow(r.file, data) : div();
      default:
        return div();
    }
  }

  wantsRow(file, data) {
    return h_flex().gap(16).pt(14).border_t(1).border_color(C.line1).items_center()
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(5).text_size(13).text_color(C.text)
          .child("Claude wants to edit")
          .child(div().font_family(MONO).text_size(12).text_color(C.link).truncate().child(file ? (this.main && file.startsWith(`${this.main}/`) ? file.slice(this.main.length + 1) : base(file)) : "files")))
        .child(div().text_size(11).text_color(C.dim).child("Scratch is read-only. Promote it to a workspace to keep going, same conversation.")))
      .child(div().id("promote").flex_none().h(28).px(12).flex().items_center().rounded(7).bg(C.ember).cursor_pointer()
        .text_size(12).font_semibold().text_color(C.bg).on_click((_e, cx) => this.promote(data, cx)).child("Promote to workspace"));
  }

  clickRow(key, cx) {
    if (key.startsWith("agent:")) {
      const m = this.metas.find((x) => x.toolUseId === key.slice(6));
      if (m) this.openSub(m.agentId, cx);
    } else if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    cx.notify();
  }

  openSub(id, cx) { this.view = id; this.lastCount = 0; this.window = WINDOW; this.refresh(cx); cx.notify(); }

  // ---- chrome ---------------------------------------------------------------------------

  band() {
    const tab = (id, label, kind, dur, active) => h_flex().id(`band-${id}`).gap(6).items_center().px(10).h(26).rounded(6).cursor_pointer()
      .when(active, (e) => e.bg(BUBBLE)).hover((s) => s.bg(C.raised))
      .on_click((_e, cx) => this.openSub(id, cx))
      .when(kind === "run", (e) => e.child(div().size(6).rounded(3).bg(C.yellow).loop("opacity", { from: 0.35, to: 1, period: 1600 })))
      .child(div().max_w(200).truncate().text_size(12).text_color(active ? C.text : C.muted).when(active, (e) => e.font_medium()).child(label))
      .when(kind === "done", (e) => e.child(icon("check", 11, C.greenText)))
      .when(Boolean(dur), (e) => e.child(div().font_family(MONO).text_size(11).text_color(C.dim).child(dur)));
    const now = Date.now();
    return h_flex().id("band").flex_none().h(38).px(12).gap(4).items_center().border_b(1).border_color(C.line2).overflow_x_scroll()
      .child(tab("main", "Main", null, null, this.view === "main"))
      .children(this.metas.map((m) => tab(m.agentId, m.description ?? m.agentType ?? m.agentId, m.finished ? "done" : "run",
        m.born ? ago((m.finished ? m.mod : now) - m.born) : null, this.view === m.agentId)));
  }

  frame(border) {
    return v_flex().id("card").flex_none().bg(CARD).rounded(12).border_1().border_color(border).overflow_hidden();
  }

  questionCard(card) {
    const qs = card.questions, n = qs.length;
    const idx = Math.min(this.q.index, n - 1), q = qs[idx];
    const opts = q.options ?? [];
    const rec = opts.findIndex((o) => /recommended/i.test(o.label));
    const hi = Math.min(this.q.hi, Math.max(0, opts.length - 1));
    return this.frame("#E06A4F66").track_focus(this.cardFocus)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (/^[1-9]$/.test(k) && Number(k) <= opts.length) { this.pick(cx, card, Number(k) - 1); cx.stop_propagation(); }
        else if (k === "enter") { this.pick(cx, card, hi); cx.stop_propagation(); }
        else if (k === "tab") { this.skip(cx, card); cx.stop_propagation(); }
        else if (k === "down" || k === "up") { this.q.hi = (hi + (k === "down" ? 1 : opts.length - 1)) % Math.max(1, opts.length); cx.notify(); cx.stop_propagation(); }
      })
      .child(h_flex().gap(16).px(18).pt(18).pb(14).items_start()
        .child(div().flex_1().min_w(0).text_size(14).font_semibold().line_height("20px").text_color(C.text).child(q.question ?? ""))
        .when(n > 1, (e) => e.child(h_flex().flex_none().gap(8).pt(3).items_center()
          .child(h_flex().gap(4).children(qs.map((_x, i) => div().w(14).h(3).rounded(2).bg(i <= idx ? C.ember : C.line3))))
          .child(div().font_family(MONO).text_size(11).text_color(C.muted).child(`${idx + 1} / ${n}`)))))
      .child(v_flex().px(12).pb(12).gap(0)
        .children(opts.map((o, i) => {
          const on = i === hi;
          const label = o.label.replace(/\s*\(recommended\)\s*/i, "");
          return h_flex().id(`opt-${i}`).gap(12).px(12).py(8).items_center().rounded(8).cursor_pointer()
            .when(i > 0 && !on && i - 1 !== hi, (e) => e.border_t(1).border_color(C.line1))
            .when(on, (e) => e.bg(C.raised)).hover((s) => s.bg(C.raised))
            .on_click((_e, cx) => this.pick(cx, card, i))
            .child(div().size(20).flex_none().flex().items_center().justify_center().rounded(5).bg(on ? C.ember : C.line2)
              .child(div().font_family(MONO).text_size(11).font_semibold().text_color(on ? C.bg : C.text2).child(String(i + 1))))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(h_flex().gap(4).text_size(13).font_medium().line_height("18px").text_color(C.text).child(label)
                .when(i === rec, (e) => e.child(div().font_weight(400).text_color(C.ember).child("· recommended"))))
              .when(Boolean(o.description) && o.description !== o.label, (e) => e.child(div().text_size(12).text_color(C.muted).child(o.description))));
        }))
        .child(h_flex().id("opt-free").px(14).py(8).border_t(1).border_color(C.line1).cursor_pointer()
          .on_click((_e, cx) => { this.input.focus(); cx.notify(); })
          .child(div().flex_1().text_size(13).text_color(C.dim).child("Or write your answer below…"))))
      .child(h_flex().gap(14).px(18).pt(8).pb(12).text_size(11).text_color(C.dim)
        .child("1-9 choose").child("↵ send").when(n > 1, (e) => e.child("⇥ skip")));
  }

  permissionCard(card) {
    const m = /^approve ([^:]+):\s*([\s\S]*)$/i.exec(card.msg);
    const tool = m?.[1] ?? card.tool?.name ?? "a tool";
    const detail = m?.[2] ?? (card.tool ? toolLabel(card.tool) : "");
    const always = this.dialog.find((o) => /^yes, and/i.test(o.label) && !/auto mode|accept edits|bypass/i.test(o.label));
    const btn = (id, label, kbd, primary, onClick) => h_flex().id(id).h(30).px(12).gap(8).items_center().rounded(7).cursor_pointer()
      .when(primary, (e) => e.bg(C.ember)).when(!primary, (e) => e.border_1().border_color(C.line3).hover((s) => s.bg(C.raised)))
      .on_click(onClick)
      .child(div().text_size(12).font_semibold().text_color(primary ? C.bg : C.text).child(label))
      .when(Boolean(kbd), (e) => e.child(div().text_size(11).text_color(primary ? "#17140F99" : C.dim).child(kbd)));
    return this.frame("#E06A4F66").track_focus(this.cardFocus)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && !e.modifiers?.platform) { this.permission(cx, "once"); cx.stop_propagation(); }
        else if (e.key === "enter") { this.permission(cx, "always"); cx.stop_propagation(); }
        else if (e.key === "backspace") { this.permission(cx, "deny"); cx.stop_propagation(); }
      })
      .child(v_flex().px(18).pt(16).pb(12).gap(8)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(10).text_color(C.muted).child("PERMISSION"))
          .child(div().text_size(14).font_semibold().text_color(C.text).child(`Claude wants to use ${tool}`)))
        .when(Boolean(detail), (e) => e.child(div().px(10).py(8).rounded(6).bg(C.bg).font_family(MONO).text_size(12).text_color(C.text2).child(detail))))
      .child(h_flex().gap(8).px(18).py(10).border_t(1).border_color(C.line1).items_center()
        .child(div().flex_1())
        .child(btn("perm-deny", "Deny", "⌫", false, (_e, cx) => this.permission(cx, "deny")))
        .when(Boolean(always), (e) => e.child(btn("perm-always", "Always", "⌘↵", false, (_e, cx) => this.permission(cx, "always")).tooltip(always?.label ?? "")))
        .child(btn("perm-once", "Allow once", "↵", true, (_e, cx) => this.permission(cx, "once"))));
  }

  planCard(card, data) {
    const plan = card.plan || "";
    const lines = plan.split("\n");
    const titleLine = lines.find((l) => /^#\s+/.test(l));
    const title = titleLine ? titleLine.replace(/^#\s+(Plan:\s*)?/i, "") : "Plan";
    const body = titleLine ? lines.filter((l) => l !== titleLine).join("\n").trim() : plan;
    const open = this.menu === "approve";
    const item = (id, label, sub, onClick) => v_flex().id(id).px(10).py(7).rounded(6).cursor_pointer().hover((s) => s.bg(C.raised)).on_click(onClick)
      .child(div().text_size(12).text_color(C.text).child(label))
      .when(Boolean(sub), (e) => e.child(div().text_size(11).text_color(C.dim).child(sub)));
    const menu = v_flex().w(240).p(4).bg(C.surface).rounded(8).border_1().border_color(C.line3)
      .child(item("handoff", `Hand off to ${cc.HANDOFF.label}`, "Approve, switch this session's model, leave Plan", (_e, cx) => this.handOff(cx, plan)))
      .child(item("keep", "Keep planning", "Type the change you want below", (_e, cx) => this.keepPlanning(cx)));
    return this.frame(C.line3)
      .child(h_flex().gap(10).px(18).pt(14).pb(6).items_center()
        .child(h_flex().flex_1().min_w(0).gap(10).items_center()
          .child(div().text_size(10).text_color(C.muted).child("PLAN"))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(C.text).child(title)))
        .child(div().text_size(11).text_color(C.muted).child([cc.prettyModel(this.modelOverride ?? data.model), "PLAN.md"].filter(Boolean).join(" · "))))
      .child(div().id("plan-body").max_h(300).overflow_y_scroll().px(18).pt(6).pb(14).text_size(13).line_height("19px").text_color(C.text2)
        .child(TextView.markdown("plan-md", body || "(empty plan)")))
      .child(h_flex().gap(10).pl(18).pr(12).py(10).border_t(1).border_color(C.line1).items_center()
        .child(div().id("plan-open").flex_1().text_size(12).text_color(C.link).cursor_pointer()
          .on_click((_e, cx) => this.act(cx, async () => {
            if (!this.root) return;
            await cc.writePlan(this.root, plan);
            run("tab.new", { name: "PLAN.md", mod: "pm-md", props: { path: "PLAN.md", root: this.root } });
          }))
          .child("Comment on it in PLAN.md"))
        .child(h_flex().h(30).rounded(7).bg(C.ember).items_center()
          .child(h_flex().id("approve").h_full().pl(12).pr(10).gap(8).items_center().cursor_pointer()
            .on_click((_e, cx) => this.approve(cx, plan))
            .child(div().text_size(12).font_semibold().text_color(C.bg).child(this.acting ? "Working…" : "Approve"))
            .child(div().text_size(11).text_color("#17140F99").child("⌘⇧↵")))
          .child(div().w(1).h(16).bg("#17140F40"))
          .child(Popover.new("approve-menu").open(open)
            .on_open_change((o, cx) => { this.menu = o ? "approve" : null; cx.notify(); })
            .trigger(div().id("approve-more").h(30).px(8).flex().items_center().cursor_pointer().child(icon("chevron-down", 12, C.bg)))
            .content(menu))));
  }

  scratchCard(card, data) {
    // An edit names its file; a plan names files in its text (the first path-looking word).
    const file = card.tool?.file ?? (/(?:^|[\s`(])((?:[\w.-]+\/)*[\w-]+\.[a-zA-Z]{1,8})(?=[\s`),.:;]|$)/m.exec(card.plan ?? "")?.[1] ?? null);
    return v_flex().gap(8)
      .child(this.wantsRow(file, data))
      .child(h_flex().gap(12).text_size(11).text_color(C.dim)
        .child(div().id("scratch-deny").cursor_pointer().text_color(C.muted).hover((s) => s.text_color(C.text))
          .on_click((_e, cx) => (card.kind === "plan" ? this.act(cx, async (_c, t) => { await cc.keys(t, "escape"); }) : this.permission(cx, "deny")))
          .child("Stay read-only")));
  }

  running(data) {
    const tu = data.pending[data.pending.length - 1];
    const text = tu ? `${toolLabel(tu)}…` : "Thinking…";
    const since = tu?.ts ? Date.parse(tu.ts) : null;
    return h_flex().gap(10).items_center()
      .child(div().size(8).flex_none().rounded(4).bg(C.yellow).loop("opacity", { from: 0.35, to: 1, period: 1600 }))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(C.text2).child(text))
      .when(Boolean(since), (e) => e.child(div().flex_none().text_size(12).text_color(C.dim).child(ago(Date.now() - since))));
  }

  composer(data, card) {
    const t = target();
    const sub = this.view !== "main";
    const scratch = Boolean(t?.scratch);
    const working = this.report?.state === "working";
    const has = this.input.value().trim().length > 0;
    const model = this.modelOverride ?? data.model;
    const effort = this.effortOverride ?? data.effort;
    const fast = this.fastOverride ?? data.fast;
    const pct = Math.min(100, Math.round((data.ctx / CONTEXT) * 100));
    const ring = `pm-shared/icons/ring-p${String(Math.round(pct / 5) * 5).padStart(3, "0")}.svg`;
    const placeholder = sub ? "Sub-agents don't take messages: reply to Main"
      : card?.kind === "question" ? "Type your answer…"
        : card?.kind === "plan" ? "Ask for a change to the plan…" : "Reply to Claude…";
    const caps = (t) => div().px(10).pt(8).pb(4).text_size(10).font_medium().text_color(C.dim).child(t);
    const modelMenu = v_flex().w(250).p(4).bg(C.surface).rounded(8).border_1().border_color(C.line3)
      .child(caps("MODEL"))
      .children(cc.MODELS.map((m) => h_flex().id(`model-${m.id}`).px(10).py(6).gap(8).rounded(6).items_center().cursor_pointer().hover((s) => s.bg(C.raised))
        .on_click((_e, cx) => this.pickModel(cx, m))
        .child(div().flex_1().text_size(12).text_color(C.text).child(m.label))
        .when(m.id === model, (e) => e.child(icon("check", 12, C.ember)))))
      .child(div().h(1).mx(6).my(4).bg(C.line2))
      .child(caps("EFFORT"))
      .child(h_flex().mx(6).mb(6).p(2).gap(2).rounded(6).bg(C.bg)
        .children(cc.EFFORTS.map((lv) => div().id(`effort-${lv}`).flex_1().py(3).rounded(4).flex().justify_center().cursor_pointer()
          .when(lv === effort, (e) => e.bg(C.line2)).on_click((_e, cx) => { this.menu = null; this.pickEffort(cx, lv); })
          .child(div().text_size(11).text_color(lv === effort ? C.text : C.dim).when(lv === effort, (e) => e.font_medium()).child(lv)))))
      .child(div().h(1).mx(6).my(4).bg(C.line2))
      .child(h_flex().id("fast-toggle").px(10).py(6).gap(8).rounded(6).items_center().cursor_pointer().hover((s) => s.bg(C.raised))
        .on_click((_e, cx) => { this.menu = null; this.pickFast(cx, !fast); })
        .child(icon("zap", 12, fast ? C.ember : C.muted))
        .child(div().flex_1().text_size(12).text_color(C.text).child("Fast mode"))
        .child(div().text_size(11).text_color(fast ? C.ember : C.dim).child(fast ? "On" : "Off")));
    return v_flex().id("composer").flex_none().bg(CARD).rounded(12).border_1().border_color(C.line3).px(14).py(12).gap(10)
      .when(sub, (e) => e.opacity(0.6))
      .on_key_down((e, cx) => { if (e.key === "escape" && working) { this.interrupt(cx); cx.stop_propagation(); } })
      .child(sub ? div().h(20).text_size(13).text_color(C.dim).child(placeholder)
        : div().w_full().on_key_down((e, cx) => {
          const m = e.modifiers;
          if (e.key === "enter" && !m.shift && !m.alt && !m.control && !m.platform) { cx.stop_propagation(); this.submit(cx); }
        }).child(Textarea.new(this.input).w_full().text_size(13).line_height("20px").text_color(C.text).bg(CARD).border_0().p_0()))
      .child(h_flex().gap(8).items_center()
        .child(Popover.new("model-menu").open(this.menu === "model")
          .on_open_change((o, cx) => { this.menu = o ? "model" : null; cx.notify(); })
          .trigger(h_flex().id("model-chip").gap(5).px(8).py(3).rounded(5).bg(C.raised).items_center().cursor_pointer()
            .when(Boolean(fast), (e) => e.child(icon("zap", 11, C.ember)))
            .child(div().text_size(11).font_medium().text_color(C.text).child(cc.prettyModel(model) || "Model"))
            .when(Boolean(effort), (e) => e.child(div().text_size(11).text_color(C.muted).child(effort)))
            .child(icon("chevron-down", 10, C.muted)))
          .content(modelMenu))
        .when(scratch, (e) => e.child(h_flex().gap(5).px(8).py(3).items_center()
          .child(icon("lock", 11, C.muted)).child(div().text_size(11).text_color(C.muted).child("Plan · read-only"))))
        .when(!scratch, (e) => {
          const on = (this.mode ?? data.mode) === "plan";
          return e.child(h_flex().id("mode-plan").gap(5).px(8).py(3).rounded(5).items_center().cursor_pointer()
            .bg(on ? C.line2 : "#00000000").border_1().border_color(on ? C.line3 : C.line2).hover((s) => s.border_color(C.line3))
            .tooltip(on ? "Plan mode: Claude proposes, changes nothing. Click to let it work" : "Click to plan first: Claude proposes, changes nothing")
            .on_click((_e, cx) => this.togglePlan(cx, !on))
            .child(div().size(6).rounded(3).bg(on ? C.ember : C.line3))
            .child(div().text_size(11).text_color(on ? C.text : C.dim).when(on, (x) => x.font_medium()).child("Plan")));
        })
        .child(h_flex().gap(6).px(8).py(3).items_center().tooltip(`${short(data.ctx)} tokens`)
          .child(svg(ring).size(14).flex_none().text_color(pct > 90 ? C.red : pct > 70 ? C.yellow : C.text2))
          .child(div().font_family(MONO).text_size(11).text_color(C.muted).child(`context ${pct}%`)))
        .child(div().flex_1())
        .when(Boolean(this.note), (e) => e.child(div().max_w(220).truncate().text_size(11).text_color(C.red).child(this.note ?? "")))
        .when(working && !this.note, (e) => e.child(div().id("esc").text_size(11).text_color(C.dim).cursor_pointer().hover((s) => s.text_color(C.text2))
          .on_click((_e, cx) => this.interrupt(cx)).child("esc to interrupt")))
        .child(div().id("send").size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
          .bg(has && !sub ? C.ember : C.line3).tooltip("Send")
          .on_click((_e, cx) => this.submit(cx))
          .child(icon("arrow-up", 13, has && !sub ? C.bg : C.text))));
  }

  // ---- header role ----------------------------------------------------------------------

  /** Keeps main-stack and pane-head in step with the active tab. Idempotent, at most once per change. */
  sync(t) {
    const L = layout();
    const want = {
      "main-stack": t?.pane && viewOf(t.tab.id) !== "terminal" ? "summary" : "main",
      "pane-head": t?.any ? HEAD : 0,
    };
    const st = find(L, "main-stack"), hd = find(L, "pane-head");
    if (!st || !hd) return;
    if (st.active !== want["main-stack"] && this.issued.stack !== `${want["main-stack"]}`) {
      this.issued.stack = want["main-stack"];
      run("layout.select", { stack: "main-stack", child: want["main-stack"] });
    } else if (st.active === want["main-stack"]) this.issued.stack = null;
    const px = hd.size?.px;
    if (px !== want["pane-head"] && this.issued.head !== want["pane-head"]) {
      this.issued.head = want["pane-head"];
      run("layout.resize", { id: "pane-head", px: want["pane-head"] });
    } else if (px === want["pane-head"]) this.issued.head = null;
  }

  loadNames(cwd, cx) {
    if (!cwd || this.namesFor === cwd) return;
    this.namesFor = cwd;
    cx.spawn(async (cx) => {
      const top = await cc.toplevel(cwd), main = await cc.mainCheckout(cwd);
      this.nameInfo = { cwd, top, main };
      cx.notify();
    });
  }

  renderHeader(cx) {
    const t = target();
    this.sync(t);
    if (!t?.any) return div().size_full().bg(C.surface);
    const cwd = t.pane?.cwd ?? t.any?.cwd ?? null;
    this.loadNames(cwd, cx);
    const n = this.nameInfo?.cwd === cwd ? this.nameInfo : {};
    const project = n.main ? base(n.main) : null;
    const ws = n.top ? base(n.top) : null;
    const h = home();
    const folder = cwd === h ? "~" : cwd?.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd ?? "";
    const a = t.term ? agents().find((x) => x.address === t.term) : null;
    const tab = t.tab;
    const status = a?.status ?? null;
    const view = t.pane ? viewOf(tab.id) : "terminal";
    const seg = (id, label, on, v) => div().id(id).px(9).py(3).rounded(5).cursor_pointer()
      .when(on, (e) => e.bg(BUBBLE)).hover((s) => s.bg(on ? BUBBLE : C.raised))
      .on_click((_e, cx) => {
        setView(tab.id, v);
        if (v === "terminal" && t.pane) run("pane.focus", { pane: t.pane.pane });
        cx.notify();
      })
      .child(div().text_size(11).line_height("14px").text_color(on ? C.text : C.muted).when(on, (e) => e.font_medium()).child(label));
    const word = status === "working" ? `working${tab.working_since ? ` · ${ago(Date.now() - tab.working_since)}` : ""}`
      : status === "blocked" ? "waiting" : null;
    const title = t.pane ? (t.scratch ? "Scratch" : "Claude Code") : (t.any?.program?.name ?? "Terminal");
    const where = t.pane
      ? (t.scratch ? [project ?? folder, "main", "read-only"].join(" · ") : project && ws && project !== ws ? `${project} / ${ws}` : project ?? folder)
      : folder;
    return h_flex().id("pane-head").size_full().pl(14).pr(10).gap(10).items_center().bg(C.surface)
      .border_b(1).border_color(status === "blocked" ? C.ember : C.line2)
      .on_click(() => { if (view === "terminal" && t.any) run("pane.focus", { pane: t.any.pane }); })
      .child(div().flex_none().text_size(12).font_medium().text_color(C.text).child(title))
      .child(div().text_size(12).text_color(C.dim).child("·"))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12).text_color(C.muted).child(where))
      .when(Boolean(word), (e) => e.child(h_flex().flex_none().gap(6).items_center()
        .child(status === "blocked" ? icon("circle-half", 10, C.ember)
          : div().size(6).rounded(3).bg(C.yellow).loop("opacity", { from: 0.35, to: 1, period: 1600 }))
        .child(div().text_size(12).text_color(status === "blocked" ? C.ember : C.yellow).child(word ?? ""))))
      .when(Boolean(t.pane), (e) => e.child(h_flex().flex_none().p(3).gap(2).rounded(7).bg(C.bg)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(seg("view-summary", "Summary", view !== "terminal", "summary"))
        .child(seg("view-terminal", "Terminal", view === "terminal", "terminal"))));
  }

  // ---- render ---------------------------------------------------------------------------

  render(cx) {
    if (this.role === "header") return this.renderHeader(cx);
    const vis = this.visible();
    const t = target();
    if (vis && (t?.term ?? null) !== this.term) this.refresh(cx);
    const focusInput = vis && !this.shown;
    this.shown = vis;

    const data = this.data();
    const card = this.cardKind(data);
    if (this.view !== "main") {
      const m = this.metas.find((x) => x.agentId === this.view);
      const prompt = data.rows.find((r) => r.kind === "user");
      if (prompt) data.rows.splice(data.rows.indexOf(prompt), 1);
      data.rows.unshift({ kind: "task", key: "task", text: prompt?.text ?? m?.description ?? "", model: m?.model });
    }
    const rows = data.rows;
    const hidden = Math.max(0, rows.length - this.window), shown = rows.slice(hidden);
    const total = shown.length + (hidden > 0 ? 1 : 0);
    this.order = [...(hidden > 0 ? ["earlier"] : []), ...shown.map((r) => r.key)];
    if (this.restoreKey && rows.length) {
      // Back on a conversation read mid-way: from the top, revealing the old bottom row puts it back at the bottom edge.
      const i = this.order.indexOf(this.restoreKey);
      this.restoreKey = null; this.lastCount = rows.length;
      if (i >= 0) {
        this.scroll.scroll_to_item(0);
        cx.spawn(async (cx) => { await cx.sleep(32); this.scroll.scroll_to_item(i); cx.notify(); });
      } else this.toBottom(null);
    } else if (rows.length !== this.lastCount) {
      const added = rows.length - this.lastCount;
      this.lastCount = rows.length;
      if (this.follow) this.scroll.scroll_to_item(total - 1);
      else if (added > 0) this.unseen += added;
    }
    const working = this.report?.state === "working";
    const scratch = Boolean(t?.scratch);
    let cardEl = null;
    if (card) {
      if (scratch && (card.kind === "plan" || (card.kind === "permission" && EDIT_TOOLS.has(card.tool?.name)))) cardEl = this.scratchCard(card, data);
      else if (card.kind === "question") cardEl = this.questionCard(card);
      else if (card.kind === "plan") cardEl = this.planCard(card, data);
      else cardEl = this.permissionCard(card);
    }
    // Focus moves only from a task, never during render.
    const want = !vis ? null : card && card.kind !== "plan" && !this.input.value() ? `card:${card.id ?? card.kind}` : focusInput ? "input" : this.focusOn;
    if (want && want !== this.focusOn) {
      this.focusOn = want;
      cx.spawn(async () => { if (want === "input") this.input.focus(); else this.cardFocus.focus(); });
    }
    if (vis && !card && this.focusOn?.startsWith("card:")) { this.focusOn = "input"; cx.spawn(async () => this.input.focus()); }
    if (!vis) this.focusOn = null;
    const feed = data.feed;
    const column = (el) => h_flex().w_full().justify_center().child(v_flex().w_full().px(24).child(el));

    if (this.unavailable || feed?.broken()) {
      return v_flex().id("root").size_full().bg(C.surface).items_center().justify_center().gap(8).font_family(SANS)
        .child(div().text_size(13).text_color(C.text2).child("Summary unavailable"))
        .child(div().text_size(12).text_color(C.dim).child(Object.keys(feed?.unknown ?? {}).length ? `Unknown records: ${Object.keys(feed.unknown).join(", ")}` : "The transcript format changed."))
        .child(div().id("open-terminal").mt(4).h(28).px(12).flex().items_center().rounded(7).border_1().border_color(C.line3).cursor_pointer()
          .text_size(12).text_color(C.text).on_click(() => { if (t?.tab) setView(t.tab.id, "terminal"); }).child("Open Terminal"));
    }

    const rowEl = (r) => {
      if (r.kind === "task") return v_flex().gap(4).pl(14).border_l(2).border_color(C.line3)
        .child(div().text_size(11).text_color(C.dim).child(`Task handed off by Claude${r.model ? ` · ${cc.prettyModel(r.model) || r.model}` : ""}`))
        .child(div().text_size(13).line_height("20px").text_color(C.text).child(r.text));
      return this.row(r, data);
    };
    return v_flex().id("root").size_full().bg(C.surface).font_family(SANS).text_color(C.text)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 4) { this.width = size.width; cx.notify(); } })
      .on_drop((e, cx) => this.drop(cx, e.paths))
      .when(this.metas.length > 0, (e) => e.child(this.band()))
      .child(v_flex().relative().flex_1().min_h(0)
        .when(rows.length > 0, (e) => e
          .child(v_flex().id("conv").absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll).pt(28).pb(12)
            .on_size_change((size) => { this.convBox = { top: this.convBox?.top ?? 0, height: size.height }; })
            .on_mouse_move((e) => { this.convBox = { top: e.bounds.y, height: e.bounds.height }; })
            .on_scroll_wheel((e, cx) => {
              // Wheel up leaves follow mode at once; reaching the bottom again turns it back on.
              if (e.delta.y > 0.5 && this.follow) { this.follow = false; cx.notify(); }
              else if (e.delta.y < -0.5 && !this.follow) {
                this.offset = Math.max(0, this.offset - e.delta.y);
                if (this.atBottom()) { this.follow = true; this.unseen = 0; cx.notify(); }
              }
            })
            .when(hidden > 0, (e) => e.child(column(div().id("earlier").pb(10).text_size(12).text_color(C.link).cursor_pointer()
              .on_click((_e, cx) => { this.window += WINDOW; cx.notify(); }).child(`Show earlier (${hidden} more)`))
              .on_size_change((size) => { this.rowH.set("earlier", size.height); })))
            .children(shown.map((r) => column(rowEl(r)).id(`row-${r.key}`).pb(r.kind === "fold" || r.kind === "files" ? 8 : 14)
              .on_size_change((size) => { this.rowH.set(r.key, size.height); })
              .on_mouse_move((e) => this.track(r.key, e))
              .on_scroll_wheel((e) => this.track(r.key, e))
              .when(r.kind === "fold" || r.kind === "agent", (el) => el.on_click((_e, cx) => this.clickRow(r.key, cx))))))
          .child(Scrollbar.vertical("conv").absolute().inset_0())
          .when(!this.follow && this.unseen > 0, (e) => e.child(h_flex().absolute().bottom(12).left(0).right(0).justify_center()
            .child(h_flex().id("to-bottom").h(26).px(12).gap(6).items_center().rounded(13).bg(C.raised).border_1().border_color(C.line3)
              .cursor_pointer().hover((s) => s.border_color(C.muted)).on_click((_e, cx) => this.toBottom(cx))
              .child(div().text_size(12).text_color(C.text).child("New messages"))
              .child(icon("arrow-down", 12, C.muted))))))
        .when(rows.length === 0, (e) => e.child(column(v_flex().pt(28).gap(10)
          .children(this.session && !feed?.loaded
            ? [0.72, 0.9, 0.55].map((w, i) => div().id(`sk-${i}`).h(12).w(`${Math.round(w * 100)}%`).rounded(4).bg(C.raised).loop("opacity", { from: 0.4, to: 0.8, period: 1400 }))
            : [div().text_size(13).text_color(C.dim).child(this.err ?? feed?.error ?? (t?.term ? "No conversation yet. Write below." : "No Claude in this tab"))])))))
      .when(working && this.view === "main", (e) => e.child(column(this.running(data)).pb(10)))
      .when(Boolean(cardEl), (e) => e.child(column(cardEl).pb(10)))
      .child(column(this.composer(data, card)).pb(18));
  }
}
