---
name: plan
description: Generate an autopilot PLAN.md from a description, or convert an existing plan (a file path, pasted text, or one drafted earlier in the conversation). Use when the user wants to write, create, draft or convert a plan for the autopilot runner.
argument-hint: <what to build | path to an existing plan | pasted plan>
---

# autopilot plan

Turn the user's input into a `PLAN.md` that `autopilot run` can execute: small ordered steps, each done in its own fresh session.

Input: $ARGUMENTS

## Pick the mode

Decide what the input is, and say which mode you picked in your first line ("Converting <source>" or "Planning from your description") so a wrong guess is visible before anything is written.

- **Convert, file**: the input is a single token (or `--from <path>`) that resolves to an existing file, e.g. `~/.claude/plans/foo.md`. Read it and treat it as the source plan.
- **Convert, pasted**: the input is long or multi-line and already looks like a plan (headings, checklists, numbered steps). Treat it as the source plan.
- **Convert, conversation**: the input is empty and a plan was drafted earlier in this conversation (plan mode or another skill). Convert that one.
- **Describe**: anything else is a description of what to build. Plan it from scratch.

If the input is empty and there is no plan in the conversation, ask the user what they want to build and stop.

When converting: keep the source's order, intent and content; add IDs, `Details:`, `Acceptance:` and `Verify:`; split items too big for one session; flag gaps you cannot fill from the source instead of inventing scope.

## Procedure

1. **Look at the repo first**: README, package/build files, the test command, `verify` in `.autopilot.json` (if present), `git log --oneline -n 10`, and the files the description touches. Ask the user a question only when the goal cannot be settled from the description plus the code.
2. **Check for an existing plan** (`PLAN.md`, or the path in `.autopilot.json`). If it has `[x]` or `[!]` steps or real content beyond the template, do not overwrite it silently. Show the new plan and ask whether to replace it, append new pending steps (continuing the ID numbers), or write it to another path. This guard is about the target file, not the source: if the source plan *is* the target `PLAN.md`, converting it in place counts as a replace and needs confirmation too.
3. **Write the plan** following the grammar below.
4. **Validate** with `autopilot status` (or `npx @rockberpro-labs/autopilot status` / `bunx @rockberpro-labs/autopilot status` if it is not installed). Exit code 2 means the plan is invalid: fix it and run again.
5. **Stop.** Do not commit and do not run `autopilot run`. Tell the user to review the plan, commit it (run requires a clean tree), then try `autopilot run --dry-run`.

## Grammar

```markdown
# Plan: <title>

Short context every step needs: goal, constraints, conventions.

## Steps

- [ ] S01: Imperative step title
  - Details: what to build, which files or modules.
  - Acceptance: objective check, e.g. `bun test test/x.test.ts` passes.
  - Verify: bun test test/x.test.ts
```

- Step line: `- [ ] S01: title`. IDs are `S01`, `S02`, ... unique and in order. New steps are always `[ ]`.
- Body lines are indented under the step. `Verify:` is optional; add it only when it differs from the global verify command.
- Never write a line starting with `- [` outside a step. Put examples in code fences.

## Writing good steps

- Each step must be finishable in one session and leave the repo passing its verify command.
- Order steps so each builds on the previous one; put tests with the code they cover.
- Acceptance criteria must be observable and checkable by a command, not "works well".
- Keep the context paragraph short: every step reads it.
- Do not invent requirements the description does not imply.
