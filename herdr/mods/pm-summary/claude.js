// @ts-check
// Talking to a Claude Code terminal through herdr-core: its screen, its keys,
// its session file. Everything here is plain async functions; the view owns state.

import { hc, exec, home, readTextFile, writeTextFile } from "herdr";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];
/** Hand-off target: the latest Opus. */
export const HANDOFF = MODELS[0];

export function prettyModel(id) {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(id ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : (id ?? "");
}

export const projectDir = (cwd) => `${home()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** The terminal as herdr-core sees it: foreground pid and the agent's report ({state, kind, msg}). */
export async function info(term) {
  const r = await hc(["get", term]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/**
 * The transcript this terminal writes. Claude Code keeps ~/.claude/sessions/<pid>.json with the
 * live sessionId (it changes on /clear and --resume), and the file lives under the project folder
 * of the cwd it was first started in, so look in every project folder. Fallback: the newest
 * transcript for the cwd.
 */
export async function sessionFile(pid, cwd) {
  let sid = null;
  if (pid) {
    const js = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
    try { sid = js ? JSON.parse(js).sessionId : null; } catch { sid = null; }
  }
  if (sid) {
    const r = await exec("sh", ["-c", 'ls "$1"/*/"$2".jsonl 2>/dev/null | head -1', "sh", `${home()}/.claude/projects`, sid]);
    const f = r.stdout.trim();
    if (f) return { file: f, sid };
  }
  if (!cwd) return null;
  const dir = projectDir(cwd);
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && ls -t -- *.jsonl 2>/dev/null | head -1', "sh", dir]);
  const latest = r.stdout.trim();
  return latest ? { file: `${dir}/${latest}`, sid: latest.replace(/\.jsonl$/, "") } : null;
}

export async function screen(term, lines = 40) {
  const r = await hc(["read", term, "--lines", String(lines)]);
  return r.code === 0 ? r.stdout : "";
}

const MODES = [
  [/plan mode on/i, "plan"], [/accept edits on/i, "acceptEdits"], [/auto mode on/i, "auto"],
  [/bypass permissions on/i, "bypassPermissions"], [/manual mode on/i, "default"],
];
/** The permission mode Claude Code shows in its footer, or null when the footer is not on screen. */
export function modeOf(text) {
  const tail = text.split("\n").filter((l) => !l.startsWith("[hc]")).slice(-6).join("\n");
  for (const [re, m] of MODES) if (re.test(tail)) return m;
  return /shift\+tab to cycle/.test(tail) ? "default" : null;
}

/** The numbered choices of the dialog on screen (the last "1." block wins). */
export function choices(text) {
  let out = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    if (m[1] === "1") out = [];
    out.push({ key: m[1], label: m[2] });
  }
  return out;
}

export const keys = (term, ...k) => hc(["keys", term, ...k]);
/** Paste and press Enter. `force`: also while a dialog is open (it answers it). */
export const send = (term, text, force = false) => hc(["send", ...(force ? ["--force"] : []), term, text]);

/** Cycle shift+tab until the footer shows `want`. Never lands on bypass: it isn't in the cycle unless enabled. */
export async function setMode(term, want, cx) {
  for (let i = 0; i < 10; i++) {
    const m = modeOf(await screen(term, 8));
    if (m === want) return true;
    // No footer: a dialog is open, where shift+tab would answer it. Wait instead.
    if (m === null) { await cx.sleep(400); continue; }
    await keys(term, "shift+tab");
    await cx.sleep(350);
  }
  return modeOf(await screen(term, 8)) === want;
}

const SETTINGS = () => `${home()}/.claude/settings.json`;
const KEPT = ["model", "effortLevel", "fastMode"];
const parse = (text) => { try { return JSON.parse(text ?? "{}"); } catch { return undefined; } };

/**
 * `/model`, `/effort` and `/fast` switch this session, but Claude Code also saves them as the
 * defaults for new sessions in ~/.claude/settings.json. Put the person's defaults back as they were.
 * settings.json is written by Claude Code as 2-space JSON, so re-serializing keeps its shape.
 */
async function restoreDefaults(before) {
  const was = parse(before);
  if (!was) return;
  const now = await readTextFile(SETTINGS()).catch(() => null);
  const cur = parse(now);
  if (now == null || !cur || now === before) return;
  let changed = false;
  for (const k of KEPT) {
    if (JSON.stringify(cur[k]) === JSON.stringify(was[k])) continue;
    if (k in was) cur[k] = was[k]; else delete cur[k];
    changed = true;
  }
  if (changed) await writeTextFile(SETTINGS(), `${JSON.stringify(cur, null, 2)}\n`, now).catch(() => null);
}

/** Runs a slash command that changes a session setting, waits for its confirmation, restores the defaults. */
async function sessionSetting(term, command, done, cx, confirm) {
  const before = await readTextFile(SETTINGS()).catch(() => null);
  await send(term, command);
  for (let i = 0; i < 10; i++) {
    await cx.sleep(300);
    const s = await screen(term, 24);
    if (confirm && confirm.test(s)) { await keys(term, "1"); await cx.sleep(400); break; }
    if (done.test(s)) break;
  }
  await cx.sleep(300);
  await restoreDefaults(before);
}

/** Switch the session's model with /model, confirming Claude Code's "Switch model?" prompt. */
export const setModel = (term, id, cx) => sessionSetting(term, `/model ${id}`, /Set model to/, cx, /Switch model\?/);

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Thinking effort for this session: low | medium | high | xhigh | max. */
export const setEffort = (term, level, cx) => sessionSetting(term, `/effort ${level}`, /[Ee]ffort/, cx);
/** Fast mode on or off for this session. */
export const setFast = (term, on, cx) => sessionSetting(term, `/fast ${on ? "on" : "off"}`, /[Ff]ast mode/, cx);

/** Wait until the terminal reports something other than `state` (or the timeout). */
export async function waitLeave(term, state, cx, ms = 8000) {
  for (let t = 0; t < ms; t += 300) {
    const i = await info(term);
    if ((i?.status?.state ?? null) !== state) return i;
    await cx.sleep(300);
  }
  return null;
}

/** The repo root (worktree) a folder belongs to, or null. */
export async function toplevel(cwd) {
  if (!cwd) return null;
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

/** The main checkout of the repo a folder belongs to, or null. */
export async function mainCheckout(cwd) {
  if (!cwd) return null;
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const d = r.stdout.trim();
  return d.endsWith("/.git") ? d.slice(0, -5) : null;
}

/** Writes PLAN.md at the worktree root (rule: PLAN.md always lives in the worktree). */
export async function writePlan(root, plan) {
  const path = `${root}/PLAN.md`;
  const now = await readTextFile(path).catch(() => null);
  const text = plan.endsWith("\n") ? plan : `${plan}\n`;
  if (now === text) return path;
  await writeTextFile(path, text, now);
  return path;
}
