import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { C, MONO, icon, StatusDot, kindOf } from "./ui.js";
import { spaces, panes, run, openOverlay, closeOverlay, props, theme, window, shared, layout, settings } from "herdr";
import { v_flex } from "gpui-base";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.menu = props()?.menu ? props() : null;
    this.pressed = null;
    this.widths = {}; this.wrapW = 0; this.issuedPx = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  tabName(c) {
    const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
    return /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
  }

  /** Overlay mode: the tabs that didn't fit in the bar. */
  renderMenu() {
    const m = this.menu;
    return v_flex().size_full().py(4).bg(C.surface).overflow_y_scroll().id("more")
      .children(m.tabs.map((x) => h_flex().id(`m-${x.id}`).h(30).mx(4).px(8).flex_none().items_center().rounded(6).text_size(13).text_color(C.text2)
        .cursor_pointer().hover(s => s.bg(C.raised)).on_click(() => { run("tab.select", { id: x.id }); closeOverlay(m.overlay); })
        .child(div().flex_1().min_w(0).truncate().child(x.name))));
  }

  render() {
    if (this.menu) return this.renderMenu();
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    // Tabs wrap onto at most MAX_ROWS rows: pack the measured widths (divider included) into the row width.
    // What doesn't fit goes behind a "+N" chip; the active tab is always kept visible.
    const ROW = 30, GAP = 4, PAD = 8, MAX_ROWS = 2, CHIP = 52;
    const pack = (list) => {
      let rows = 1, x = 0; const starts = new Set([0]);
      for (let k = 0; k < list.length; k++) {
        const w = this.widths[list[k].id] ?? 0, room = rows === MAX_ROWS && k < list.length - 1 ? CHIP + GAP : 0;
        if (x > 0 && x + GAP + w + room > this.wrapW) {
          if (rows === MAX_ROWS) return { count: k, rows, starts };
          rows++; x = w; starts.add(k);
        } else x += (x > 0 ? GAP : 0) + w;
      }
      return { count: list.length, rows, starts };
    };
    let order = shown, fit = this.wrapW > 0 ? pack(order) : { count: shown.length, rows: 1, starts: new Set([0]) };
    const activeAt = shown.findIndex((c) => c.active);
    if (activeAt >= fit.count && fit.count > 0) {
      order = [...shown.slice(0, fit.count - 1), shown[activeAt], ...shown.filter((c, k) => k >= fit.count - 1 && k !== activeAt)];
      fit = pack(order);
    }
    const visible = order.slice(0, fit.count), hidden = order.slice(fit.count), rows = fit.rows;
    const want = PAD * 2 + rows * ROW + (rows - 1) * (GAP * 2 + 1); // rows + a hairline between them
    const tabsNode = find(layout(), "tabs");
    if (tabsNode?.size?.px !== want && this.issuedPx !== want) { this.issuedPx = want; run("layout.resize", { id: "tabs", px: want }); }
    else if (tabsNode?.size?.px === want) this.issuedPx = null;
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(7).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // One icon per tab type: Claude = status dot, terminal >_, markdown file-text, settings cog, PR, diff.
    const lead = (c) => {
      const ps = panes().filter((p) => p.tab === c.id);
      if (ps.some((p) => p.program?.agent)) return StatusDot(kindOf(c.status ?? "idle"), 12);
      const mod = ps.find((p) => p.mod)?.mod ?? "";
      const name = /settings/.test(mod) ? "cog" : /(^|-)pr($|-)/.test(mod) ? "git-pull-request" : /diff/.test(mod) ? "git-compare"
        : /md|markdown|viewer/.test(mod) ? "file-text" : /routine/.test(mod) ? "calendar-clock" : "terminal";
      if (name === "terminal") return div().flex_none().font_family(MONO).text_size(12).text_color(c.active ? C.text2 : C.muted).child(">_");
      return icon(name, 13, c.active ? C.text2 : C.muted);
    };
    const item = (c, i) => {
      const prev = visible[i - 1];
      const divider = !fit.starts.has(i) && !c.active && !prev?.active;
      const name = this.tabName(c);
      const tab = h_flex().id(`tab-${c.id}`).h(30).px(12).gap(8).rounded(7).items_center().flex_none().text_size(13)
        .bg(c.active ? "#2C261F" : t.chrome).text_color(c.active ? C.text : C.muted).when(c.active, el => el.font_medium())
        .when(!c.active, el => el.hover(s => s.bg("#221D17")))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: visible[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(lead(c))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when((shared("pm.md.dirty") ?? []).includes(c.name) && panes().some(p => p.tab === c.id && p.mod === "pm-md"), el => el.child(div().size(6).rounded(3).bg(C.ember)))
        .when(c.status === "blocked" && !panes().some(p => p.tab === c.id && p.program?.agent), el => el.child(div().size(6).rounded(3).bg(t.blocked)))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(C.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
      // The divider is part of the measured width, so packing stays exact. GAP before it is the flex gap.
      return h_flex().id(`tw-${c.id}`).flex_none().items_center().gap(GAP)
        .on_size_change((size, cx) => { if (Math.abs((this.widths[c.id] ?? 0) - size.width) > 0.5) { this.widths[c.id] = size.width; cx.notify(); } })
        .child(div().w(1).h(14).flex_none().bg(divider ? C.line3 : "#00000000")).child(tab);
    };
    const rowsOf = [];
    visible.forEach((c, i) => { if (fit.starts.has(i) || !rowsOf.length) rowsOf.push([]); rowsOf[rowsOf.length - 1].push({ c, i }); });
    if (!rowsOf.length) rowsOf.push([]);
    const chip = hidden.length > 0 && h_flex().id("tab-more").h(30).px(10).flex_none().items_center().rounded(7).text_size(12).text_color(C.muted)
      .cursor_pointer().hover(s => s.bg("#221D17").text_color(C.text2)).on_mouse_down("left", stop)
      .on_click(() => openOverlay({ mod: "pm-tabs", kind: "popup", width: 260, height: Math.min(40 + hidden.length * 30, 420),
        props: { menu: true, tabs: hidden.map((c) => ({ id: c.id, name: this.tabName(c) })) } }))
      .child(`+${hidden.length}`);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(30).px(10).gap(6).flex_none().items_center().rounded(7)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(12).pl(lightsPadding).py(8).gap(4).items_start().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(v_flex().id("tab-wrap").flex_1().min_w(0).gap(GAP)
        .on_size_change((size, cx) => { if (Math.abs(this.wrapW - size.width) > 0.5) { this.wrapW = size.width; cx.notify(); } })
        .children(rowsOf.flatMap((r, k) => {
          const line = h_flex().h(ROW).w_full().min_w(0).items_center().gap(GAP).children(r.map(({ c, i }) => item(c, i)))
            .when(k === rowsOf.length - 1 && Boolean(chip), el => el.child(chip));
          return k === 0 ? [line] : [div().h(1).w_full().flex_none().bg(t.border), line];
        })))
      .child(button("tab-new", icon("plus", 14, C.muted), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/pm-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/pm-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/pm-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
