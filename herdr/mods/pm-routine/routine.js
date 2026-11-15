// @ts-check
// routine.md model (spec 4.1), cron helpers and presets. Pure: no host imports (tested with node).

export const COLORS = [
  ["ember", "#E0874F"], ["amber", "#E3B341"], ["green", "#7FBF7F"],
  ["blue", "#6C9BD1"], ["violet", "#9C86C9"], ["stone", "#9A8F7E"],
];
export const colorHex = (name) => (COLORS.find((c) => c[0] === name) ?? COLORS[0])[1];

export const MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
];
export const modelLabel = (id) => MODELS.find((m) => m.id === id)?.label ?? id;
/** Thinking effort passed as `claude --effort`; "" = Claude Code's default. */
export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
export const effortLabel = (e) => e || "default";

export const emptyRoutine = () => ({
  name: "", icon: "clock", color: "ember", schedule: "0 9 * * *", model: "claude-sonnet-5-5", effort: "", mcp: [],
  context_reports: 3, workspace: "worktree", catch_up: 120, paused: false, body: "",
});

export const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const unq = (v) => {
  v = v.trim();
  if (/^"/.test(v)) return v.replace(/^"/, "").replace(/".*$/, "");
  if (/^'/.test(v)) return v.replace(/^'/, "").replace(/'.*$/, "");
  return v.replace(/\s+#.*$/, "").trim();
};

/** Parses a routine.md; unknown keys are ignored, missing ones take defaults. */
export function parseRoutine(text) {
  const r = emptyRoutine();
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  if (!m) { r.body = text; return r; }
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim(), v = unq(line.slice(i + 1));
    if (k === "name" || k === "icon" || k === "color" || k === "schedule" || k === "model" || k === "workspace") r[k] = v;
    else if (k === "effort") r.effort = EFFORTS.includes(v) ? v : "";
    else if (k === "mcp") r.mcp = v.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (k === "context_reports" || k === "catch_up") r[k] = Number.isFinite(Number(v)) && v !== "" ? Number(v) : r[k];
    else if (k === "paused") r.paused = v === "true";
  }
  r.body = m[2].replace(/^\n+/, "").replace(/\s+$/, "");
  return r;
}

export function serializeRoutine(r) {
  const q = (s) => (/[:#"'\[\]{}*]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);
  const lines = [
    "---",
    `name: ${q(r.name)}`,
    `icon: ${r.icon}              # Lucide icon name`,
    `color: ${r.color}              # ember | amber | green | blue | violet | stone`,
    `schedule: ${JSON.stringify(r.schedule)}       # cron`,
    `model: ${r.model}`,
    ...(r.effort ? [`effort: ${r.effort}             # low | medium | high | xhigh | max`] : []),
    `mcp: [${r.mcp.join(", ")}]`,
    `context_reports: ${r.context_reports}`,
    `workspace: ${r.workspace}`,
    `catch_up: ${r.catch_up}`,
    `paused: ${r.paused}`,
    "---",
    r.body.replace(/\s+$/, ""),
    "",
  ];
  return lines.join("\n");
}

// ---- cron --------------------------------------------------------------------

function field(src, min, max) {
  const out = new Set();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min, hi = max;
    if (m[1] !== "*") { const [a, b] = m[1].split("-").map(Number); lo = a; hi = b ?? (m[2] ? max : a); }
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** {min,hour,dom,mon,dow} sets, or null when invalid. dow 7 counts as 0. */
export function parseCron(s) {
  const a = s.trim().split(/\s+/);
  if (a.length !== 5) return null;
  const [min, hour, dom, mon, dow] = [field(a[0], 0, 59), field(a[1], 0, 23), field(a[2], 1, 31), field(a[3], 1, 12), field(a[4], 0, 7)];
  if (!min || !hour || !dom || !mon || !dow) return null;
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { min, hour, dom, mon, dow, domAny: a[2] === "*", dowAny: a[4] === "*" };
}

/** The next `n` run times (Date) after `from`, scanning at most `days` days. */
export function nextRuns(cron, n, from = new Date(), days = 400) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  if (!c) return [];
  const out = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from.getTime() + days * 86400000;
  while (out.length < n && d.getTime() < end) {
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(d.getDay()) : c.dowAny ? c.dom.has(d.getDate())
      : c.dom.has(d.getDate()) || c.dow.has(d.getDay());
    if (!c.mon.has(d.getMonth() + 1) || !dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (c.min.has(d.getMinutes())) out.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");
export const fmtTime = (d) => `${d.getHours()}:${p2(d.getMinutes())}`;
export const fmtDay = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;

// ---- presets -----------------------------------------------------------------

export const PRESETS = [
  { id: "day", label: "Every day", dow: "*" },
  { id: "weekdays", label: "Weekdays", dow: "1-5" },
  { id: "monday", label: "Every Monday", dow: "1" },
  { id: "cron", label: "cron" },
];

/** {preset, time:"HH:MM"|null} for a cron string. */
export function presetOf(cron) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(cron.trim());
  if (!m || +m[1] > 59 || +m[2] > 23) return { preset: "cron", time: null };
  const dow = m[3];
  return { preset: dow === "*" ? "day" : dow === "1-5" ? "weekdays" : "monday", time: `${p2(+m[2])}:${p2(+m[1])}` };
}

export function cronFor(preset, time) {
  const p = PRESETS.find((x) => x.id === preset);
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!p?.dow || !m || +m[1] > 23 || +m[2] > 59) return null;
  return `${+m[2]} ${+m[1]} * * ${p.dow}`;
}

/** Same minute within the next `days` days as another routine: [{other, when}]. */
export function collisions(cron, others, days = 7, from = new Date()) {
  const mine = nextRuns(cron, 60, from, days).map((d) => d.getTime());
  const set = new Set(mine);
  const out = [];
  for (const o of others) {
    const hit = nextRuns(o.schedule ?? "", 60, from, days).find((d) => set.has(d.getTime()));
    if (hit) out.push({ other: o.title ?? o.name, when: hit });
  }
  return out;
}

/** Cron with the time moved by `minutes` (keeps the day pattern when it is a preset). */
export function shiftCron(cron, minutes) {
  const { preset, time } = presetOf(cron);
  if (preset === "cron" || !time) return null;
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + minutes;
  if (t < 0 || t >= 1440) return null;
  return cronFor(preset, `${p2(Math.floor(t / 60))}:${p2(t % 60)}`);
}

// ---- report (spec 4.1) --------------------------------------------------------

/** {front:{...}, body} of a report. */
export function parseReport(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  const front = {};
  if (!m) return { front, body: text };
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) front[line.slice(0, i).trim()] = unq(line.slice(i + 1)); }
  return { front, body: m[2] };
}

/** Numbered questions under "## Questions for you": ["Keep the old OKR...?", ...]. */
export function reportQuestions(text) {
  const { body } = parseReport(text);
  const m = /(?:^|\n)##\s+Questions for you\s*\n([\s\S]*?)(?=\n##\s|\n*$)/.exec(body);
  if (!m) return [];
  return m[1].split("\n").map((l) => /^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/.exec(l)).filter(Boolean).map((x) => x[1]);
}
