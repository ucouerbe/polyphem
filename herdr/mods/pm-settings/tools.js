// @ts-check
// Settings > Skills (screen 13) and MCP (13b), through skillshare (brew). Rule: every write is
// previewed with --dry-run and only runs behind an explicit Apply. Read-only fallbacks:
// ~/.claude/skills, <repo>/.claude/skills, `claude mcp list`.
import { InputState, Input } from "gpui-base";
import { home, notify } from "herdr";
import { C, SIZE, MONO, icon, h_flex, v_flex, div, sh, tilde, parse, frontmatter, readTextFile, Btn, Caps, Field, SearchBox } from "./lib.js";

const redact = (s) => String(s ?? "").replace(/((?:token|key|secret|password|auth)[\w-]*[=\s:]+)\S+/gi, "$1•••");

/** Back up the three Claude files before any real write. */
export async function backup() {
  const d = `${home()}/claude-backup-${new Date().toISOString().slice(0, 10)}`;
  const r = await sh("sh", ["-c", `mkdir -p "${d}" && for f in "$HOME/.claude.json" "$HOME/.claude/CLAUDE.md" "$HOME/.claude/settings.json"; do [ -f "$f" ] && cp -p -n "$f" "${d}/" ; done; true`]);
  return r.code === 0;
}

/** Usage over 30 days from Claude Code transcripts: { skills: {name: n}, mcp: {server: {calls, tools:Set}} }. */
export async function loadUsage() {
  const script = `cd "$HOME/.claude" 2>/dev/null || exit 0
find projects -name '*.jsonl' -mtime -30 -print0 | xargs -0 grep -hoE '"name":"(Skill","input":\\{"skill":"[^"]+|mcp__[A-Za-z0-9_.-]+)' 2>/dev/null | sort | uniq -c`;
  const r = await sh("sh", ["-c", script], { timeout: 90000 });
  const skills = {}, mcp = {};
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+"name":"(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2].startsWith("Skill")) { const name = m[2].split('"skill":"')[1]; skills[name] = (skills[name] ?? 0) + n; }
    else {
      const t = /^mcp__(.+?)__(.+)$/.exec(m[2]);
      if (!t) continue;
      const e = (mcp[t[1]] ??= { calls: 0, tools: new Set() });
      e.calls += n; e.tools.add(t[2]);
    }
  }
  return { skills, mcp };
}

/** `claude mcp list` -> [{ name, target, state, statusText }]. Read-only. */
export async function loadMcpList() {
  const r = await sh("claude", ["mcp", "list"], { timeout: 90000 });
  const servers = [];
  for (const line of r.raw.split("\n")) {
    const i = line.lastIndexOf(" - ");
    const c = line.indexOf(": ");
    if (i < 0 || c < 0 || c > i) continue;
    const name = line.slice(0, c).trim(), target = line.slice(c + 2, i).trim(), st = line.slice(i + 3).trim();
    const state = st.startsWith("✔") ? "connected" : st.startsWith("!") ? "auth" : "error";
    servers.push({ name, target, state, statusText: st.replace(/^[✔!✗]\s*/, "") });
  }
  return servers;
}

async function managedMcp() {
  const r = await sh("skillshare", ["mcp", "list"]);
  const names = new Set();
  for (const l of r.out.split("\n")) { const m = /^\s{2}(\S+)\s+(?:add|ok|sync|=|\S+)\s/.exec(l); if (m && !/^MCP/.test(l)) names.add(m[1]); }
  return names;
}

export async function loadSkills(root) {
  const out = [];
  const scan = async (dir, group) => {
    const f = await sh("find", ["-L", dir, "-maxdepth", "2", "-name", "SKILL.md"]);
    for (const p of f.out.split("\n").filter(Boolean)) {
      const text = await readTextFile(p).catch(() => null);
      const fm = frontmatter(text);
      const folder = p.split("/").slice(-2)[0];
      out.push({ name: fm.name || folder, desc: fm.description || "", path: p, group, text });
    }
  };
  if (root) await scan(`${root}/.claude/skills`, "Project");
  await scan(`${home()}/.claude/skills`, "Mine");
  const plug = parse((await readTextFile(`${home()}/.claude/plugins/installed_plugins.json`).catch(() => null)) ?? "null");
  for (const key of Object.keys(plug?.plugins ?? {})) out.push({ name: key.split("@")[0], desc: `plugin · ${key.split("@")[1] ?? ""}`, path: plug.plugins[key][0]?.installPath ?? "", group: "Plugins", plugin: true });
  const l = parse((await sh("skillshare", ["list", "--json"])).out);
  const managed = new Set((Array.isArray(l) ? l : l?.skills ?? []).map((x) => x.name ?? x.Name));
  return { items: out, managed };
}

export async function loadMcpScopes(root) {
  const j = parse((await readTextFile(`${home()}/.claude.json`).catch(() => null)) ?? "null");
  const project = parse((root ? await readTextFile(`${root}/.mcp.json`).catch(() => null) : null) ?? "null");
  return { global: new Set(Object.keys(j?.mcpServers ?? {})), project: new Set(Object.keys(project?.mcpServers ?? {})), managed: await managedMcp() };
}

// ---- shared pieces -----------------------------------------------------------------------

/** Preview card: dry-run lines and an explicit Apply. */
export function PendingCard(v, cx) {
  const p = v.pending;
  if (!p) return div();
  return v_flex().mx(24).my(14).p(14).gap(10).rounded(8).border_1().border_color(C.line3).bg(C.surface)
    .child(h_flex().gap(8).items_center().child(Caps("Preview")).child(div().flex_1().text_size(SIZE.meta).text_color(C.dim).child("dry run, nothing written yet")))
    .child(div().text_size(SIZE.body).text_color(C.text).child(p.title))
    .child(v_flex().gap(3).children(p.lines.map((l) => div().font_family(MONO).text_size(SIZE.meta).text_color(l.startsWith("+") ? C.greenText : l.startsWith("-") ? C.red : C.text2).child(l))))
    .when(Boolean(p.error), (e) => e.child(div().text_size(SIZE.meta).text_color(C.red).child(p.error)))
    .child(h_flex().gap(8).child(Btn("pend-apply", p.busy ? "Applying…" : "Apply", (_e, cx) => v.applyPending(cx), { primary: true, disabled: !p.apply || p.busy }))
      .child(Btn("pend-cancel", "Cancel", (_e, cx) => { v.pending = null; cx.notify(); })));
}

/** Runs `skillshare ... --dry-run` and turns the answer into a preview card. */
export function previewCard(v, cx, title, dryArgs, applyArgs, toLines) {
  v.pending = { title, lines: ["Running dry run…"], apply: null, busy: false };
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await sh("skillshare", dryArgs, { timeout: 90000 });
    const j = parse(r.out);
    const lines = j ? toLines(j) : r.out.split("\n").filter((l) => l.trim()).slice(0, 14);
    v.pending = { title, lines: lines.length ? lines : ["(no change)"], apply: r.code === 0 && !j?.blocked ? applyArgs : null, error: r.code !== 0 ? (r.err || r.out).split("\n")[0] : j?.blocked ? "Blocked by the audit threshold." : "" };
    cx.notify();
  });
}

const listDetail = (list, detail) => h_flex().size_full().min_w(0).child(list).child(detail);
const GROUPS = ["Project", "Mine", "Plugins"];

// ---- Skills --------------------------------------------------------------------------------

export class Skills {
  constructor(v, cx) {
    this.v = v; this.sel = null; this.unusedFirst = false; this.adding = false; this.results = null; this.searching = false;
    this.q = InputState.new({ placeholder: "Search skills" });
    this.q.on("change", (_e, cx) => cx.notify());
    this.hub = InputState.new({ placeholder: "Search the skillshare hub, then press enter" });
    this.hub.on("submit", (_e, cx) => this.search(cx));
    this.reload(cx);
  }
  reload(cx) {
    cx.spawn(async (cx) => {
      this.data = await loadSkills(this.v.scope === "project" ? this.v.root : null);
      if (!this.v.usage) { this.v.usage = await loadUsage(); }
      cx.notify();
    });
  }
  uses(s) {
    const u = this.v.usage?.skills ?? {};
    return u[s.name] ?? Object.entries(u).filter(([k]) => k.endsWith(`:${s.name}`)).reduce((a, [, n]) => a + n, 0);
  }
  search(cx) {
    const q = this.hub.value().trim();
    if (!q) return;
    this.searching = true; this.results = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await sh("skillshare", ["search", q, "--hub", "--json", "-n", "8"], { timeout: 60000 });
      this.results = parse(r.out) ?? []; this.searching = false; cx.notify();
    });
  }
  install(res, cx) {
    const src = res.Source;
    previewCard(this.v, cx, `Install ${res.Name}`, ["install", src, "--dry-run", "--json"], ["install", src, "--yes", "--json"],
      (j) => [...(j.planned ?? []).map((p) => `+ ${p.name}  ${p.path}`), "into ~/.config/skillshare/skills (syncing to Claude Code is a separate step)", `audit risk: ${res.riskLabel ?? "unknown"} (${res.riskScore ?? "?"})`]);
  }
  remove(s, cx) {
    previewCard(this.v, cx, `Remove ${s.name}`, ["uninstall", s.name, "--dry-run"], ["uninstall", s.name, "--yes"], () => [`- ${s.name}`]);
  }
  syncPreview(cx) {
    previewCard(this.v, cx, "Sync skills to Claude Code", ["sync", "--dry-run", "--json"], ["sync"], (j) => (j.changes ?? j.targets ?? []).map((c) => `~ ${JSON.stringify(c).slice(0, 110)}`));
  }

  list(cx) {
    const items = (this.data?.items ?? []).filter((s) => {
      const q = this.q.value().toLowerCase();
      return !q || s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q);
    });
    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().pb(12);
    if (!this.data) body.child(div().px(20).py(12).text_size(SIZE.meta).text_color(C.dim).child("Reading skills…"));
    for (const g of GROUPS) {
      let rows = items.filter((s) => s.group === g);
      if (!rows.length) continue;
      rows = [...rows].sort((a, b) => (this.unusedFirst ? this.uses(a) - this.uses(b) : 0) || a.name.localeCompare(b.name));
      const where = g === "Project" ? `${this.v.rootName}/.claude/skills` : g === "Mine" ? "~/.claude/skills" : "";
      body.child(div().px(20).pt(14).pb(4).text_size(SIZE.caps).font_semibold().text_color(C.muted).child(`${g.toUpperCase()}${where ? ` · ${where}` : ""}`));
      for (const s of rows) {
        const n = this.uses(s), on = this.sel === s && !this.adding;
        body.child(h_flex().id(`sk-${g}-${s.name}`).mx(8).px(12).py(8).gap(10).items_center().rounded(7).cursor_pointer()
          .when(on, (e) => e.bg(C.raised)).when(!on, (e) => e.hover((x) => x.bg("#221D17")))
          .on_click((_e, cx) => { this.sel = s; this.adding = false; this.v.pending = null; cx.notify(); })
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().font_family(MONO).text_size(SIZE.body).text_color(!s.plugin && n === 0 ? C.muted : C.text).child(s.plugin ? s.name : `/${s.name}`))
            .child(div().truncate().text_size(SIZE.meta).text_color(C.muted).child(s.desc)))
          .when(!s.plugin, (e) => e.child(div().flex_none().text_size(SIZE.meta).text_color(n ? C.text2 : C.dim).child(this.v.usage ? (n ? `${n} uses · 30d` : "never used") : "…"))));
      }
    }
    return v_flex().w(330).flex_none().h_full().min_h(0).border_r(1).border_color(C.line1)
      .child(h_flex().px(18).pt(16).pb(10).items_center().gap(8)
        .child(div().text_size(SIZE.title).font_semibold().text_color(C.text).child("Skills"))
        .child(div().text_size(SIZE.title).text_color(C.dim).flex_1().child(`${(this.data?.items ?? []).filter((s) => !s.plugin).length}`))
        .child(Btn("sk-add", "Add skill", (_e, cx) => { this.adding = true; this.v.pending = null; cx.notify(); }, { small: true, disabled: this.v.scope === "project" })))
      .child(div().px(18).pb(6).child(SearchBox("sk-q", this.q, Input, "", div())))
      .child(h_flex().px(20).pb(2).child(div().id("sk-sort").text_size(SIZE.caps).text_color(C.muted).cursor_pointer().hover((s) => s.text_color(C.text2))
        .on_click((_e, cx) => { this.unusedFirst = !this.unusedFirst; cx.notify(); }).child(this.unusedFirst ? "Unused first" : "By name")))
      .child(body);
  }

  detail(cx) {
    const v = this.v;
    if (this.adding) {
      return v_flex().flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(24).pt(22).gap(12)
          .child(div().text_size(SIZE.page).font_semibold().text_color(C.text).child("Add skill"))
          .child(div().text_size(SIZE.body).text_color(C.muted).child("Search the skillshare hub. You get a dry run and the audit risk before anything is installed."))
          .child(SearchBox("hub-q", this.hub, Input, "", div()))
          .child(Btn("hub-go", this.searching ? "Searching…" : "Search", (_e, cx) => this.search(cx), { small: true }))
          .children((this.results ?? []).map((r, i) => h_flex().id(`hub-${i}`).py(8).gap(10).items_center().border_b(1).border_color(C.line1).cursor_pointer()
            .on_click((_e, cx) => this.install(r, cx))
            .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_family(MONO).text_size(SIZE.body).text_color(C.text).child(r.Name))
              .child(div().truncate().text_size(SIZE.meta).text_color(C.muted).child(r.Description ?? ""))
              .child(div().font_family(MONO).text_size(SIZE.caps).text_color(C.dim).child(r.Source)))
            .child(div().text_size(SIZE.meta).text_color(r.riskLabel === "low" ? C.greenText : C.ember).child(`risk ${r.riskLabel ?? "?"}`))))
          .when(this.results && !this.results.length, (e) => e.child(div().text_color(C.dim).child("Nothing found."))))
        .child(PendingCard(v, cx));
    }
    const s = this.sel;
    if (!s) return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().gap(10)
      .child(div().text_size(SIZE.body).text_color(C.dim).child("Pick a skill to see where it comes from."))
      .child(Btn("sk-sync", "Preview sync to Claude Code", (_e, cx) => this.syncPreview(cx), { small: true }))
      .child(PendingCard(v, cx));
    const managed = this.data?.managed?.has(s.name);
    const n = this.uses(s);
    const lines = (s.text ?? "").split("\n").slice(0, 22);
    return v_flex().flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(24).pt(22).pb(14).gap(10)
        .child(h_flex().gap(10).items_center().child(div().flex_1().font_family(MONO).text_size(SIZE.page).text_color(C.text).child(s.plugin ? s.name : `/${s.name}`))
          .when(managed, (e) => e.child(Btn("sk-rm", "Remove", (_e, cx) => this.remove(s, cx), { small: true }))))
        .child(div().text_size(SIZE.body).text_color(C.text2).child(s.desc))
        .child(v_flex().gap(8).pt(6)
          .child(Field("Source", managed ? "skillshare" : s.plugin ? "Claude Code plugin" : "local folder", { color: C.text2 }))
          .child(Field("On disk", tilde(s.path), { mono: true }))
          .when(!s.plugin, (e) => e.child(Field("Usage", v.usage ? (n ? `${n} uses in 30 days` : "never used in 30 days") : "counting…")))))
      .child(PendingCard(v, cx))
      .when(Boolean(s.text), (e) => e.child(v_flex().px(24).py(16).gap(8).border_t(1).border_color(C.line1)
        .child(Caps("SKILL.md")).child(v_flex().gap(2).children(lines.map((l) => div().font_family(MONO).text_size(SIZE.meta).text_color(l.startsWith("#") ? C.ember : C.muted).child(l || " "))))));
  }

  render(cx) { return listDetail(this.list(cx), this.detail(cx)); }
}

// ---- MCP -------------------------------------------------------------------------------------

const STATE_LABEL = { connected: ["Connected", C.green], auth: ["Needs auth", C.ember], error: ["Error", C.red] };

export class Mcp {
  constructor(v, cx) {
    this.v = v; this.sel = null; this.adding = false;
    this.q = InputState.new({ placeholder: "Search servers" });
    this.q.on("change", (_e, cx) => cx.notify());
    this.nameIn = InputState.new({ placeholder: "name" });
    this.targetIn = InputState.new({ placeholder: "https://…/mcp  or  command args" });
    this.reload(cx);
  }
  reload(cx) {
    this.servers = null; cx.notify();
    cx.spawn(async (cx) => {
      this.scopes = await loadMcpScopes(this.v.scope === "project" ? this.v.root : null);
      this.servers = await loadMcpList();
      this.v.mcp = { servers: this.servers };
      if (!this.v.usage) this.v.usage = await loadUsage();
      cx.notify();
    });
  }
  scopeOf(s) {
    if (s.name.startsWith("claude.ai ")) return "claude.ai";
    if (this.scopes?.project.has(s.name)) return "project";
    return "global";
  }
  usage(s) { return this.v.usage?.mcp?.[s.name.replace(/[^A-Za-z0-9_-]/g, "_")]; }

  previewAdd(cx) {
    const name = this.nameIn.value().trim(), t = this.targetIn.value().trim();
    if (!name || !t) { this.v.pending = { title: "Add server", lines: [], apply: null, error: "Give it a name and a URL or command." }; cx.notify(); return; }
    const url = /^https?:\/\//.test(t);
    const base = ["mcp", "add", name, ...(url ? ["--url", t] : []), "--target", "claude", ...(url ? [] : ["--", ...t.split(/\s+/)])];
    previewCard(this.v, cx, `Add ${name}`, [...base, "--dry-run", "--json"], [...base, "--sync"],
      (j) => (j.changes ?? []).map((c) => `${c.action === "add" ? "+" : "~"} ${c.name}  ${tilde(c.path)}  (${(c.fields?.added ?? []).join(", ")})`));
  }
  previewRemove(s, cx) {
    previewCard(this.v, cx, `Remove ${s.name}`, ["mcp", "remove", s.name, "--dry-run", "--json"], ["mcp", "remove", s.name, "--sync"],
      (j) => (j.changes ?? []).map((c) => `- ${c.name}  ${tilde(c.path)}`));
  }

  list(cx) {
    const q = this.q.value().toLowerCase();
    const all = (this.servers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
    const groups = [["Needs attention", all.filter((s) => s.state !== "connected")], ["Connected", all.filter((s) => s.state === "connected")]];
    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().pb(12);
    if (!this.servers) body.child(div().px(20).py(12).text_size(SIZE.meta).text_color(C.dim).child("Asking claude mcp list…"));
    for (const [label, rows] of groups) {
      if (!rows.length) continue;
      body.child(div().px(20).pt(14).pb(4).text_size(SIZE.caps).font_semibold().text_color(C.muted).child(label.toUpperCase()));
      for (const s of rows) {
        const u = this.usage(s), on = this.sel === s && !this.adding, never = this.v.usage && !u;
        body.child(h_flex().id(`mcp-${s.name}`).mx(8).px(12).py(8).gap(10).items_center().rounded(7).cursor_pointer()
          .when(on, (e) => e.bg(C.raised)).when(!on, (e) => e.hover((x) => x.bg("#221D17")))
          .on_click((_e, cx) => { this.sel = s; this.adding = false; this.v.pending = null; cx.notify(); })
          .child(div().size(7).rounded(4).flex_none().bg(STATE_LABEL[s.state][1]))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(SIZE.body).text_color(never && s.state === "connected" ? C.muted : C.text).child(s.name))
            .child(div().truncate().text_size(SIZE.meta).text_color(s.state === "connected" ? C.muted : STATE_LABEL[s.state][1])
              .child(s.state === "connected" ? (u ? `${u.tools.size} tools used · ${u.calls} calls · 30d` : never ? "never used · costs context" : "") : s.statusText)))
          .child(div().flex_none().text_size(SIZE.meta).text_color(C.dim).child(this.scopeOf(s))));
      }
    }
    return v_flex().w(330).flex_none().h_full().min_h(0).border_r(1).border_color(C.line1)
      .child(h_flex().px(18).pt(16).pb(10).items_center().gap(8)
        .child(div().text_size(SIZE.title).font_semibold().text_color(C.text).child("MCP servers"))
        .child(div().text_size(SIZE.title).text_color(C.dim).flex_1().child(`${this.servers?.length ?? ""}`))
        .child(Btn("mcp-refresh", icon("refresh-cw", 12, C.muted), (_e, cx) => this.reload(cx), { small: true }))
        .child(Btn("mcp-add", "Add server", (_e, cx) => { this.adding = true; this.v.pending = null; cx.notify(); }, { small: true, disabled: this.v.scope === "project" })))
      .child(div().px(18).pb(6).child(SearchBox("mcp-q", this.q, Input, "", div())))
      .child(body);
  }

  detail(cx) {
    const v = this.v;
    if (this.adding) {
      return v_flex().flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(24).pt(22).gap(12)
          .child(div().text_size(SIZE.page).font_semibold().text_color(C.text).child("Add server"))
          .child(div().text_size(SIZE.body).text_color(C.muted).child("Through skillshare. You see the config change before anything is written."))
          .child(SearchBox("mcp-name", this.nameIn, Input, "", div()))
          .child(SearchBox("mcp-target", this.targetIn, Input, "", div()))
          .child(Btn("mcp-preview", "Preview change", (_e, cx) => this.previewAdd(cx), { small: true })))
        .child(PendingCard(v, cx));
    }
    const s = this.sel;
    if (!s) return v_flex().flex_1().h_full().items_center().justify_center().child(div().text_size(SIZE.body).text_color(C.dim).child("Pick a server to see its details."));
    const u = this.usage(s), managed = this.scopes?.managed.has(s.name);
    const type = /^https?:/.test(s.target) ? "http" : "stdio";
    return v_flex().flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(24).pt(22).pb(14).gap(10)
        .child(h_flex().gap(10).items_center().child(div().text_size(SIZE.page).font_semibold().text_color(C.text).child(s.name))
          .child(div().text_size(SIZE.meta).text_color(STATE_LABEL[s.state][1]).child(STATE_LABEL[s.state][0])).child(div().flex_1())
          .when(managed, (e) => e.child(Btn("mcp-rm", "Remove", (_e, cx) => this.previewRemove(s, cx), { small: true }))))
        .child(v_flex().gap(8).pt(6)
          .child(Field("Type", `${type} · ${redact(s.target)}`, { mono: true }))
          .child(Field("Defined in", managed ? "skillshare → ~/.claude.json" : this.scopeOf(s) === "claude.ai" ? "your claude.ai account" : this.scopeOf(s) === "project" ? ".mcp.json" : "~/.claude.json", { mono: true }))
          .child(Field("Status", s.statusText, { color: STATE_LABEL[s.state][1] }))
          .child(Field("Usage", u ? `${u.calls} calls · ${u.tools.size} tools used in 30 days` : v.usage ? "never used in 30 days (still costs context)" : "counting…"))
          .when(!managed, (e) => e.child(div().pt(6).text_size(SIZE.meta).text_color(C.dim).child(s.state === "auth" ? "Authenticate from a Claude session with /mcp. Not managed by skillshare." : "Not managed by skillshare, so no Remove here.")))))
      .child(PendingCard(v, cx))
      .when(u, (e) => e.child(v_flex().px(24).py(16).gap(6).border_t(1).border_color(C.line1).child(Caps(`Tools used · ${u.tools.size}`))
        .children([...u.tools].slice(0, 12).map((t) => div().font_family(MONO).text_size(SIZE.meta).text_color(C.text2).child(t)))));
  }

  render(cx) { return listDetail(this.list(cx), this.detail(cx)); }
}
