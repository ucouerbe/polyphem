// @ts-check
// Routine report helpers (spec 4.1): frontmatter, questions, run line. Pure.

const unq = (v) => v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").replace(/\s+#.*$/, "").trim();

/** {front, body} of a report. */
export function parseReport(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  const front = {};
  if (!m) return { front, body: text };
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) front[line.slice(0, i).trim()] = unq(line.slice(i + 1)); }
  return { front, body: m[2] };
}

const QRE = /(^|\n)(##\s+Questions for you[ \t]*\n)([\s\S]*?)(?=\n##\s|\s*$)/;

/** Body split around the questions section: {before, questions: ["..."], after}. */
export function splitReport(body) {
  const m = QRE.exec(body);
  if (!m) return { before: body, questions: [], after: "" };
  const questions = m[3].split("\n").map((l) => /^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/.exec(l)).filter(Boolean).map((x) => x[1]);
  const before = body.slice(0, m.index) + (questions.length ? "" : m[0].slice(0, 0));
  return { before: before.replace(/\s+$/, ""), questions, after: body.slice(m.index + m[0].length).replace(/^\s+/, "") };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Friday, November 14 · 9:02" from run: 2026-11-14T09:02 (or the file date). */
export function runLine(run, fileDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{1,2}):(\d{2}))?/.exec(run || fileDate || "");
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${m[4] ? ` · ${+m[4]}:${m[5]}` : ""}`;
}

/** Message sent to the run's Claude from the answers. */
export function answersMessage(questions, answers, extra) {
  const lines = [];
  questions.forEach((q, i) => { if (answers[i]) lines.push(`${i + 1}. ${q}\n   My answer: ${answers[i]}`); });
  if (extra) lines.push(extra);
  return `Here are my answers. Update the report and the changes accordingly.\n\n${lines.join("\n")}`;
}
