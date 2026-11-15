// @ts-check
// Settings pages without a list/detail split: General, Workspaces, Scripts, Models, Sounds, Appearance.
import { run, playSound, appHome, shared, setShared, themes, settings, openOverlay, notify } from "herdr";
import { C, SIZE, MONO, icon, h_flex, v_flex, div, Toggle, Btn, Caps, Field, patchJson, readTextFile, parse, tilde } from "./lib.js";

export const page = (title, sub, ...kids) =>
  v_flex().id(`page-${title}`).size_full().min_h(0).overflow_y_scrollbar()
    .child(v_flex().w_full().max_w(640).px(28).py(24).gap(20)
      .child(v_flex().gap(4).child(div().text_size(SIZE.page).font_semibold().text_color(C.text).child(title))
        .when(Boolean(sub), (e) => e.child(div().text_size(SIZE.body).text_color(C.muted).child(sub))))
      .children(kids));

const section = (label, ...kids) => v_flex().gap(10).child(Caps(label)).children(kids);
const note = (t) => div().text_size(SIZE.meta).text_color(C.dim).child(t);
const dotColor = (s) => (s === "ok" ? C.green : s === "warn" ? C.ember : s === "bad" ? C.red : C.dim);
const status = (kind, text) => h_flex().gap(6).items_center().child(div().size(7).rounded(4).bg(dotColor(kind))).child(div().text_color(C.text2).child(text));

// ---- General ---------------------------------------------------------------------------

export function General(v, cx) {
  const chrome = (v.mcp?.servers ?? []).find((s) => /chrome/i.test(s.name));
  const chromeState = !v.mcp ? ["dim", "checking claude mcp list…"]
    : !chrome ? ["warn", "Claude in Chrome MCP not set up. Add it in MCP."]
    : chrome.state === "connected" ? ["ok", `Connected (${chrome.name})`] : ["warn", `${chrome.name}: ${chrome.statusText}`];
  const lin = v.linear;
  return page("General", "How this app is wired to the tools around it.",
    section("Browser",
      Field("Browser", "Your Chrome, driven by the Claude in Chrome MCP"),
      Field("Status", status(...chromeState)),
      note("There is no browser inside Herdr: localhost links, PR previews and report links open in Chrome.")),
    section("Linear",
      Field("Account", status(lin === undefined ? "dim" : lin ? "ok" : "warn", lin === undefined ? "checking…" : lin ? `Signed in to ${lin}` : "Not connected. Connect it from New workspace > Linear issue.")),
      Field("Open issues", "⌘L (herdr-linear)")),
    section("Skills and MCP",
      Field("Manager", "skillshare, config in ~/.config/skillshare/config.yaml", { mono: true }),
      Field("Updates", "automatic check off"),
      note("Every change is previewed (dry run) and written only when you press Apply.")));
}

// ---- Workspaces / Scripts (read from .herdr/project.json) ---------------------------------

async function loadProject(v) {
  if (!v.root) return null;
  const t = await readTextFile(`${v.root}/.herdr/project.json`).catch(() => null);
  return t === null ? { missing: true } : parse(t) ?? { invalid: true };
}

function projectPage(title, sub, v, build) {
  if (!v.root) return page(title, sub, note("Open a project to see its settings."));
  const p = v.project;
  if (!p) return page(title, sub, note("Loading…"));
  if (p.missing || p.invalid) return page(title, sub, note(p.invalid ? ".herdr/project.json is not valid JSON." : "No .herdr/project.json in this project yet."));
  return page(title, sub, ...build(p),
    h_flex().gap(10).items_center()
      .child(Btn("open-pj", "Open project.json", () => run("tab.new", { name: "project.json", mod: "pm-md", props: { path: ".herdr/project.json", root: v.root } }), { small: true }))
      .child(note("Project changes go through a PR.")));
}

export const Workspaces = (v) => projectPage("Workspaces", `${v.rootName ?? ""}: what a new workspace starts with.`, v, (p) => [
  section("Files and base", Field("Base branch", p.base ?? "main", { mono: true }), Field("Copy", (p.copy ?? []).join(", ") || "nothing", { mono: true }), Field("Ports", `blocks of ${p.ports ?? 10}`, { mono: true })),
]);

export const Scripts = (v) => projectPage("Scripts", `${v.rootName ?? ""}: setup, run and archive.`, v, (p) => [
  section("Setup", Field("setup", p.setup ?? "none", { mono: true })),
  section("Run tabs", ...Object.entries(p.run ?? {}).map(([k, c]) => Field(k, c, { mono: true })), ...(Object.keys(p.run ?? {}).length ? [] : [note("none")])),
  section("Archive", Field("archive", p.archive ?? "none", { mono: true })),
]);

// ---- Models ------------------------------------------------------------------------------

const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"]];
const DEFAULT_MODELS = { plan: "claude-fable-5-2", handoff: "claude-opus-5-5", routines: "claude-sonnet-5-5" };

export function Models(v) {
  const cur = { ...DEFAULT_MODELS, ...(shared("pm.models") ?? {}) };
  const pick = (key, label, desc) => section(label, note(desc),
    h_flex().gap(4).children(MODELS.map(([id, name]) => h_flex().id(`m-${key}-${id}`).h(28).px(12).items_center().rounded(7).cursor_pointer()
      .text_size(SIZE.body).bg(cur[key] === id ? C.raised : "#00000000").text_color(cur[key] === id ? C.text : C.muted)
      .hover((s) => s.text_color(C.text)).on_click((_e, cx) => { setShared("pm.models", { ...cur, [key]: id }); cx.notify(); }).child(name))));
  return page("Models", "Default model for each moment. Kept in shared state pm.models.",
    pick("plan", "Plan", "Claude's first pass in Plan mode."),
    pick("handoff", "Hand off", "The model that executes an approved plan (latest Opus by default)."),
    pick("routines", "Routines", "Unattended runs."));
}

// ---- Sounds ------------------------------------------------------------------------------

const SILENT = "sounds/silent.mp3";
const EVENTS = [
  { key: "blocked", label: "Claude needs you", sub: "A question, a permission or a plan is waiting", sound: "blocked", file: true },
  { key: "done", label: "Run finished", sub: "Claude finished while you were elsewhere", sound: "done", file: true },
  { key: "ci", label: "CI failed", sub: "Toast and notification; sound only if on", sound: "blocked" },
  { key: "merged", label: "PR merged", sub: "A soft confirmation", sound: "done" },
];

export function Sounds(v, cx) {
  const s = v.settingsJson?.sounds ?? {};
  const extra = { ci: true, merged: true, ...(shared("pm.sounds") ?? {}) };
  const isOn = (e) => (e.file ? !String(s[e.key] ?? "").endsWith("silent.mp3") : extra[e.key]);
  const toggle = (e, cx) => {
    if (e.file) patchJson(`${appHome()}/settings.json`, (d) => { d.sounds = { ...(d.sounds ?? {}) }; if (isOn(e)) d.sounds[e.key] = SILENT; else delete d.sounds[e.key]; }).then(() => v.loadSettings(cx), (err) => notify({ title: "settings.json", body: String(err), level: "error" }));
    else { setShared("pm.sounds", { ...extra, [e.key]: !extra[e.key] }); cx.notify(); }
  };
  const master = s.enabled !== false;
  return page("Sounds", "Default sounds for now; you will pick your own later.",
    section("Master",
      h_flex().gap(12).items_center().child(div().flex_1().text_size(SIZE.body).text_color(C.text).child("Play sounds"))
        .child(Toggle("snd-master", master, (_e, cx) => patchJson(`${appHome()}/settings.json`, (d) => { d.sounds = { ...(d.sounds ?? {}), enabled: !master }; }).then(() => v.loadSettings(cx))))),
    section("Events", ...EVENTS.map((e) => h_flex().gap(12).items_center().h(44).border_b(1).border_color(C.line1)
      .child(v_flex().flex_1().gap(2).child(div().text_size(SIZE.body).text_color(C.text).child(e.label)).child(div().text_size(SIZE.meta).text_color(C.muted).child(e.sub)))
      .child(Btn(`snd-play-${e.key}`, [icon("play", 10, C.muted), "Play"], () => playSound(e.sound), { small: true }))
      .child(Toggle(`snd-${e.key}`, isOn(e), (_e, cx) => toggle(e, cx), !master)))),
    note("Custom sounds: put MP3 files in ~/.config/herdr-app/sounds and set sounds.blocked / sounds.done in settings.json."));
}

// ---- Appearance --------------------------------------------------------------------------

export function Appearance(v) {
  const st = settings();
  const zoom = Number(st.zoom ?? 1);
  const cur = String(st.theme ?? "");
  return page("Appearance", "Text size and theme.",
    section("Text size", h_flex().gap(10).items_center()
      .child(Btn("zoom-out", "−", () => run("app.zoom_out"), { small: true }))
      .child(div().w(52).text_center().font_family(MONO).text_color(C.text).child(`${Math.round(zoom * 100)}%`))
      .child(Btn("zoom-in", "+", () => run("app.zoom_in"), { small: true }))
      .child(Btn("zoom-reset", "Reset", () => run("app.zoom_reset"), { small: true }))),
    section("Theme", h_flex().gap(6).flex_wrap().children(themes().map((t) => h_flex().id(`th-${t.name}`).h(28).px(12).items_center().rounded(7).cursor_pointer()
      .bg(t.name === cur ? C.raised : "#00000000").text_color(t.name === cur ? C.text : C.muted).text_size(SIZE.body).hover((s) => s.text_color(C.text))
      .on_click(() => run("app.theme", { name: t.name })).child(t.name))),
    note("The pm layout brings its own warm look; the theme applies to terminals and other layouts.")));
}

export { loadProject };
