---
name: run
description: Run the autopilot plan. Use when the user wants to execute, start or continue PLAN.md with the autopilot runner, one fresh Claude Code session per step.
argument-hint: [autopilot run flags]
---

# autopilot run

A thin wrapper around the `autopilot run` CLI. The runner owns progress: it verifies each step, ticks the checkbox, writes `HANDOFF.md` and commits. You only start it and report the outcome.

Flags passed by the user: $ARGUMENTS

## Procedure

1. **Resolve the command**, first match wins: `autopilot` on PATH; `npx @rockberpro-labs/autopilot` (or `bunx` in a Bun project) if the package resolves; otherwise the plugin's own sources, `node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts"` (needs Node 23.6+; add `--backend cli` to `run` unless the plugin directory has `node_modules`). Never use a bare `npx autopilot`: without a local install it fetches an unrelated npm package. Call the result `autopilot` below.
2. **Preflight**, stopping at the first failure:
   - The plan path is `plan` in `.autopilot.json`, else `--plan` from the flags, else `PLAN.md`. If `PLAN.md` is not in the autopilot grammar but another file is (for example `AUTOPILOT_PLAN.md`), say so and offer to record it with `"plan"` in `.autopilot.json`.
   - `autopilot status`: exit 2 means the plan is invalid. Show the errors and stop (offer `/autopilot:plan` or a manual fix).
   - `.claude/skills/autopilot-step/SKILL.md` must exist. If not, offer `autopilot init` (it never overwrites; it also creates `PLAN.md` and `HANDOFF.md` only if missing). After it runs the tree is dirty, so stop and ask the user to review and commit.
   - `git status --porcelain`: if the tree is dirty, list the changed and untracked files, say that run needs a clean tree and stop, unless `--allow-dirty` is in the flags. Never commit them yourself.
3. **Dry run**: `autopilot run --dry-run <flags>`. Show the next step and a short summary of the prompt. If `--dry-run` was already in the flags, stop here. Otherwise confirm with the user before continuing, unless they already said to go ahead.
4. **Run**: `autopilot run <flags>` in the background (`run_in_background`), since it starts nested Claude sessions and can take a long time. Do not poll; wait for the completion notice.
5. **Report by exit code**:
   - 0: plan complete, or `--max-steps` / `--only` finished.
   - 1: a step failed or is blocked. Show the `[!]` step and its reason from the last `HANDOFF.md` entry.
   - 2: invalid plan or config. 3: budget exceeded. 4: dirty working tree. 130: interrupted, tree left as is.

   Then show `autopilot status` and the new `autopilot:` commits (`git log --oneline`).

## Rules

- Never edit `PLAN.md` checkboxes or `HANDOFF.md`, and never commit, push or `git reset` yourself. The runner does all of that.
- If a step is blocked or failed, explain why and offer to refine that step with `/autopilot:plan` or by hand. Do not fix the code yourself.
