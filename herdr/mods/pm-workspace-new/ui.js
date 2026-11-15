// @ts-check
// Shared design tokens and small UI helpers for the pm-* mods.
// Source of truth lives in pm-shared/ui.js. Mods cannot import outside their own
// folder, so run pm-shared/sync.sh after editing: it copies this file to mods/pm-*/ui.js.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const C = {
  bg: "#17140F", surface: "#1C1814", raised: "#2A241D",
  line1: "#2A241D", line2: "#2E2720", line3: "#3A3229",
  text: "#EDE4D3", text2: "#D6CCBA", muted: "#9A8F7E", dim: "#6B6155",
  ember: "#E0874F", link: "#E0A27A", yellow: "#E3B341", red: "#E5484D",
  green: "#5BB35B", greenText: "#9DBF7E",
};
export const SIZE = { caps: 11, meta: 12, body: 13, title: 15, page: 20, report: 28 };
export const SANS = "Geist";
export const MONO = "Geist Mono";
export const ICONS = "pm-shared/icons/";

/** Lucide icon (stroke) tinted with `color`. */
export const icon = (name, size = 14, color = C.muted) =>
  svg(`${ICONS}${name}.svg`).size(size).flex_none().text_color(color);

const DOTS = {
  running: { icon: "dot", color: C.yellow },
  waiting: { icon: "circle-half", color: C.ember },
  failed: { icon: "x", color: C.red },
  ready: { icon: "check", color: C.green },
  idle: { icon: "ring", color: C.dim },
};

/** Map a Herdr agent status to a StatusDot kind. */
export const kindOf = (status) =>
  status === "blocked" ? "waiting" : status === "working" ? "running" : status === "done" ? "ready" : "idle";

export const colorOfKind = (kind) => (DOTS[kind] ?? DOTS.idle).color;

/** Shape plus color: running (pulse), waiting, failed, ready, idle. */
export function StatusDot(kind, size = 12) {
  const d = DOTS[kind] ?? DOTS.idle;
  const el = div().size(size).flex_none().flex().items_center().justify_center().child(icon(d.icon, size, d.color));
  return kind === "running" ? el.loop("opacity", { from: 0.35, to: 1, period: 1600 }) : el;
}

/** +N green, -N red, mono, no frame. */
export function DiffPill(add, del) {
  if (!add && !del) return div();
  return h_flex().flex_none().gap(5).font_family(MONO).text_size(10)
    .when(add > 0, (el) => el.child(div().text_color(C.dim).child(`+${add}`)))
    .when(del > 0, (el) => el.child(div().text_color(C.dim).child(`\u2212${del}`)));
}

/** Keyboard hint, mono, discreet. */
export const Kbd = (text, color = C.dim) =>
  div().flex_none().font_family(MONO).text_size(10).text_color(color).child(text);

/** 11px caps label (muted), optional count (accent), optional trailing hint or + (onAdd). */
export function SectionHeader({ id, label, count, countColor, hint, onAdd, addTip }) {
  return h_flex().id(id).h(26).flex_none().mx(8).px(8).items_center().gap(6)
    .child(div().text_size(SIZE.caps).font_semibold().text_color(C.muted).child(label.toUpperCase()))
    .when(count !== undefined && count !== null, (el) =>
      el.child(div().text_size(SIZE.caps).font_semibold().text_color(countColor ?? C.muted).child(`\u00b7 ${count}`)))
    .child(div().flex_1())
    .when(Boolean(hint), (el) => el.child(Kbd(hint)))
    .when(Boolean(onAdd), (el) =>
      el.child(div().id(`${id}-add`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .tooltip(addTip ?? "Add").hover((s) => s.bg(C.raised)).on_click(onAdd).child(icon("plus", 14, C.muted))));
}

/** Hairline between sidebar sections. */
export const Sep = (mt = 10, mb = 0) => div().h(1).flex_none().mt(mt).mb(mb).bg(C.line1);

/** Flat clickable row; selected = raised background, radius 7. */
export function Row({ id, selected, onClick, height }) {
  const el = h_flex().id(id).flex_none().mx(8).px(8).rounded(7).items_center().gap(8)
    .when(Boolean(height), (e) => e.h(height))
    .when(Boolean(selected), (e) => e.bg(C.raised))
    .when(!selected, (e) => e.hover((s) => s.bg("#221D17")));
  return onClick ? el.cursor_pointer().on_click(onClick) : el;
}

export { div, h_flex, v_flex };
