// @ts-check
// Settings > Prompts (screen 12): global prompts in mods/pm/prompts/*.md, project overrides in
// <repo>/.herdr/prompts/<name>.md. One list, one editor, variable tokens that insert at the cursor.
import { TextareaState, Textarea } from "gpui-base";
import { run, appHome, notify } from "herdr";
import { C, SIZE, MONO, icon, h_flex, v_flex, div, sh, tilde, readTextFile, writeTextFile, Btn } from "./lib.js";

export const PROMPTS = [
  { name: "workspace", title: "New workspace", when: "When Claude starts in a worktree" },
  { name: "plan", title: "Plan", when: "In Plan mode: PLAN.md format" },
  { name: "handoff", title: "Hand off", when: "What the model that executes the plan receives" },
  { name: "pr", title: "PR creation", when: "Title, description, cleanup before the PR" },
  { name: "fix-ci", title: "Fix CI", when: "With the logs of the failing checks" },
  { name: "routine-report", title: "Routine report", when: "Template: did / recommends / questions" },
  { name: "review", title: "Review comments", when: "When you send diff comments" },
];
const TOKENS = ["{branch}", "{base}", "{plan}", "{diff_stat}", "{linear_issue}"];
const ROUTINE_TOKENS = ["{routine}", "{reports}"];

export class Prompts {
  constructor(v, cx) {
    this.v = v;
    this.sel = "pr"; // PROMPTS name, or "claude-md"
    this.saved = null; this.over = new Set(); this.isOver = false; this.exists = true; this.target = null;
    // Textarea (not Editor): replace() inserts at the cursor, which the variable tokens need.
    this.editor = TextareaState.new({ value: "", rows: 20 });
    this.editor.set_soft_wrap(true);
    this.editor.on("change", (_e, cx) => cx.notify());
    this.refresh(cx);
  }

  globalPath(n) { return `${appHome()}/mods/pm/prompts/${n}.md`; }
  projectPath(n) { return this.v.root ? `${this.v.root}/.herdr/prompts/${n}.md` : null; }
  /** The file the editor saves to. */
  savePath() {
    if (this.sel === "claude-md") return `${this.v.root}/CLAUDE.md`;
    return this.v.scope === "project" && this.v.root ? this.projectPath(this.sel) : this.globalPath(this.sel);
  }
  dirty() { return this.editor.value() !== (this.saved ?? this.base ?? ""); }

  /** Re-reads which prompts are overridden and loads the selected one. */
  refresh(cx) {
    cx.spawn(async (cx) => {
      this.over = new Set();
      if (this.v.scope === "project" && this.v.root) {
        for (const p of PROMPTS) if ((await readTextFile(this.projectPath(p.name)).catch(() => null)) !== null) this.over.add(p.name);
      }
      this.claudeMd = this.v.root ? (await readTextFile(`${this.v.root}/CLAUDE.md`).catch(() => null)) !== null : false;
      await this.load(cx);
    });
  }

  async load(cx) {
    let text;
    if (this.sel === "claude-md") {
      text = await readTextFile(`${this.v.root}/CLAUDE.md`).catch(() => null);
      this.exists = text !== null; this.isOver = false;
    } else {
      const over = this.v.scope === "project" && this.over.has(this.sel);
      this.isOver = over;
      text = await readTextFile(over ? this.projectPath(this.sel) : this.globalPath(this.sel)).catch(() => null);
      this.exists = text !== null;
    }
    // In project scope without an override the file to save does not exist yet: saved = null.
    const target = await readTextFile(this.savePath()).catch(() => null);
    this.saved = target;
    this.editor.set_value(text ?? "");
    this.base = text ?? "";
    cx.notify();
  }

  pick(name, cx) { this.sel = name; this.load(cx); }

  save(cx) {
    const path = this.savePath(), text = this.editor.value();
    cx.spawn(async (cx) => {
      try {
        if (this.saved === null) await sh("mkdir", ["-p", path.slice(0, path.lastIndexOf("/"))]);
        await writeTextFile(path, text, this.saved);
        this.saved = text; this.base = text;
        if (this.v.scope === "project" && this.sel !== "claude-md") this.over.add(this.sel);
        if (this.sel === "claude-md") this.claudeMd = true;
        this.isOver = this.over.has(this.sel);
        notify({ title: "Saved", body: tilde(path), level: "success", timeout: 2500 });
      } catch (e) { notify({ title: "Could not save", body: String(e), level: "error" }); }
      cx.notify();
    });
  }

  /** Drops the project override: the global prompt applies again. */
  back(cx) {
    const path = this.projectPath(this.sel);
    cx.spawn(async (cx) => {
      await sh("rm", ["-f", path]);
      this.over.delete(this.sel);
      await this.load(cx);
    });
  }

  insert(token, cx) {
    this.editor.replace(token);
    this.editor.focus();
    cx.notify();
  }

  openClaudeMd(cx) {
    const root = this.v.root;
    if (!root) return;
    if (this.claudeMd) run("tab.new", { name: "CLAUDE.md", mod: "pm-md", props: { path: "CLAUDE.md", root } });
    else { this.sel = "claude-md"; this.load(cx); }
  }

  list(cx) {
    const proj = this.v.scope === "project";
    const row = (p) => {
      const on = this.sel === p.name;
      return v_flex().id(`pr-${p.name}`).mx(8).px(10).py(8).gap(2).rounded(7).cursor_pointer()
        .when(on, (e) => e.bg(C.raised)).when(!on, (e) => e.hover((s) => s.bg("#221D17")))
        .on_click((_e, cx) => this.pick(p.name, cx))
        .child(h_flex().items_center().gap(8).child(div().flex_1().text_size(SIZE.body).text_color(C.text).child(p.title))
          .when(this.over.has(p.name), (e) => e.child(div().px(6).rounded(4).bg("#3A2A1C").text_size(10).text_color(C.ember).child("project"))))
        .child(div().text_size(SIZE.meta).text_color(C.muted).child(p.when));
    };
    const claudeSub = this.v.root ? (this.claudeMd ? "Always read by Claude. Opens in a Markdown tab" : "No CLAUDE.md yet. Write one here") : "Open a project to edit its CLAUDE.md";
    return v_flex().w(330).flex_none().h_full().min_h(0).border_r(1).border_color(C.line1)
      .child(v_flex().px(18).pt(16).pb(10).gap(4)
        .child(div().text_size(SIZE.title).font_semibold().text_color(C.text).child("Harness prompts"))
        .child(div().text_size(SIZE.meta).text_color(C.muted).child(proj ? "What Claude receives at each key moment. The project overrides the global." : "What Claude receives at each key moment. Global defaults for every project.")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().pb(12)
        .child(h_flex().id("pr-claude").mx(8).px(10).py(8).gap(10).items_center().rounded(7).border_b(1).border_color(C.line1)
          .when(Boolean(this.v.root), (e) => e.cursor_pointer().hover((s) => s.bg("#221D17")).on_click((_e, cx) => this.openClaudeMd(cx)))
          .child(icon("file-text", 14, C.link))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(SIZE.body).text_color(C.link).child("Project instructions · CLAUDE.md"))
            .child(div().text_size(SIZE.meta).text_color(C.muted).child(claudeSub)))
          .child(icon("arrow-up-right", 12, C.dim)))
        .children(PROMPTS.map(row)));
  }

  editorPane(cx) {
    const proj = this.v.scope === "project" && this.v.root;
    const isMd = this.sel === "claude-md";
    const path = this.savePath();
    const rel = isMd ? `${this.v.rootName}/CLAUDE.md` : proj ? `${this.v.rootName}/.herdr/prompts/${this.sel}.md` : `mods/pm/prompts/${this.sel}.md`;
    const dirty = this.dirty();
    const tokens = this.sel === "routine-report" ? [...TOKENS, ...ROUTINE_TOKENS] : TOKENS;
    return v_flex().flex_1().min_w(0).h_full().min_h(0)
      .child(h_flex().h(60).flex_none().px(18).gap(10).items_center().border_b(1).border_color(C.line1)
        .child(div().flex_1().min_w(0).font_family(MONO).text_size(SIZE.meta).text_color(C.text2)
          .child(rel).child(div().text_color(C.dim).child(isMd ? (this.exists ? "" : "new file, created when you save") : proj ? (this.isOver ? "overrides the global" : "uses the global until you save") : "global")))
        .when(dirty, (e) => e.child(h_flex().gap(6).items_center().flex_none().child(icon("dot", 10, C.ember)).child(div().text_size(SIZE.meta).text_color(C.muted).child("Unsaved"))))
        .when(this.isOver && proj, (e) => e.child(Btn("pr-back", "Back to global", (_e, cx) => this.back(cx), { small: true })))
        .child(Btn("pr-save", "Save", (_e, cx) => this.save(cx), { primary: true, disabled: !dirty })))
      .child(div().id("pr-editor").flex_1().min_h(0).px(18).py(14).child(Textarea.new(this.editor).size_full().font_family(MONO).text_size(13).text_color(C.text2)))
      .child(h_flex().min_h(48).flex_none().flex_wrap().px(18).py(10).gap(8).items_center().border_t(1).border_color(C.line1)
        .child(div().text_size(SIZE.meta).text_color(C.dim).mr(4).child("Insert"))
        .children(tokens.map((t) => div().id(`tok-${t}`).h(24).px(8).flex().items_center().rounded(5).bg(C.raised).cursor_pointer()
          .font_family(MONO).text_size(SIZE.meta).text_color(C.text2).hover((s) => s.text_color(C.ember)).on_click((_e, cx) => this.insert(t, cx)).child(t))));
  }

  render(cx) {
    return h_flex().size_full().min_w(0).child(this.list(cx)).child(this.editorPane(cx));
  }
}
