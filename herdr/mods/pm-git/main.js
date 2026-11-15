// @ts-check
// Git panel for the focused workspace (screen 03), plus three extra modes of the same mod:
//   props.view "diff" | "file"  : a tab showing one file's unified diff or content
//   overlay with no view        : runner for Undo / Restore (props.restore or shared("pm.undo"))
// DEV (dev.json may also set "tab": "changes|files|checks"): set localStorage "pm.git.dev" (or write mods/pm-git/dev.json {"state": "..."}) to one of
//   none | failing | ready | blocked | merged  to feed canned gh JSON. Off by default.
// Commands (keys.json "pm-git.<cmd>" or `herdr-app do pm-git.<cmd>`): create-pr, archive, fix-ci, merge, tab:changes|files|checks.
// Shared: shared("pm.archived") = [{repo, main, name, branch, pr, mergedAt, path, sha}].

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import {
  spaces, panes, agents, focused, exec, hc, home, readTextFile, watchFolder, run, openOverlay,
  closeOverlay, notify, props, shared, setShared, layout, appHome, nextCommand,
} from "herdr";
import { C, SIZE, MONO, icon, DiffPill } from "./ui.js";

// ---- helpers -----------------------------------------------------------------

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - ((s.length - 1) % 4) + 4));
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

async function git(cwd, args, on, timeout) {
  try {
    const r = await exec("git", args, { cwd, on, ...(timeout ? { timeout } : {}) });
    return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
  } catch (e) { return { ok: false, out: "", err: String(e) }; }
}
async function gh(cwd, args, on, timeout = 25000) {
  try {
    const r = await exec("gh", args, { cwd, on, timeout });
    return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim(), code: r.code };
  } catch (e) { return { ok: false, out: "", err: String(e), code: -1 }; }
}
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** Unified diff lines for one path of a worktree (vs HEAD), or its content as additions when untracked. */
async function diffLines(root, on, path, status) {
  const head = await git(root, [...READ, "rev-parse", "--verify", "HEAD"], on);
  const tracked = (await git(root, [...READ, "ls-files", "--error-unmatch", "--", path], on)).ok;
  if (status === "A" && !tracked || !tracked) {
    const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
    if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
    if (text.includes("\0")) return ["Binary file · no text diff"];
    const n = countLines(text);
    return [`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
  }
  const r = await git(root, [...READ, "diff", ...(head.ok ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], on);
  if (!r.ok) throw new Error(r.err);
  const all = r.out.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? ["No text diff available (no changes or binary)"] : all.slice(first);
}
const clip = (lines) => lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));

// ---- archived store (localStorage of pm-git, mirrored in shared("pm.archived")) ---

function loadArchived() {
  const s = shared("pm.archived");
  if (Array.isArray(s)) return s;
  try { return JSON.parse(localStorage.getItem("pm.archived") ?? "[]"); } catch { return []; }
}
function saveArchived(list) {
  try { localStorage.setItem("pm.archived", JSON.stringify(list)); } catch { /* storage unavailable */ }
  setShared("pm.archived", list);
}

/** Recreates a worktree from its branch (or its last commit when the branch is gone). Returns "" or an error. */
async function restoreWorktree(job) {
  const path = job.path || `${home()}/.herdr/worktrees/${job.repo}/${slug(job.name)}`;
  const main = job.main;
  if (!main) return "Unknown repository.";
  const has = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${job.branch}`])).ok;
  const add = has ? ["worktree", "add", path, job.branch] : job.sha ? ["worktree", "add", "-b", job.branch, path, job.sha] : null;
  if (!add) return `Branch ${job.branch} is gone.`;
  const r = await git(main, add, null, 120000);
  if (!r.ok) return r.err || "git worktree add failed.";
  saveArchived(loadArchived().filter((a) => !(a.main === job.main && a.branch === job.branch)));
  run("space.new", { folder: path });
  return "";
}

/** Archive = archive script, close the space, `git worktree remove`; branch ref kept for Undo/Restore.
 *  Dirty without `force`: opens the confirm overlay (command `confirmCommand`) and returns "". */
const DIRTY = "\0dirty";
async function archiveWorktree({ root, on, branch: knownBranch, pr = null, merged = false, sha = "", base = "main", force = false, confirmCommand = { name: "pm-git.archive-force" } }) {
  const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on)).out.trim();
  const gitDir = (await git(root, ["rev-parse", "--path-format=absolute", "--git-dir"], on)).out.trim();
  if (!common || common === gitDir) return "This is the main checkout, not a workspace: nothing to archive.";
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  const dirty = (await git(root, [...READ, "status", "--porcelain"], on)).out.split("\n").filter(Boolean);
  if (dirty.length && !force) { archiveConfirm(dirty, confirmCommand); return DIRTY; }
  const branch = knownBranch || (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], on)).out.trim();
  const tip = sha || (await git(root, ["rev-parse", "HEAD"], on)).out.trim();
  const cfg = parse((await readTextFile(`${root}/.herdr/project.json`, { on }).catch(() => null)) ?? "null");
  if (cfg?.archive) await exec("sh", ["-c", cfg.archive], { cwd: root, on, timeout: 60000 }).catch(() => null);
  const inside = (p) => p === root || p?.startsWith(`${root}/`);
  const space = spaces().find((s) => s.active && inside(location().cwd)) ?? spaces().find((s) => s.folder && inside(s.folder));
  if (space) run("space.close", { id: space.id, confirmed: true });
  // The closed space's shells may need a moment to release the folder.
  let rm = { ok: false, err: "" };
  for (let i = 0; i < 5 && !rm.ok; i++) {
    if (i) await exec("sleep", ["0.5"]).catch(() => null);
    rm = await git(main, ["worktree", "remove", ...(dirty.length ? ["--force"] : []), root], on, 120000);
  }
  if (!rm.ok) return `git worktree remove failed: ${rm.err}`;
  const name = branch.split("/").pop();
  const rec = { repo: main.split("/").pop(), main, name, branch, pr, mergedAt: merged ? new Date().toISOString() : null, path: root, sha: tip };
  saveArchived([rec, ...loadArchived().filter((a) => !(a.main === main && a.branch === branch))]);
  setShared("pm.undo", { ...rec, until: Date.now() + 10000 });
  setShared("pm.archive.pending", null);
  notify({
    title: merged ? `${name} merged and archived` : `${name} archived`,
    body: merged ? `PR #${pr} · squashed into ${base} · click to Undo (10 s)` : "Click to Undo (10 s)",
    level: "success", timeout: 10000, action: { name: "mod.open", args: { name: "pm-git" } },
  });
  return "";
}
function archiveConfirm(files, command) {
  openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 240, props: {
    title: "Archive with uncommitted changes?",
    detail: `These will be lost:\n${files.slice(0, 8).join("\n")}${files.length > 8 ? `\n… and ${files.length - 8} more` : ""}`,
    command,
  } });
}

// ---- PR summary for the sidebar (shared("pm.pr")[path]) ------------------------------

function publishPr(path, on, pr, checks) {
  if (on) return; // paths of other machines are not sidebar paths
  let next = null;
  if (pr) {
    const b = (checks ?? []).map((c) => c.bucket);
    next = {
      number: pr.number,
      state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
      ci: b.some((x) => x === "fail" || x === "cancel") ? "failing" : b.includes("pending") ? "pending" : b.length ? "passing" : "none",
      review: pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes" : pr.reviewDecision === "REVIEW_REQUIRED" ? "required" : "none",
    };
  }
  const map = shared("pm.pr") ?? {};
  if (JSON.stringify(map[path] ?? null) === JSON.stringify(next)) return;
  const copy = { ...map };
  if (next) copy[path] = next; else delete copy[path];
  setShared("pm.pr", copy);
}

// ---- DEV canned gh data ---------------------------------------------------------

const CK = (name, bucket) => ({ name, bucket, link: "https://example.com/run" });
const CANNED = {
  none: { pr: null, checks: [] },
  failing: {
    pr: { number: 128, title: "Fix SSO redirect after login", url: "https://github.com/acme/acme-web/pull/128", headRefName: "login-fix", baseRefName: "main", mergeable: "MERGEABLE", state: "OPEN", reviewDecision: "", reviews: [{ author: { login: "ana" }, state: "COMMENTED", submittedAt: "2026-11-14T09:00:00Z" }], comments: [{ body: "a" }, { body: "b" }] },
    checks: [CK("build", "pass"), CK("lint", "pass"), CK("e2e", "fail")],
  },
  ready: {
    pr: { number: 128, title: "Fix SSO redirect after login", url: "https://github.com/acme/acme-web/pull/128", headRefName: "login-fix", baseRefName: "main", mergeable: "MERGEABLE", state: "OPEN", reviewDecision: "APPROVED", reviews: [{ author: { login: "ana" }, state: "APPROVED", submittedAt: "2026-11-14T09:00:00Z" }, { author: { login: "bo" }, state: "APPROVED", submittedAt: "2026-11-14T10:00:00Z" }], comments: [] },
    checks: [CK("build", "pass"), CK("lint", "pass"), CK("e2e", "pass")],
  },
  blocked: {
    pr: { number: 128, title: "Fix SSO redirect after login", url: "https://github.com/acme/acme-web/pull/128", headRefName: "login-fix", baseRefName: "main", mergeable: "MERGEABLE", state: "OPEN", reviewDecision: "REVIEW_REQUIRED", reviews: [], comments: [] },
    checks: [CK("build", "pass"), CK("lint", "pass"), CK("e2e", "pending")],
  },
  merged: {
    pr: { number: 128, title: "Fix SSO redirect after login", url: "https://github.com/acme/acme-web/pull/128", headRefName: "login-fix", baseRefName: "main", mergeable: "UNKNOWN", state: "MERGED", reviewDecision: "APPROVED", reviews: [], comments: [] },
    checks: [CK("build", "pass")],
  },
};
async function devState() {
  let s = null, tab = null;
  try { s = localStorage.getItem("pm.git.dev"); } catch { /* none */ }
  if (!s) {
    const t = await readTextFile(`${appHome()}/mods/pm-git/dev.json`).catch(() => null);
    const d = parse(t ?? "null");
    s = d?.state ?? null; tab = d?.tab ?? null;
  }
  return s && CANNED[s] ? { ...CANNED[s], tab } : null;
}

// ---- gh data -------------------------------------------------------------------

function fromRollup(rollup) {
  return (rollup ?? []).map((c) => {
    if (c.__typename === "StatusContext") {
      const bucket = c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail";
      return { name: c.context, bucket, link: c.targetUrl };
    }
    const bucket = c.status !== "COMPLETED" ? "pending"
      : c.conclusion === "SUCCESS" ? "pass"
      : c.conclusion === "SKIPPED" || c.conclusion === "NEUTRAL" ? "skipping"
      : c.conclusion === "CANCELLED" ? "cancel" : "fail";
    return { name: c.name, bucket, link: c.detailsUrl };
  });
}

async function loadPr(root, on) {
  const canned = await devState();
  if (canned) return { pr: canned.pr, checks: canned.checks, dev: true, tab: canned.tab };
  const fields = "reviews,comments,statusCheckRollup,url,number,title,headRefName,baseRefName,mergeable,state,reviewDecision,isDraft";
  const [view, checks] = await Promise.all([
    gh(root, ["pr", "view", "--json", fields], on),
    gh(root, ["pr", "checks", "--json", "name,bucket,link,state"], on),
  ]);
  if (!view.ok) {
    if (/no pull requests? found/i.test(view.err)) return { pr: null, checks: [] };
    const noRemote = /no git remotes|none of the git remotes|not a github|could not determine|no default remote/i.test(view.err);
    return { error: noRemote ? "No GitHub remote" : view.err.split("\n")[0] || "gh failed", noRemote };
  }
  const pr = parse(view.out);
  if (!pr) return { error: "Unreadable gh output" };
  // `gh pr checks` exits 8 while checks are pending but still prints JSON.
  const list = parse(checks.out);
  return { pr, checks: Array.isArray(list) && list.length ? list : fromRollup(pr.statusCheckRollup) };
}

/** What blocks a merge, and the summary used by the banner and Checks tab. */
function judge(pr, checks) {
  const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  const pending = checks.filter((c) => c.bucket === "pending");
  const latest = {};
  for (const r of [...(pr.reviews ?? [])].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    latest[r.author?.login ?? "?"] = r.state;
  }
  const approvals = Object.values(latest).filter((s) => s === "APPROVED").length;
  const changes = Object.values(latest).filter((s) => s === "CHANGES_REQUESTED").length;
  const conflicts = pr.mergeable === "CONFLICTING";
  const blockers = [];
  if (failing.length) blockers.push("CI failing");
  if (pending.length) blockers.push("Checks running");
  if (changes || pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("Changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") blockers.push("Review required");
  if (conflicts) blockers.push("Merge conflicts");
  if (pr.isDraft) blockers.push("Draft");
  return { failing, pending, approvals, changes, conflicts, blockers, comments: (pr.comments ?? []).length };
}

const TINT = { neutral: C.surface, red: "#241713", green: "#151D15", brown: "#211A12" };
const STATUS_ICON = {
  fail: { icon: "x", color: C.red }, cancel: { icon: "x", color: C.red },
  pending: { icon: "circle-half", color: C.ember }, pass: { icon: "check", color: C.green },
  skipping: { icon: "ring", color: C.dim },
};

// ---- the view ------------------------------------------------------------------

export default class PmGit extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.uid = Math.random().toString(36).slice(2, 7);
    // Runner only for an overlay opened without a view (toast click, Restore). A layout copy never has props().overlay.
    this.mode = p.view ? "viewer" : p.overlay ? "runner" : "panel";
    this.rows = []; this.diffWidth = 0; this.handle = cx.focus_handle();
    if (this.mode === "viewer") return this.initViewer(p, cx);
    if (this.mode === "runner") return this.initRunner(p, cx);
    this.files = []; this.message = ""; this.tab = "changes"; this.tree = []; this.expanded = new Set();
    this.pr = undefined; this.checks = []; this.menu = false; this.busyLabel = null; this.base = "main";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // gh is polled gently, and only while this panel is on screen.
    cx.timer.every(30000, (cx) => { if (this.visible()) this.refreshPr(cx); });
  }

  visible() {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel) return true;
    return !panel.hidden && body?.active === "changes";
  }

  // ---- viewer mode ----------------------------------------------------------------

  initViewer(p, cx) {
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        let lines;
        if (p.view === "file") {
          const text = await readTextFile(`${p.root}/${p.path}`, { on: p.on }).catch(() => null);
          lines = text === null ? ["Cannot preview this file (binary, too large, or unreadable)"]
            : text.includes("\0") ? ["Binary file"] : text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 3000).map((l, i) => ` ${l}`);
          this.rows = lines.map((l, i) => ({ kind: " ", number: i + 1, text: untab(l.slice(1)) || " " }));
        } else {
          lines = clip(await diffLines(p.root, p.on, p.path, p.status));
          this.rows = diffRows(lines);
        }
        this.diffWidth = Math.max(300, ...this.rows.map((r) => (r.text.length + 1) * 7 + 50));
      } catch (e) { this.note = String(e); }
      cx.notify();
    });
  }

  renderViewer() {
    const p = props() ?? {};
    return v_flex().id(`v-${this.uid}`).size_full().min_h(0).bg(C.surface).text_color(C.text2).text_size(SIZE.body)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(C.line1)
        .child(icon(p.view === "file" ? "file" : "git-compare", 14, C.muted))
        .child(div().font_family(MONO).text_size(SIZE.meta).text_color(C.text).truncate().child(p.path))
        .child(div().text_size(SIZE.caps).text_color(C.dim).child(p.view === "file" ? "File" : "Unified diff")))
      .when(Boolean(this.note), (e) => e.child(div().p(12).text_color(C.red).child(this.note)))
      .child(this.diffArea(`vd-${this.uid}`));
  }

  // ---- runner mode (Undo / Restore) -------------------------------------------------

  initRunner(p, cx) {
    this.status = "Restoring workspace…"; this.failed = false;
    // Archive job: from the sidebar button (props.archive), or re-opened by the confirm dialog (shared pending, forced).
    const pending = shared("pm.archive.pending");
    const fresh = pending && Date.now() - pending.at < 120000;
    const archive = p.archive ?? (!p.restore && fresh ? { ...pending, force: true } : null);
    if (archive) {
      this.status = "Archiving workspace…";
      this.job = archive;
      cx.spawn(async (cx) => {
        const r = await archiveWorktree({
          root: archive.path, on: null, branch: archive.branch, force: Boolean(archive.force),
          confirmCommand: { name: "mod.open", args: { name: "pm-git" } },
        });
        if (r === DIRTY) { setShared("pm.archive.pending", { ...archive, force: undefined, at: Date.now() }); closeOverlay(props().overlay); return; }
        if (r) { this.status = r; this.failed = true; cx.notify(); return; }
        closeOverlay(props().overlay);
      });
      return;
    }
    const job = p.restore ?? shared("pm.undo");
    // Nothing to undo (empty or expired): do nothing and close.
    if (!p.restore && (!job || (job.until && Date.now() > job.until))) {
      if (job) setShared("pm.undo", null);
      cx.spawn(async () => closeOverlay(p.overlay));
      return;
    }
    cx.spawn(async (cx) => {
      let err = "";
      if (!job) err = "Nothing to restore.";
      else { this.job = job; err = await restoreWorktree(job); }
      if (!p.restore) setShared("pm.undo", null);
      if (err) { this.status = err; this.failed = true; cx.notify(); return; }
      closeOverlay(props().overlay);
    });
  }

  renderRunner() {
    const j = this.job;
    return v_flex().id(`r-${this.uid}`).size_full().p(16).gap(6).bg(C.raised).text_size(SIZE.body)
      .on_key_down((e, cx) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(div().font_semibold().text_color(C.text).child(j ? `${j.name}` : "Restore"))
      .child(div().text_color(this.failed ? C.red : C.muted).child(this.status));
  }

  // ---- panel data -----------------------------------------------------------------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset() {
    this.root = null; this.files = []; this.open = null; this.rows = []; this.message = ""; this.input.set_value("");
    this.error = null; this.note = null; this.watched = null; this.pr = undefined; this.checks = []; this.tree = [];
    this.branch = null; this.ahead = 0; this.menu = false; this.prErr = null;
  }

  refresh(cx) {
    if (this.loading || this.busyLabel) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let first = false;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.rows = []; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), g = (args) => git(root, [...READ, ...args], on);
        first = this.root !== root;
        const status = await g(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (!status.ok) throw new Error(status.err);
        const head = await g(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.ok ? [await g(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await g(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await g(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (!result.ok) throw new Error(result.err);
          for (const entry of result.out.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.out.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        const branch = (await g(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
        if (first) {
          const cfg = parse((await readTextFile(`${root}/.herdr/project.json`, { on }).catch(() => null)) ?? "null");
          this.base = cfg?.base ?? "main";
        }
        const up = await g(["rev-list", "--count", "@{u}..HEAD"]);
        let ahead = up.ok ? Number(up.out) : NaN;
        if (Number.isNaN(ahead)) {
          const b = await g(["rev-list", "--count", `${this.base}..HEAD`]);
          ahead = b.ok ? Number(b.out) : 0;
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.ok; this.files = files; this.branch = branch; this.ahead = ahead;
        this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.rows = []; }
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); } catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
      if (first && key() === context) { this.refreshPr(cx); this.loadTree(cx); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path);
    if (!file) return;
    const lines = clip(await diffLines(this.root, this.on, path, file.status));
    if (key() === context && this.open === path) this.setLines(lines);
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map((row) => (row.text.length + 1) * 7 + 50));
  }

  refreshPr(cx) {
    if (this.prLoading || !this.root) return;
    this.prLoading = true;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await loadPr(root, on);
        if (this.context !== context) return;
        if (r.error) { this.prErr = r.error; this.noRemote = Boolean(r.noRemote); this.pr = null; this.checks = []; }
        else { this.prErr = null; this.noRemote = false; this.pr = r.pr; this.checks = r.checks; this.dev = Boolean(r.dev); if (r.tab && r.tab !== this.devTab) { this.devTab = r.tab; this.tab = r.tab; } }
        this.prAt = Date.now();
        if (!r.error && !r.dev) publishPr(root, this.on, r.pr, r.checks);
      } finally { this.prLoading = false; cx.notify(); }
    });
  }

  loadTree(cx) {
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const r = await git(root, [...READ, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], on);
      if (this.context !== context) return;
      this.paths = r.out.split("\0").filter(Boolean).sort().slice(0, 5000);
      cx.notify();
    });
  }

  allRows() {
    // Flat visible rows of the tree: folders first, expanded on demand.
    const root = { dirs: new Map(), files: [] };
    for (const p of this.paths ?? []) {
      const parts = p.split("/"); let n = root;
      for (const d of parts.slice(0, -1)) { if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] }); n = n.dirs.get(d); }
      n.files.push({ name: parts[parts.length - 1], path: p });
    }
    const out = [];
    const walk = (n, prefix, depth) => {
      for (const [name, sub] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const path = prefix + name, open = this.expanded.has(path);
        out.push({ dir: true, name, path, depth, open });
        if (open) walk(sub, `${path}/`, depth + 1);
      }
      for (const f of n.files) out.push({ dir: false, name: f.name, path: f.path, depth });
    };
    walk(root, "", 0);
    return out;
  }

  // ---- panel actions ----------------------------------------------------------------

  /** Routing: Markdown opens pm-md (when that mod exists), everything else pm-diff; both fall back to pm-diff. */
  async openFile(path, status) {
    const name = path.split("/").pop();
    if (/\.(md|markdown)$/i.test(path) && (await readTextFile(`${appHome()}/mods/pm-md/mod.json`).catch(() => null)) !== null) {
      run("tab.new", { name, mod: "pm-md", props: { path, root: this.root, on: this.on } });
    } else run("tab.new", { name, mod: "pm-diff", props: { root: this.root, path, base: this.base, on: this.on, status } });
  }

  /** The PR as a tab (pm-pr). */
  openPr() {
    if (this.pr) run("tab.new", { name: `PR #${this.pr.number}`, mod: "pm-pr", props: { root: this.root, number: this.pr.number, on: this.on } });
  }

  pick(path, cx) {
    this.open = path; this.closed = false; this.setLines([]);
    const file = this.files.find((f) => f.path === path);
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(path, context); } catch (e) { this.note = `Cannot preview this diff: ${e}`; }
      cx.notify();
    });
    this.openFile(path, file?.status);
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busyLabel || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busyLabel = "Committing…"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await git(root, args, on);
          if (!r.ok) throw new Error(r.err);
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busyLabel = null; this.refresh(cx); this.refreshPr(cx); cx.notify(); }
    });
    cx.notify();
  }

  /** Runs a multi-step action with a busy label; errors land in this.note. */
  act(label, fn, cx) {
    if (this.busyLabel) return;
    this.busyLabel = label; this.note = null; this.menu = false;
    cx.spawn(async (cx) => {
      try { const err = await fn(); if (err) this.note = err; }
      catch (e) { this.note = String(e); }
      finally { this.busyLabel = null; this.refresh(cx); this.refreshPr(cx); cx.notify(); }
    });
    cx.notify();
  }

  /** Rule 5: PLAN.md never reaches main. Removed (and committed when tracked) right before the PR. */
  async removePlan() {
    const { root, on } = this;
    const tracked = (await git(root, [...READ, "ls-files", "--error-unmatch", "PLAN.md"], on)).ok;
    if (tracked) {
      let r = await git(root, ["rm", "-q", "PLAN.md"], on);
      if (!r.ok) return r.err;
      r = await git(root, ["commit", "-q", "-m", "chore: remove plan"], on);
      return r.ok ? "" : r.err;
    }
    if ((await readTextFile(`${root}/PLAN.md`, { on }).catch(() => null)) !== null) await exec("rm", ["-f", "PLAN.md"], { cwd: root, on });
    return "";
  }

  createPr(draft, cx) {
    if (this.dev) { this.note = "DEV mode: Create PR is disabled."; cx.notify(); return; }
    if (!this.root) { this.note = "No git repository here: nothing to push."; cx.notify(); return; }
    this.act("Creating PR…", async () => {
      let err = await this.removePlan();
      if (err) return `Could not remove PLAN.md: ${err}`;
      const push = await git(this.root, ["push", "-u", "origin", "HEAD"], this.on, 120000);
      if (!push.ok) return `Push failed: ${push.err.split("\n").slice(-2).join(" ")}`;
      const r = await gh(this.root, ["pr", "create", "--fill", "--base", this.base, ...(draft ? ["--draft"] : [])], this.on, 120000);
      return r.ok ? "" : `gh pr create failed: ${r.err.split("\n")[0]}`;
    }, cx);
  }

  fixCi(cx) {
    const names = judge(this.pr, this.checks).failing.map((c) => c.name);
    const prompt = `CI is failing on PR #${this.pr.number} (${this.pr.headRefName}). Failing checks: ${names.join(", ")}. `
      + "Run `gh run view --log-failed` to read the logs, find the root cause, fix it, run lint and tests locally, then commit and push.";
    const space = spaces().find((s) => s.active);
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const claude = agents().find((a) => tabs.has(a.tab) && (a.program?.key === "claude" || /claude/i.test(a.app ?? "")));
    if (claude) {
      hc(["send", claude.address, prompt]).then((r) => { if (r.code !== 0) notify({ title: "Fix CI failed", body: r.stderr.trim(), level: "error" }); });
      run("agent.focus", { terminal: claude.address });
    } else {
      run("tab.new", { name: "claude", argv: ["claude", "--permission-mode", "plan"], task: prompt });
    }
    notify({ title: "Fix CI sent to Claude", body: names.join(", "), level: "info", timeout: 4000 });
  }

  merge(cx) {
    const pr = this.pr;
    this.act("Merging…", async () => {
      const { root, on } = this;
      const sha = (await git(root, ["rev-parse", "HEAD"], on)).out.trim();
      const r = await gh(root, ["pr", "merge", String(pr.number), "--squash", "--delete-branch"], on, 180000);
      // gh can fail to delete the local branch inside a worktree after merging: trust the PR state.
      const state = parse((await gh(root, ["pr", "view", "--json", "state"], on)).out)?.state;
      if (state !== "MERGED") return `Merge failed: ${r.err.split("\n")[0]}`;
      // gh aborts before deleting the remote branch when the local one is checked out in a worktree: delete it explicitly.
      const head = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], on)).out.trim();
      if (head && head !== "HEAD" && (await git(root, ["ls-remote", "--exit-code", "--heads", "origin", head], on)).ok) await git(root, ["push", "origin", "--delete", head], on, 60000);
      return this.archive({ pr: pr.number, merged: true, sha, base: pr.baseRefName });
    }, cx);
  }

  mergeAnywayConfirm() {
    const j = judge(this.pr, this.checks);
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 200, props: {
      title: "Merge anyway?",
      detail: `Still blocking: ${j.blockers.join(", ") || "nothing"}. The PR will be squashed into ${this.pr.baseRefName}, the branch deleted and the workspace archived.`,
      command: { name: "pm-git.merge-anyway" },
    } });
  }

  /** Archive the panel's worktree; see archiveWorktree. */
  async archive({ pr = null, merged = false, sha = "", base = "main", force = false } = {}) {
    const r = await archiveWorktree({ root: this.root, on: this.on, branch: this.branch, pr, merged, sha, base, force });
    return r === DIRTY ? "" : r;
  }

  command(cmd, cx) {
    if (cmd === "merge-anyway" && this.pr) this.merge(cx);
    else if (cmd === "create-pr") this.createPr(false, cx);
    else if (cmd === "archive") this.act("Archiving…", () => this.archive(), cx);
    else if (cmd === "fix-ci" && this.pr) this.fixCi(cx);
    else if (cmd === "merge" && this.pr) this.merge(cx);
    else if (cmd === "tab:checks" || cmd === "tab:changes" || cmd === "tab:files") this.tab = cmd.slice(4);
    else if (cmd === "archive-force") this.act("Archiving…", () => this.archive({ force: true }), cx);
  }

  // ---- panel UI -------------------------------------------------------------------

  button(id, label, kind, onClick, { ic, disabled, tip } = {}) {
    const bg = disabled ? C.raised : kind === "primary" ? C.ember : kind === "merge" ? C.green : "#00000000";
    const fg = disabled ? C.dim : kind === "secondary" ? C.text2 : "#1B140D";
    return h_flex().id(id).h(28).px(12).gap(6).flex_none().items_center().rounded(7).text_size(SIZE.meta + 0.5).font_medium()
      .bg(bg).text_color(fg)
      .when(kind === "secondary", (e) => e.border_1().border_color(C.line3))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
      .when(disabled, (e) => e.cursor_not_allowed())
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(ic), (e) => e.child(icon(ic, 13, fg)))
      .child(label);
  }

  chevronMenu(items) {
    return div().id(`menu-btn-${this.uid}`).h(28).w(24).flex_none().flex().items_center().justify_center().rounded(7)
      .border_1().border_color(C.line3).cursor_pointer().hover((s) => s.bg(C.raised))
      .on_click((_e, cx) => { this.menu = !this.menu; this.menuItems = items; cx.notify(); })
      .child(icon("chevron-down", 12, C.muted));
  }

  banner() {
    const { pr } = this;
    let tint = "neutral", left, text, textColor = C.text2, right = [];
    const pill = pr ? h_flex().id(`pill-${this.uid}`).h(24).px(8).gap(4).flex_none().items_center().rounded(6).border_1().border_color(C.line3)
      .font_family(MONO).text_size(11.5).text_color(C.greenText).cursor_pointer().hover((s) => s.bg(C.raised))
      .on_click(() => this.openPr()).tooltip("Open the PR")
      .child(`#${pr.number}`).child(icon("arrow-up-right", 11, C.greenText)) : null;
    if (this.busyLabel) { text = this.busyLabel; }
    else if (pr === undefined) text = "Checking GitHub…";
    else if (pr === null) {
      const cant = Boolean(this.prErr);
      text = this.noRemote ? "No GitHub remote" : cant ? "GitHub unavailable" : this.ahead > 0 ? `${this.ahead} commit${this.ahead === 1 ? "" : "s"} to push` : "No pull request";
      right = [
        this.button("create-pr", "Create PR", "primary", (cx) => this.createPr(false, cx), { disabled: this.noRemote || (cant && !this.noRemote), tip: cant ? this.prErr : "Push and open a PR" }),
        this.chevronMenu([
          { label: "Create as draft", run: (cx) => this.createPr(true, cx), off: cant },
          { label: "Archive workspace", run: (cx) => this.act("Archiving…", () => this.archive(), cx) },
        ]),
      ];
    } else if (pr.state === "MERGED" || pr.state === "CLOSED") {
      tint = "neutral"; left = pill; text = pr.state === "MERGED" ? "Merged" : "Closed"; textColor = C.muted;
      right = [this.button("archive", "Archive", "secondary", (cx) => this.act("Archiving…", () => this.archive({ pr: pr.number, merged: pr.state === "MERGED", base: pr.baseRefName }), cx), { ic: "archive" })];
    } else {
      const j = judge(pr, this.checks);
      left = pill;
      const anyway = { label: "Merge anyway", run: () => this.mergeAnywayConfirm(), danger: true };
      if (j.failing.length) {
        tint = "red"; text = "CI failing"; textColor = "#E8907E";
        right = [this.button("fix-ci", "Fix CI", "primary", (cx) => this.fixCi(cx), { ic: "wrench", tip: "Send the failing checks to Claude" }), this.chevronMenu([anyway])];
      } else if (j.blockers.length) {
        tint = "brown"; text = j.blockers[0]; textColor = C.yellow;
        right = [this.button("merge", "Merge", "merge", () => {}, { disabled: true, tip: j.blockers.join(", ") }), this.chevronMenu([anyway])];
      } else {
        tint = "green"; text = "Ready to merge"; textColor = C.greenText;
        right = [this.button("merge", "Merge", "merge", (cx) => this.merge(cx), { tip: "Squash, delete branch, archive" })];
      }
    }
    return v_flex().flex_none().relative()
      .child(h_flex().h(44).flex_none().px(12).gap(10).items_center().bg(TINT[tint]).border_b(1).border_color(C.line1)
        .child(left ?? div())
        .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body).text_color(textColor).child(text))
        .when(Boolean(this.busyLabel), (e) => e.child(svg("pm-shared/icons/loader.svg").size(14).text_color(C.muted).spin(900)))
        .children(this.busyLabel ? [] : right))
      .when(this.menu && !this.busyLabel, (e) => e.child(
        v_flex().id(`menu-${this.uid}`).absolute().top(46).right(10).w(190).p(4).rounded(8).bg(C.raised).border_1().border_color(C.line3)
          .children((this.menuItems ?? []).map((it, i) =>
            h_flex().id(`mi-${i}`).h(28).px(8).items_center().rounded(5).text_size(SIZE.meta + 0.5)
              .text_color(it.off ? C.dim : it.danger ? C.red : C.text).when(!it.off, (x) => x.cursor_pointer().hover((s) => s.bg("#352D24")))
              .on_click((_e, cx) => { this.menu = false; if (!it.off) it.run(cx); cx.notify(); }).child(it.label)))));
  }

  tabs() {
    const chip = (id, label, count) => h_flex().id(`tab-${id}-${this.uid}`).h(26).px(8).gap(5).items_center().rounded(6).cursor_pointer()
      .text_size(SIZE.body).bg(this.tab === id ? C.raised : "#00000000").text_color(this.tab === id ? C.text : C.muted)
      .hover((s) => s.bg(this.tab === id ? C.raised : "#221D17")).on_click((_e, cx) => { this.tab = id; this.menu = false; cx.notify(); })
      .child(label).when(count !== undefined, (e) => e.child(div().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).child(String(count))));
    return h_flex().h(40).flex_none().px(10).gap(2).items_center()
      .child(chip("changes", "Changes", this.files.length)).child(chip("files", "All files")).child(chip("checks", "Checks"))
      .child(div().flex_1())
      .child(div().id(`review-${this.uid}`).px(6).text_size(SIZE.meta + 0.5).text_color(this.pr ? C.link : C.dim)
        .when(Boolean(this.pr), (e) => e.cursor_pointer().on_click(() => this.openPr()))
        .tooltip(this.pr ? "Review the PR" : "Open a PR to review").child("Review"));
  }

  diffRow({ kind, number, text }) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(C.raised).text_color(C.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10)
      .when(kind === "+", (e) => e.bg(`${C.green}1F`)).when(kind === "-", (e) => e.bg(`${C.red}1F`))
      .child(div().w(30).flex_none().text_right().text_color(C.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().text_color(kind === "-" ? "#E9A9A0" : kind === "+" ? "#C5DDB0" : C.text2).child(text));
  }

  diffArea(id) {
    return div().flex_1().min_h(0).relative().font_family(MONO).text_size(11)
      .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list(id, this.rows.length, 20, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row))).size_full())))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  changesTab() {
    const enabled = Boolean(this.message.trim() && this.root && !this.busyLabel && !this.loading);
    return v_flex().flex_1().min_h(0)
      .child(div().flex_none().min_h(44).max_h(Math.max(1, this.files.length) * 28 + 12).relative().border_t(1).border_color(C.line1).border_b(1)
        .child(v_flex().id(`list-${this.uid}`).p(6).overflow_y_scroll().children(this.files.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          const color = f.status === "A" ? C.greenText : f.status === "D" || f.status === "U" ? C.red : C.yellow;
          return h_flex().id(`ch-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(this.open === f.path, (e) => e.bg(C.raised)).hover((s) => s.bg("#221D17"))
            .on_click((_e, cx) => this.pick(f.path, cx))
            .child(div().w(12).flex_none().font_family(MONO).text_size(11).text_color(color).child(f.status))
            .child(h_flex().flex_1().min_w(0).font_family(MONO).text_size(SIZE.meta + 0.5)
              .child(div().text_color(C.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().min_w(0).truncate().text_color(C.text).child(name)))
            .child(DiffPill(f.add, f.del));
        })).when(!this.files.length, (e) => e.child(div().p(8).text_color(C.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))))))
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(C.dim).child("Showing the first 1,000 changed files")))
      .child(h_flex().h(30).flex_none().px(14).items_center().text_size(SIZE.meta)
        .child(div().flex_1().font_family(MONO).text_color(C.muted).truncate().child(this.open?.split("/").pop() ?? ""))
        .when(Boolean(this.open), (e) => e.child(div().id(`full-${this.uid}`).text_color(C.link).cursor_pointer()
          .on_click(() => this.openFile(this.open, this.files.find((f) => f.path === this.open)?.status)).child("Open full view"))))
      .child(this.diffArea(`d-${this.uid}`))
      .when(Boolean(this.note), (e) => e.child(div().px(12).pb(8).text_size(11).text_color(C.red).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(C.line1)
        .child(div().id(`cm-${this.uid}`).flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? C.ember : C.line2).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(SIZE.meta).text_color(C.text)))
        .child(this.button("commit", "Commit", enabled ? "primary" : "secondary", (cx) => this.commit(cx), { disabled: !enabled })));
  }

  filesTab() {
    const rows = this.allRows().slice(0, 1500);
    const id = `tree-${this.uid}`;
    return div().flex_1().min_h(44).relative().border_t(1).border_color(C.line1)
      .child(v_flex().id(id).absolute().inset_0().py(6).overflow_y_scroll().children(rows.map((r) =>
        h_flex().id(`t-${r.path}`).h(26).flex_none().mx(6).pr(8).pl(8 + r.depth * 14).gap(6).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg("#221D17")).text_size(SIZE.body).text_color(r.dir ? C.text2 : C.text)
          .on_click((_e, cx) => {
            if (r.dir) { if (this.expanded.has(r.path)) this.expanded.delete(r.path); else this.expanded.add(r.path); cx.notify(); }
            else this.openFile(r.path);
          })
          .child(r.dir ? icon(r.open ? "chevron-down" : "chevron-right", 12, C.dim) : div().w(12).flex_none())
          .child(icon(r.dir ? "folder" : "file", 13, C.dim))
          .child(div().flex_1().min_w(0).truncate().child(r.name))))
        .when(!rows.length, (e) => e.child(div().p(14).text_color(C.dim).child("No files"))))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  checkRow(id, shape, label, trailing, onTrailing) {
    const s = STATUS_ICON[shape] ?? STATUS_ICON.skipping;
    return h_flex().id(id).h(32).flex_none().px(16).gap(10).items_center()
      .child(icon(s.icon, 14, s.color))
      .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body).text_color(shape === "fail" ? C.text2 : C.text).child(label))
      .when(Boolean(trailing), (e) => e.child(div().id(`${id}-a`).flex_none().text_size(SIZE.caps + 1).text_color(C.muted).cursor_pointer()
        .hover((x) => x.text_color(C.link)).on_click(onTrailing).child(trailing)));
  }

  checksTab() {
    const pr = this.pr;
    if (!pr) {
      return v_flex().flex_1().min_h(0).border_t(1).border_color(C.line1).p(16).gap(6)
        .child(div().text_size(SIZE.body).text_color(C.text2).child(this.noRemote ? "This repository has no GitHub remote." : this.prErr ? "GitHub is unavailable." : "No pull request yet."))
        .child(div().text_size(SIZE.meta).text_color(C.dim).child(this.prErr ?? "Create a PR to see checks, reviews and comments here."));
    }
    const j = judge(pr, this.checks);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const open = (url) => () => url && exec("open", [url]);
    const branchColor = j.failing.length ? C.red : C.greenText;
    return v_flex().id(`checks-${this.uid}`).flex_1().min_h(0).overflow_y_scroll().border_t(1).border_color(C.line1)
      .child(v_flex().flex_none().px(16).pt(16).pb(14).gap(6).border_b(1).border_color(C.line1)
        .child(h_flex().gap(8).items_baseline()
          .child(div().flex_none().text_size(SIZE.body).text_color(C.muted).child(`#${pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body + 1).font_semibold().text_color(C.text).child(pr.title))
          .child(div().id(`pr-open-${this.uid}`).flex_none().cursor_pointer().on_click(open(pr.url)).child(icon("arrow-up-right", 13, C.muted))))
        .child(div().font_family(MONO).text_size(SIZE.meta).text_color(branchColor).truncate().child(`${pr.headRefName} → ${pr.baseRefName} · +${add} −${del}`)))
      .child(v_flex().flex_none().py(6)
        .children(this.checks.map((c, i) => this.checkRow(`ck-${i}`, c.bucket, c.name, c.link ? "logs" : null, open(c.link))))
        .when(!this.checks.length, (e) => e.child(this.checkRow("ck-none", "skipping", "No checks reported", null)))
        .child(this.checkRow("rv", j.changes ? "fail" : j.approvals ? "pass" : "skipping",
          j.changes ? "Changes requested" : j.approvals ? `${j.approvals} approval${j.approvals === 1 ? "" : "s"}` : "No approvals yet", null))
        .when(j.comments > 0, (e) => e.child(this.checkRow("cm", "pending", `${j.comments} comment${j.comments === 1 ? "" : "s"}`, "view", open(pr.url))))
        .when(j.conflicts, (e) => e.child(this.checkRow("cf", "fail", "Merge conflicts with " + pr.baseRefName, null))))
      .when(!j.blockers.length && pr.state === "OPEN", (e) => e.child(h_flex().flex_none().w_full().px(16).pt(12).gap(10).border_t(1).border_color(C.line1)
        .child(icon("arrow-up-right", 13, C.dim))
        .child(div().flex_1().min_w(0).text_size(SIZE.meta + 0.5).text_color(C.muted).child(`Merge: squash into ${pr.baseRefName}, delete the branch, archive the workspace. Undoable for 10 s.`))))
      .when(Boolean(this.note), (e) => e.child(div().px(16).py(8).text_size(11).text_color(C.red).child(this.note)));
  }

  render(cx) {
    if (this.mode === "viewer") return this.renderViewer();
    if (this.mode === "runner") return this.renderRunner();
    if (key() !== this.context) this.refresh(cx);
    const vis = this.visible();
    if (vis && !this.wasVisible && this.root && Date.now() - (this.prAt ?? 0) > 10000) this.refreshPr(cx);
    this.wasVisible = vis;
    if (!this.cmdLoop) {
      this.cmdLoop = true;
      cx.spawn(async (cx) => { for (;;) { const cmd = await nextCommand(); this.command(cmd, cx); cx.notify(); } });
    }
    return v_flex().id(`git-${this.uid}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(C.surface).border_1().border_color(C.line1)
      .text_color(C.text2).text_size(SIZE.body).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); } })
      .child(this.banner())
      .child(this.tabs())
      .child(this.tab === "changes" ? this.changesTab() : this.tab === "files" ? this.filesTab() : this.checksTab());
  }
}
