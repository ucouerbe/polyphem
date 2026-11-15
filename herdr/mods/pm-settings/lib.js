// @ts-check
// Small helpers shared by the pm-settings sections.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, readTextFile, writeTextFile } from "herdr";
import { C, SIZE, MONO, icon } from "./ui.js";

export const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
export const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** Runs a program, never rejects: { code, out, err }. */
export async function sh(cmd, args, opts = {}) {
  try {
    const r = await exec(cmd, args, { timeout: 30000, ...opts });
    return { code: r.code, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), raw: r.stdout ?? "" };
  } catch (e) { return { code: 127, out: "", err: String(e), raw: "" }; }
}

export async function mainOf(dir) {
  if (!dir) return null;
  const r = await sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  return r.code === 0 && r.out.endsWith("/.git") ? r.out.slice(0, -5) : null;
}

/** Read-modify-write a JSON file (settings.json): keeps unknown keys. */
export async function patchJson(path, fn) {
  const text = await readTextFile(path);
  const data = parse(text ?? "{}") ?? {};
  fn(data);
  await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text);
}

/** YAML-ish frontmatter: { name, description } of a SKILL.md. */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text ?? "");
  const out = {};
  if (!m) return out;
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const k = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!k) continue;
    let v = k[2];
    if (/^[>|][-+]?$/.test(v)) { v = ""; while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) v += ` ${lines[++i].trim()}`; }
    out[k[1]] = v.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

// ---- UI atoms ----------------------------------------------------------------------------

export const Toggle = (id, on, onClick, disabled = false) =>
  div().id(id).w(30).h(18).flex_none().rounded(9).p(2).flex().items_center()
    .bg(on ? C.ember : C.raised).opacity(disabled ? 0.5 : 1)
    .when(on, (e) => e.justify_end()).when(!on, (e) => e.justify_start())
    .when(!disabled, (e) => e.cursor_pointer().on_click(onClick))
    .child(div().size(14).rounded(7).bg(on ? "#1B140D" : C.muted));

/** Primary (ember) or ghost (hairline) button. */
export function Btn(id, label, onClick, { primary = false, disabled = false, small = false } = {}) {
  const el = h_flex().id(id).flex_none().h(small ? 24 : 28).px(small ? 8 : 12).gap(6).items_center().rounded(7)
    .text_size(SIZE.meta + (small ? 0 : 0.5)).font_medium();
  if (primary) el.bg(disabled ? C.raised : C.ember).text_color(disabled ? C.dim : "#1B140D");
  else el.border_1().border_color(C.line3).text_color(disabled ? C.dim : C.text2);
  if (!disabled) el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick);
  return el.children(Array.isArray(label) ? label : [label]);
}

export const Caps = (text) => div().text_size(SIZE.caps).font_semibold().text_color(C.muted).child(text.toUpperCase());

/** Label / value row of a detail sheet. */
export const Field = (label, value, { mono = false, color = C.text2 } = {}) =>
  h_flex().gap(16).items_baseline().child(div().w(96).flex_none().text_size(SIZE.meta).text_color(C.muted).child(label))
    .child(div().flex_1().min_w(0).text_size(SIZE.meta + 0.5).text_color(color).when(mono, (e) => e.font_family(MONO)).child(value));

export const SearchBox = (id, state, Input, hint, right) =>
  h_flex().h(32).px(10).gap(8).items_center().rounded(7).border_1().border_color(C.line3).bg(C.surface)
    .child(icon("search", 12, C.dim))
    .child(div().flex_1().min_w(0).child(Input.new(state).w_full().text_size(SIZE.body).text_color(C.text)))
    .when(Boolean(right), (e) => e.child(div().text_size(SIZE.caps).text_color(C.muted).child(right)));

export { C, SIZE, MONO, icon, h_flex, v_flex, div, exec, home, readTextFile, writeTextFile };
