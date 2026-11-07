---
name: plan
description: Generate an autopilot PLAN.md from a description. Use when the user wants to write, create or draft a plan for the autopilot runner from a feature or task description.
argument-hint: <description of what to build>
---

# autopilot plan

Turn the user's description into a `PLAN.md` that `autopilot run` can execute: small ordered steps, each done in its own fresh session.

Description: $ARGUMENTS

If the description is empty, ask the user what they want to build and stop.

## Procedure

1. **Look at the repo first**: README, package/build files, the test command, `verify` in `.autopilot.json` (if present), `git log --oneline -n 10`, and the files the description touches. Ask the user a question only when the goal cannot be settled from the description plus the code.
2. **Check for an existing plan** (`PLAN.md`, or the path in `.autopilot.json`). If it has `[x]` or `[!]` steps or real content beyond the template, do not overwrite it silently. Show the new plan and ask whether to replace it, append new pending steps (continuing the ID numbers), or write it to another path.
3. **Write the plan** following the grammar below.
4. **Validate** with `autopilot status` (or `npx autopilot status` / `bunx autopilot status` if it is not installed). Exit code 2 means the plan is invalid: fix it and run again.
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
