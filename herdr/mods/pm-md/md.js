// @ts-check
// Small Markdown to HTML converter for "Copy as rich text" (headings, lists, quotes, code, tables, inline).

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[+i]);
}

export function toHtml(md) {
  const lines = md.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const out = [];
  let i = 0;
  const isBlank = (l) => !l.trim();
  const special = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*([-*_])(\s*\3){2,}\s*$|\|)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    let m;
    if ((m = /^```(\w*)/.exec(l))) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${toHtml(buf.join("\n"))}</blockquote>`); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s/.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
        const mm = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        items.push({ depth: Math.floor(mm[1].length / 2), text: mm[2] }); i++;
      }
      // nested lists by indent
      const tag = ordered ? "ol" : "ul";
      let html = `<${tag}>`, depth = 0;
      for (const it of items) {
        while (depth < it.depth) { html += `<${tag}>`; depth++; }
        while (depth > it.depth) { html += `</${tag}>`; depth--; }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
        html += `<li>${task ? (task[1] === " " ? "☐ " : "☑ ") + inline(task[2]) : inline(it.text)}</li>`;
      }
      while (depth > 0) { html += `</${tag}>`; depth--; }
      out.push(html + `</${tag}>`); continue;
    }
    if (/^\|/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(l); i += 2;
      let html = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && /^\|/.test(lines[i])) html += "<tr>" + cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      out.push(html + "</tbody></table>"); continue;
    }
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && (buf.length === 0 || !special(lines[i]))) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

/**
 * Splits Markdown into editable blocks: front matter, fenced code, and runs of non-blank lines.
 * Each block keeps its [start, end) offsets in the source so an edit replaces exactly that slice.
 * @param {string} text
 * @returns {{ start: number, end: number, src: string, kind: "front" | "code" | "text" }[]}
 */
export function mdBlocks(text) {
  const out = [];
  const lines = text.split("\n");
  let pos = 0, i = 0;
  const lineEnd = (k) => { let p = 0; for (let j = 0; j <= k; j++) p += lines[j].length + 1; return Math.min(p - 1, text.length); };
  const offsets = []; for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
  const push = (a, b, kind) => out.push({ start: offsets[a], end: lineEnd(b), src: text.slice(offsets[a], lineEnd(b)), kind });
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) { push(0, close, "front"); i = close + 1; }
  }
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)/.exec(lines[i]);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[1])) j++;
      push(i, Math.min(j, lines.length - 1), "code"); i = j + 1; continue;
    }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].trim() && !/^\s*(```|~~~)/.test(lines[j + 1])) j++;
    push(i, j, "text"); i = j + 1;
  }
  return out;
}
