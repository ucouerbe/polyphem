// @ts-check
// A pull request as a tab (screen 04b).
// Open: run("tab.new", { name: `PR #${n}`, mod: "pm-pr", props: { root, number, on? } })
//   root: the worktree folder (gh runs there), number: the PR (omitted: the PR of root's branch).
// Tabs: Conversation (description, commits, reviews, comments), Files (opens pm-diff), Checks.
// The primary action follows pm-git's banner: Fix CI, Merge (blocked until green), nothing once merged.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { nextCommand, exec, hc, run, notify, props, agents, panes } from "herdr";
import { C, SIZE, MONO, icon } from "./ui.js";

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
async function gh(cwd, args, on, timeout = 30000) {
  try {
    const r = await exec("gh", args, { cwd, on, timeout });
    return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
  } catch (e) { return { ok: false, out: "", err: String(e) }; }
}
async function git(cwd, args, on) {
  try {
    const r = await exec("git", args, { cwd, on });
    return { ok: r.code === 0, out: r.stdout ?? "" };
  } catch { return { ok: false, out: "" }; }
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

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

/** Same rules as pm-git's banner: what blocks a merge. */
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
  return { failing, pending, approvals, changes, conflicts, blockers };
}

const STATUS_ICON = {
  fail: { icon: "x", color: C.red }, cancel: { icon: "x", color: C.red },
  pending: { icon: "circle-half", color: C.ember }, pass: { icon: "check", color: C.green },
  skipping: { icon: "ring", color: C.dim },
};

/** Sends one message to the Claude terminal running in `root`, or starts one there. */
async function sendToClaude(root, text) {
  const inside = (cwd) => cwd && (cwd === root || cwd.startsWith(`${root}/`));
  const paneCwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  const found = agents().filter((a) => (a.program?.key === "claude" || /claude/i.test(a.app ?? "")) && inside(paneCwd.get(a.pane)));
  const claude = found.find((a) => a.focused) ?? found[0];
  if (claude) {
    const r = await hc(["send", claude.address, text]);
    if (r.code !== 0) { notify({ title: "Could not send to Claude", body: r.stderr.trim(), level: "error" }); return false; }
    run("agent.focus", { terminal: claude.address });
  } else run("tab.new", { name: "claude", folder: root, argv: ["claude"], task: text });
  return true;
}

export default class PmPr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.uid = Math.random().toString(36).slice(2, 7);
    this.root = p.root; this.on = p.on ?? null; this.number = p.number ?? null;
    this.tab = "conversation"; this.pr = undefined; this.checks = []; this.inline = []; this.err = null; this.busy = null;
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading || !this.root) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const fields = "number,title,body,headRefName,baseRefName,state,isDraft,author,createdAt,additions,deletions,files,commits,reviews,comments,statusCheckRollup,url,mergeable,reviewDecision";
        const target = this.number ? [String(this.number)] : [];
        const [view, checks] = await Promise.all([
          gh(this.root, ["pr", "view", ...target, "--json", fields], this.on),
          gh(this.root, ["pr", "checks", ...target, "--json", "name,bucket,link,state"], this.on),
        ]);
        if (!view.ok) { this.err = view.err.split("\n")[0] || "gh failed"; return; }
        const pr = parse(view.out);
        if (!pr) { this.err = "Unreadable gh output"; return; }
        this.number = pr.number;
        const list = parse(checks.out);
        this.checks = Array.isArray(list) && list.length ? list : fromRollup(pr.statusCheckRollup);
        const inline = await gh(this.root, ["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments`], this.on);
        this.inline = inline.ok ? (parse(inline.out) ?? []) : [];
        this.pr = pr; this.err = null;
      } finally { this.loading = false; cx.notify(); }
    });
  }

  // ---- actions ----------------------------------------------------------------------

  fixCi() {
    const names = judge(this.pr, this.checks).failing.map((c) => c.name);
    const prompt = `CI is failing on PR #${this.pr.number} (${this.pr.headRefName}). Failing checks: ${names.join(", ")}. `
      + "Run `gh run view --log-failed` to read the logs, find the root cause, fix it, run lint and tests locally, then commit and push.";
    sendToClaude(this.root, prompt).then((ok) => ok && notify({ title: "Fix CI sent to Claude", body: names.join(", "), level: "info", timeout: 4000 }));
  }

  merge(cx) {
    if (this.busy) return;
    const pr = this.pr;
    this.busy = "Merging…"; cx.notify();
    cx.spawn(async (cx) => {
      const r = await gh(this.root, ["pr", "merge", String(pr.number), "--squash", "--delete-branch"], this.on, 180000);
      const state = parse((await gh(this.root, ["pr", "view", String(pr.number), "--json", "state"], this.on)).out)?.state;
      if (state === "MERGED") {
        const head = (await git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], this.on)).out.trim();
        if (head && head !== "HEAD" && (await git(this.root, ["ls-remote", "--exit-code", "--heads", "origin", head], this.on)).ok) await git(this.root, ["push", "origin", "--delete", head], this.on);
        notify({ title: `PR #${pr.number} merged`, body: "Archive the workspace from the Git panel.", level: "success", timeout: 6000 });
      } else notify({ title: "Merge failed", body: r.err.split("\n")[0], level: "error" });
      this.busy = null; this.loading = false; this.refresh(cx); cx.notify();
    });
  }

  /** Review comments with their context, as one message. */
  commentText(c) {
    return `${c.path}:${c.line ?? c.original_line ?? "?"}\n${c.body}`;
  }

  sendOne(text) {
    sendToClaude(this.root, `Review feedback on PR #${this.pr.number}:\n\n${text}`).then((ok) => ok && notify({ title: "Sent to Claude", level: "info", timeout: 3000 }));
  }

  sendAll() {
    const parts = this.inline.map((c) => this.commentText(c));
    for (const r of this.pr.reviews ?? []) if (r.body?.trim() && r.state !== "APPROVED") parts.push(`${r.author?.login ?? "review"}: ${r.body.trim()}`);
    for (const c of this.pr.comments ?? []) parts.push(`${c.author?.login ?? "comment"}: ${c.body.trim()}`);
    const failing = judge(this.pr, this.checks).failing.map((c) => c.name);
    if (failing.length) parts.push(`CI is failing: ${failing.join(", ")} (use gh run view --log-failed).`);
    if (!parts.length) { notify({ title: "Nothing to send", level: "info", timeout: 3000 }); return; }
    this.sendOne(parts.join("\n\n"));
  }

  open(url) { if (url) exec("open", [url]); }

  // ---- UI ----------------------------------------------------------------------------

  button(id, label, kind, onClick, { ic, disabled, tip } = {}) {
    const bg = disabled ? C.raised : kind === "primary" ? C.ember : kind === "merge" ? C.green : "#00000000";
    const fg = disabled ? C.dim : kind === "secondary" ? C.text2 : "#1B140D";
    return h_flex().id(`${id}-${this.uid}`).h(28).px(12).gap(6).flex_none().items_center().rounded(7).text_size(SIZE.meta + 0.5).font_medium()
      .bg(bg).text_color(fg)
      .when(kind === "secondary", (e) => e.border_1().border_color(C.line3))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
      .when(disabled, (e) => e.cursor_not_allowed())
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(ic), (e) => e.child(icon(ic, 13, fg)))
      .child(label);
  }

  primary() {
    const { pr } = this;
    if (this.busy) return div().text_size(SIZE.meta).text_color(C.muted).child(this.busy);
    if (pr.state === "MERGED") return div().text_size(SIZE.body).text_color(C.greenText).child("Merged");
    if (pr.state === "CLOSED") return div().text_size(SIZE.body).text_color(C.muted).child("Closed");
    const j = judge(pr, this.checks);
    if (j.failing.length) return this.button("fix", "Fix CI", "primary", () => this.fixCi(), { ic: "wrench", tip: "Send the failing checks to Claude" });
    if (j.blockers.length) return this.button("merge", "Merge", "merge", () => {}, { disabled: true, tip: j.blockers.join(", ") });
    return this.button("merge", "Merge", "merge", (cx) => this.merge(cx), { tip: "Squash, delete branch" });
  }

  chip(id, label, extra, color) {
    const on = this.tab === id;
    return h_flex().id(`tab-${id}-${this.uid}`).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(SIZE.body)
      .bg(on ? C.raised : "#00000000").text_color(on ? C.text : C.muted).hover((s) => s.bg(on ? C.raised : "#221D17"))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); })
      .child(label).when(Boolean(extra), (e) => e.child(div().font_family(MONO).text_size(SIZE.meta).text_color(color ?? C.dim).child(extra)));
  }

  textLink(id, label, onClick) {
    return div().id(`${id}-${this.uid}`).flex_none().text_size(SIZE.caps + 1).text_color(C.muted).cursor_pointer()
      .hover((x) => x.text_color(C.link)).on_click(onClick).child(label);
  }

  timeline() {
    const pr = this.pr, items = [];
    for (const c of pr.commits ?? []) {
      items.push({ at: c.committedDate ?? c.authoredDate, el: h_flex().h(28).gap(10).items_center().text_size(SIZE.meta + 0.5)
        .child(div().w(12).flex_none().flex().justify_center().child(div().size(6).rounded(3).bg(C.dim)))
        .child(div().flex_none().text_color(C.text2).child(c.authors?.[0]?.login || c.authors?.[0]?.name || "commit"))
        .child(div().flex_1().min_w(0).truncate().text_color(C.muted).child(c.messageHeadline))
        .child(div().flex_none().font_family(MONO).text_size(SIZE.caps + 1).text_color(C.dim).child(`${(c.oid ?? "").slice(0, 7)} · ${ago(c.committedDate ?? c.authoredDate)}`)) });
    }
    const block = (head, body, send) => v_flex().gap(6).pl(14).py(4).border_l(2).border_color(C.line2).ml(5)
      .child(h_flex().gap(8).items_center().child(head).child(div().flex_1()).when(Boolean(send), (e) => e.child(this.textLink(`send-${items.length}`, "Send to Claude", send))))
      .child(div().text_size(SIZE.body).text_color(C.text2).child(body));
    for (const r of pr.reviews ?? []) {
      if (!r.body?.trim() && r.state === "COMMENTED") continue;
      const label = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed";
      items.push({ at: r.submittedAt, el: block(
        h_flex().gap(8).items_baseline().child(div().font_semibold().text_color(C.text).child(r.author?.login ?? "review"))
          .child(div().text_size(SIZE.meta).text_color(r.state === "APPROVED" ? C.greenText : r.state === "CHANGES_REQUESTED" ? C.red : C.dim).child(`${label} · ${ago(r.submittedAt)}`)),
        r.body?.trim() || "", r.body?.trim() ? () => this.sendOne(`${r.author?.login}: ${r.body.trim()}`) : null) });
    }
    for (const c of pr.comments ?? []) {
      items.push({ at: c.createdAt, el: block(
        h_flex().gap(8).items_baseline().child(div().font_semibold().text_color(C.text).child(c.author?.login ?? "comment"))
          .child(div().text_size(SIZE.meta).text_color(C.dim).child(ago(c.createdAt))),
        c.body.trim(), () => this.sendOne(`${c.author?.login}: ${c.body.trim()}`)) });
    }
    for (const c of this.inline) {
      items.push({ at: c.created_at, el: block(
        h_flex().gap(8).items_baseline().child(div().font_semibold().text_color(C.text).child(c.user?.login ?? "review"))
          .child(div().font_family(MONO).text_size(SIZE.meta).text_color(C.dim).child(`${c.path.split("/").pop()}:${c.line ?? c.original_line ?? "?"}`))
          .child(div().text_size(SIZE.meta).text_color(C.dim).child(ago(c.created_at))),
        c.body.trim(), () => this.sendOne(this.commentText(c))) });
    }
    items.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    const j = judge(pr, this.checks);
    return v_flex().gap(6).pt(14)
      .children(items.map((i) => i.el))
      .when(!items.length, (e) => e.child(div().text_size(SIZE.body).text_color(C.dim).child("No activity yet.")))
      .when(j.failing.length > 0, (e) => e.child(h_flex().h(28).gap(10).items_center().text_size(SIZE.meta + 0.5)
        .child(icon("x", 12, C.red)).child(div().text_color(C.text2).child("CI"))
        .child(div().text_color(C.muted).child(j.failing.map((c) => c.name).join(", ")))
        .child(this.textLink("logs", "view logs", () => this.open(j.failing[0].link)))));
  }

  conversation() {
    const body = this.pr.body?.trim();
    return v_flex().gap(4).pb(24)
      .child(body ? div().pt(14).text_size(SIZE.body).text_color(C.text2).child(TextView.markdown(`pr-body-${this.uid}`, body))
        : div().pt(14).text_size(SIZE.body).text_color(C.dim).child("No description."))
      .child(div().h(1).mt(14).bg(C.line1))
      .child(this.timeline());
  }

  filesTab() {
    const files = this.pr.files ?? [];
    return v_flex().pt(8).pb(24)
      .children(files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`pf-${f.path}`).h(32).flex_none().px(8).gap(10).items_center().rounded(7).cursor_pointer().hover((s) => s.bg("#221D17"))
          .on_click(() => run("tab.new", { name, mod: "pm-diff", props: { root: this.root, path: f.path, base: this.pr.baseRefName, on: this.on } }))
          .child(icon("git-compare", 13, C.dim))
          .child(h_flex().flex_1().min_w(0).font_family(MONO).text_size(SIZE.meta + 0.5)
            .child(div().text_color(C.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().min_w(0).truncate().text_color(C.text).child(name)))
          .child(h_flex().flex_none().gap(6).font_family(MONO).text_size(SIZE.meta)
            .child(div().text_color(C.greenText).child(`+${f.additions}`)).child(div().text_color(C.red).child(`−${f.deletions}`)));
      }))
      .when(!files.length, (e) => e.child(div().p(8).text_color(C.dim).child("No files changed.")));
  }

  checkRow(id, shape, label, trailing, onTrailing) {
    const s = STATUS_ICON[shape] ?? STATUS_ICON.skipping;
    return h_flex().id(`${id}-${this.uid}`).h(32).flex_none().px(8).gap(10).items_center()
      .child(icon(s.icon, 14, s.color))
      .child(div().flex_1().min_w(0).truncate().text_size(SIZE.body).text_color(shape === "fail" ? C.text2 : C.text).child(label))
      .when(Boolean(trailing), (e) => e.child(this.textLink(`${id}-a`, trailing, onTrailing)));
  }

  checksTab() {
    const pr = this.pr, j = judge(pr, this.checks);
    return v_flex().py(8)
      .children(this.checks.map((c, i) => this.checkRow(`ck-${i}`, c.bucket, c.name, c.link ? "logs" : null, () => this.open(c.link))))
      .when(!this.checks.length, (e) => e.child(this.checkRow("ck-none", "skipping", "No checks reported", null)))
      .child(this.checkRow("rv", j.changes ? "fail" : j.approvals ? "pass" : "skipping",
        j.changes ? "Changes requested" : j.approvals ? `${j.approvals} approval${j.approvals === 1 ? "" : "s"}` : "No approvals yet", null))
      .when(j.conflicts, (e) => e.child(this.checkRow("cf", "fail", `Merge conflicts with ${pr.baseRefName}`, null)))
      .when(!j.blockers.length && pr.state === "OPEN", (e) => e.child(h_flex().px(8).pt(12).gap(10).child(icon("arrow-up-right", 13, C.dim))
        .child(div().flex_1().min_w(0).text_size(SIZE.meta + 0.5).text_color(C.muted).child(`Merge: squash into ${pr.baseRefName} and delete the branch.`))));
  }

  /** Commands (`herdr-app do pm-pr.<cmd>`): tab:conversation, tab:files, tab:checks, send-all. */
  command(cmd, cx) {
    if (cmd.startsWith("tab:")) this.tab = cmd.slice(4);
    else if (cmd === "send-all" && this.pr) this.sendAll();
    cx.notify();
  }

  render(cx) {
    if (!this.cmdLoop) {
      this.cmdLoop = true;
      cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); } });
    }
    const wrap = (child) => v_flex().size_full().min_h(0).bg(C.surface).text_color(C.text2).text_size(SIZE.body).font_family("Geist").items_center().child(child);
    if (!this.root) return wrap(div().p(24).text_color(C.dim).child("No folder given."));
    if (this.pr === undefined) return wrap(div().p(24).text_color(this.err ? C.red : C.dim).child(this.err ?? "Loading pull request…"));
    const pr = this.pr, j = judge(pr, this.checks);
    const total = this.checks.length, ok = this.checks.filter((c) => c.bucket === "pass" || c.bucket === "skipping").length;
    const checksLabel = j.failing.length ? `✕ ${ok}/${total}` : j.pending.length ? `◐ ${ok}/${total}` : total ? `✓ ${ok}/${total}` : "";
    const checksColor = j.failing.length ? C.red : j.pending.length ? C.ember : C.greenText;
    const who = pr.author?.login ?? "someone";
    return v_flex().size_full().min_h(0).bg(C.surface).text_color(C.text2).text_size(SIZE.body).font_family("Geist").items_center()
      .child(v_flex().id(`pr-${this.uid}`).w_full().max_w(780).flex_1().min_h(0).px(24).pt(28).gap(12)
        .child(h_flex().gap(12).items_center()
          .child(h_flex().flex_1().min_w(0).gap(8).items_baseline()
            .child(div().min_w(0).truncate().text_size(SIZE.page).font_semibold().text_color(C.text).child(pr.title))
            .child(div().id(`num-${this.uid}`).flex_none().text_size(SIZE.page).text_color(C.dim).cursor_pointer()
              .hover((s) => s.text_color(C.link)).tooltip("Open on GitHub").on_click(() => this.open(pr.url)).child(`#${pr.number}`)))
          .child(h_flex().flex_none().gap(6).font_family(MONO).text_size(SIZE.meta)
            .child(div().text_color(C.greenText).child(`+${pr.additions}`)).child(div().text_color(C.red).child(`−${pr.deletions}`)))
          .child(this.primary()))
        .child(div().text_size(SIZE.body).text_color(C.muted).truncate()
          .child(`${pr.headRefName} → ${pr.baseRefName} · ${pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : pr.state.toLowerCase()} · by ${who} · opened ${ago(pr.createdAt)}`))
        .child(h_flex().h(36).flex_none().gap(2).items_center().border_b(1).border_color(C.line1)
          .child(this.chip("conversation", "Conversation"))
          .child(this.chip("files", "Files", String((pr.files ?? []).length)))
          .child(this.chip("checks", "Checks", checksLabel, checksColor))
          .child(div().flex_1())
          .child(this.button("sendall", "Send all to Claude", "secondary", () => this.sendAll())))
        .child(v_flex().id(`body-${this.uid}`).flex_1().min_h(0).overflow_y_scroll()
          .child(this.tab === "conversation" ? this.conversation() : this.tab === "files" ? this.filesTab() : this.checksTab())));
  }
}
