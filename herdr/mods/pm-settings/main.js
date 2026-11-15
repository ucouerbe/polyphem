// @ts-check
// Settings (screens 12, 13, 13b, sounds, appearance): one master-detail page opened as a tab.
//   run("tab.new", { name: "Settings", mod: "pm-settings", props: { section: "prompts", root?: "<abs repo>" } })
// Key: "pm-settings.open" (keys.json layout:pm cmd-,) opens the tab; the command is delivered to a visible copy
// of this mod, or use mod.open. Sections: general prompts skills mcp workspaces scripts models sounds appearance.
import { View } from "gpui-kit";
import { run, props, focused, panes, appHome, readTextFile, nextCommand, spaces, closeOverlay, home } from "herdr";
import { C, SIZE, h_flex, v_flex, div, mainOf, parse, sh, readTextFile as rtf } from "./lib.js";
import { Prompts } from "./prompts.js";
import { Skills, Mcp, backup, loadMcpList } from "./tools.js";
import { General, Workspaces, Scripts, Models, Sounds, Appearance } from "./misc.js";

const NAV = [["general", "General"], ["prompts", "Prompts"], ["skills", "Skills"], ["mcp", "MCP"], ["workspaces", "Workspaces"], ["scripts", "Scripts"], ["models", "Models"], ["sounds", "Sounds"], ["appearance", "Appearance"]];
const SCOPED = new Set(["prompts", "skills", "mcp", "workspaces", "scripts"]);

export default class PmSettings extends View {
  init(_p, cx) {
    const p = props() ?? {};
    if (p.overlay) { this.launcher = true; this.open(p); return; } // opened by key (mod.open): bounce into a tab
    this.section = p.section ?? "general";
    this.scope = p.scope ?? "global";
    this.root = p.root ?? null; this.rootName = this.root ? this.root.split("/").pop() : null;
    this.pending = null; this.mcp = null; this.usage = null; this.settingsJson = null; this.linear = undefined; this.project = null;
    this.pages = {};
    this.ensure(cx);
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      if (!this.root) {
        const f = focused();
        const cwd = f?.cwd ?? panes().find((x) => x.cwd)?.cwd;
        this.root = await mainOf(cwd);
        this.rootName = this.root ? this.root.split("/").pop() : null;
      }
      if (p.scope === undefined && p.project && this.root) { this.scope = "project"; this.setScope("project", cx); }
      else if (this.pages[this.section]?.refresh) this.pages[this.section].refresh(cx);
      await this.loadSettings(cx);
      await this.loadProject(cx);
      cx.notify();
      // Linear and MCP status for General, read-only.
      const bin = `${home()}/.local/share/herdr-linear/app/0.14.5/herdr-linear`;
      const r = await sh("sh", ["-c", `[ -x "${bin}" ] && "${bin}" app '{"op":"status"}'`]);
      const st = parse(r.out);
      if (!this.mcp) { this.mcp = { servers: await loadMcpList() }; cx.notify(); }
      this.linear = st ? (st.workspaces?.[0]?.name ?? st.workspaces?.[0]?.urlKey ?? false) : false;
      cx.notify();
    });
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c.startsWith("section:")) this.go(c.slice(8), cx); } });
  }

  /** keys.json cmd-, -> mod.open:pm-settings: show the Settings tab (open it once). */
  open(p) {
    const sp = spaces().find((x) => x.active);
    const tab = sp?.tabs.find((t) => t.name === "Settings");
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { name: "Settings", mod: "pm-settings", props: { section: p.section ?? "general" } });
    closeOverlay(p.overlay);
  }

  loadSettings(cx) {
    return readTextFile(`${appHome()}/settings.json`).then((t) => { this.settingsJson = parse(t ?? "{}") ?? {}; cx.notify(); });
  }
  async loadProject(cx) {
    if (!this.root) { this.project = null; return; }
    const t = await rtf(`${this.root}/.herdr/project.json`).catch(() => null);
    this.project = t === null ? { missing: true } : parse(t) ?? { invalid: true };
    cx.notify();
  }

  /** Runs the pending skillshare write, after backing up the Claude files. Only reached from the Apply button. */
  applyPending(cx) {
    const p = this.pending;
    if (!p?.apply || p.busy) return;
    p.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      await backup();
      const r = await sh("skillshare", p.apply, { timeout: 180000 });
      this.pending = r.code === 0 ? null : { ...p, busy: false, error: (r.err || r.out).split("\n")[0] };
      this.usage = null;
      for (const k of ["skills", "mcp"]) this.pages[k]?.reload(cx);
      cx.notify();
    });
  }

  /** Retained states (editors, inputs) must be created in init or an event handler, never in render. */
  ensure(cx) {
    const make = { prompts: Prompts, skills: Skills, mcp: Mcp };
    if (make[this.section] && !this.pages[this.section]) this.pages[this.section] = new make[this.section](this, cx);
  }
  setScope(s, cx) { this.scope = s; this.pending = null; for (const k of ["prompts", "skills", "mcp"]) delete this.pages[k]; this.ensure(cx); cx.notify(); }
  go(id, cx) { this.section = id; this.pending = null; this.ensure(cx); cx.notify(); }

  nav(cx) {
    const seg = (id, label) => div().id(`scope-${id}`).flex_1().min_w(0).px(8).h(26).flex().items_center().justify_center().rounded(6).text_size(SIZE.meta + 0.5)
      .when(this.scope === id, (e) => e.bg(C.raised).text_color(C.text)).when(this.scope !== id, (e) => e.text_color(C.muted).hover((s) => s.text_color(C.text2)))
      .when(id === "global" || Boolean(this.root), (e) => e.cursor_pointer().on_click((_e, cx) => this.setScope(id, cx))).child(div().truncate().child(label));
    return v_flex().w(210).flex_none().h_full().border_r(1).border_color(C.line1).p(10).gap(14)
      .child(h_flex().h(30).p(2).rounded(8).bg(C.bg).child(seg("global", "Global")).child(seg("project", this.rootName ?? "Project")))
      .child(v_flex().gap(2).children(NAV.map(([id, label]) => {
        const on = this.section === id;
        return h_flex().id(`nav-${id}`).h(30).px(10).items_center().rounded(7).text_size(SIZE.body).cursor_pointer()
          .when(on, (e) => e.bg(C.raised).text_color(C.text)).when(!on, (e) => e.text_color(C.text2).hover((s) => s.bg("#221D17")))
          .on_click((_e, cx) => this.go(id, cx)).child(label);
      })));
  }

  page(cx) {
    const s = this.section;
    if (this.pages[s]) return this.pages[s].render(cx);
    const f = { general: General, workspaces: Workspaces, scripts: Scripts, models: Models, sounds: Sounds, appearance: Appearance }[s];
    return f(this, cx);
  }

  render(cx) {
    if (this.launcher) return div();
    return h_flex().id("pm-settings").size_full().min_h(0).min_w(0).bg(C.surface).text_size(SIZE.body).text_color(C.text2).track_focus(this.handle)
      .child(this.nav(cx)).child(div().flex_1().min_w(0).h_full().min_h(0).child(this.page(cx)));
  }
}

