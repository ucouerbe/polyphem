# PR creation

Before creating the PR:
- Remove PLAN.md from the worktree first (commit it as "chore: remove plan").
- Check that lint and tests pass locally.

Title: a conventional commit title in English, 72 characters max.

Description, in English, with these three sections:
- **Why**: one sentence, taken from the plan.
- **What changes**: 3 to 5 user-facing bullets.
- **How to test**: manual steps.

Link the Linear ticket ({linear_issue}) in the description when there is one.

Branch: `{branch}` into `{base}`. Diff summary:

{diff_stat}

Never mention local config files.
