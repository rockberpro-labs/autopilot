# autopilot: Specification

## 1. Overview

`autopilot` is a TypeScript CLI, run with Bun, that executes a multi-step implementation plan using Claude Code in fully automated mode. Each step runs in a **fresh Claude Code session** to avoid context degradation. Continuity between steps is preserved entirely on disk through a plan file, a handoff log and git history.

The runner is the authority over progress. The agent implements a step and reports back; the runner verifies the result, updates the plan, records the handoff and commits.

Distribution: an npm package with a `bin` entry, runnable as `bunx autopilot` in any repository.

## 2. Goals and non-goals

### Goals

- Execute plan steps sequentially, one fresh session per step.
- Keep the thread between steps through files and git, never through session context.
- Gate every step behind an objective verification command.
- Stop safely on failure, lack of progress or budget exhaustion, leaving the repo in a clean, inspectable state.
- Ship a `autopilot-step` skill that defines the per-step protocol for the agent.
- Be usable manually too: a human can run a single step and get the same behavior.

### Non-goals (v1)

- Parallel step execution.
- Writing the plan inside the runner. The runner treats the plan as an input; generating one from a description is done by the `/autopilot:plan` skill of the Claude Code plugin (`skills/plan/SKILL.md`). The plugin's `/autopilot:run` (`skills/run/SKILL.md`) only wraps the CLI and adds no runner logic.
- A UI beyond terminal output.
- Remote execution or CI integration (it should work in CI, but no special support).

## 3. Tech stack

- Runtime: Bun (latest stable). TypeScript executed directly, no build step.
- Agent engine: `@anthropic-ai/claude-agent-sdk` (primary backend).
- Alternative backend: the `claude` CLI in headless mode (`claude -p ... --output-format json`), spawned with `Bun.spawn`.
- Argument parsing: a small dependency-free parser or `util.parseArgs` (available in Bun). Avoid heavy CLI frameworks.
- Tests: `bun test`.

> Note for the implementer: the Agent SDK API has changed across versions. Before writing backend code, check the installed package's type definitions for `query()` options and message types (`settingSources`, `allowedTools`, `permissionMode`, `maxTurns`, the `result` message shape). Adapt to what is actually exported. Do not guess option names.

## 4. Project layout

```
autopilot/
├── package.json            # "bin": { "autopilot": "./src/cli.ts" }
├── README.md
├── src/
│   ├── cli.ts              # entry point, #!/usr/bin/env bun
│   ├── commands/
│   │   ├── init.ts
│   │   ├── run.ts
│   │   └── status.ts
│   ├── plan.ts             # PLAN.md parsing and updating
│   ├── handoff.ts          # HANDOFF.md appending
│   ├── result.ts           # step-result.json schema and validation
│   ├── git.ts              # git helpers
│   ├── verify.ts           # runs the verification command
│   ├── prompt.ts           # builds the per-step prompt
│   ├── backends/
│   │   ├── types.ts        # Backend interface
│   │   ├── sdk.ts          # Agent SDK backend
│   │   └── cli.ts          # claude -p backend
│   ├── config.ts           # config file + flag merging
│   └── log.ts              # run logs and terminal output
├── templates/
│   ├── PLAN.md
│   ├── HANDOFF.md
│   └── skills/autopilot-step/SKILL.md
└── test/
```

## 5. File formats

All runner state lives in the target repository:

```
<repo>/
├── PLAN.md
├── HANDOFF.md
├── .autopilot.json            # optional config
├── .claude/skills/autopilot-step/SKILL.md
└── .autopilot/
    ├── step-result.json         # written by the agent, consumed by the runner
    └── runs/<run-id>/           # logs per run
```

`.autopilot/` must be added to `.gitignore` by `init`, except that logs may be optionally kept (see config).

### 5.1 PLAN.md

Free-form markdown, with steps expressed as checklist items using this grammar:

```markdown
# Plan: <title>

Context paragraph(s) the agent should read every step.

## Steps

- [ ] S01: Create the database schema for invoices
  - Details: tables invoices and invoice_items, FK to customers.
  - Acceptance: migration runs; `bun test test/schema.test.ts` passes.
- [ ] S02: Implement the invoice repository
  - Acceptance: CRUD covered by tests.
- [x] S00: Already done step
- [!] S03: A blocked step
```

Rules:

- A step line matches `^- \[( |x|!)\] (S\d+): (.+)$`.
- `[ ]` pending, `[x]` done, `[!]` blocked.
- Indented lines under a step belong to that step (its body).
- Step IDs must be unique. The parser reports duplicates and malformed lines as errors.
- The next step is the first `[ ]` in document order.
- Only the runner modifies checkbox state. Everything else in the file is preserved byte for byte when updating.

### 5.2 HANDOFF.md

Append-only log, newest entry last:

```markdown
# Handoff log

## S01: Create the database schema for invoices
- Date: 2026-11-07T14:02:11Z
- Commit: a1b2c3d
- Summary: Added migration 0007 with invoices and invoice_items.
- Notes for next steps: invoice_items.amount is stored in cents (integer).
```

The runner writes entries from `step-result.json`. If the file grows beyond a configurable size (default 12 KB), the runner warns, and the prompt tells the agent to focus on the last N entries (default 8). No automatic summarization in v1.

### 5.3 step-result.json

Written by the agent at the end of a step. Schema:

```ts
type StepResult = {
  stepId: string;               // must match the step assigned
  status: "done" | "blocked";
  summary: string;              // 1 to 3 sentences
  notes?: string;               // facts the next steps need
  blockedReason?: string;       // required when status is "blocked"
};
```

Validate strictly. A missing, malformed or mismatched file counts as a failed attempt.

## 6. The autopilot-step skill

`init` scaffolds `.claude/skills/autopilot-step/SKILL.md`. It must instruct the agent to:

1. Read `PLAN.md` fully, then the most recent entries of `HANDOFF.md`.
2. Work **only** on the step ID given in the prompt. Never touch other steps.
3. Inspect recent git history (`git log --oneline -n 10`) and relevant files before changing anything.
4. Implement the step to satisfy its acceptance criteria.
5. Run the project's verification command (given in the prompt) and fix failures before finishing.
6. **Not** edit checkboxes in `PLAN.md`, **not** edit `HANDOFF.md`, and **not** commit. The runner does those.
7. Write `.autopilot/step-result.json` as the final action.
8. If the step cannot be completed (missing information, contradictory plan, external dependency), stop early and write a `blocked` result with a precise reason instead of improvising scope.

The skill frontmatter description should make it clear it is used for executing a single step of a autopilot plan.

## 7. CLI

```
autopilot init                 # scaffold PLAN.md, HANDOFF.md, skill, config, .gitignore entry
autopilot status               # show steps, states, next step
autopilot run [options]        # execute pending steps
```

### `run` options

| Flag | Default | Meaning |
|---|---|---|
| `--plan <path>` | `PLAN.md` | Plan file |
| `--handoff <path>` | `HANDOFF.md` | Handoff file |
| `--backend <sdk\|cli>` | `sdk` | Agent backend |
| `--verify <cmd>` | from config, else none | Verification command run by the runner after each step |
| `--max-steps <n>` | unlimited | Stop after n completed steps |
| `--only <id>` | | Run just this step |
| `--max-turns <n>` | `80` | Agent turn cap per attempt |
| `--retries <n>` | `1` | Extra attempts per step after a failed verification |
| `--budget <usd>` | unlimited | Stop when accumulated cost exceeds this |
| `--model <name>` | backend default | Model override |
| `--permission-mode <mode>` | `acceptEdits` | Passed to the backend |
| `--allow-dirty` | false | Skip the clean-tree check |
| `--branch <name>` | | Create/checkout this branch before starting |
| `--dry-run` | false | Print the next step and the prompt, run nothing |

Exit codes: `0` plan complete or `--max-steps` reached, `1` step failed or blocked, `2` invalid plan or config, `3` budget exceeded, `4` dirty working tree, `130` interrupted.

### Config file

`.autopilot.json` with the same keys as the flags (camelCase), plus:

```json
{
  "verify": "bun test",
  "allowedTools": ["Skill", "Read", "Edit", "Write", "Glob", "Grep", "Bash(bun test:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)"],
  "handoffTail": 8,
  "keepLogs": false
}
```

Flags override the config file. Note that the agent must not be allowed `git commit`; only read-only git commands.

## 8. Run loop

```
validate plan → check clean tree (unless --allow-dirty) → optional branch
loop:
  step = next pending step (or --only)
  if none: exit 0
  for attempt in 1..(1 + retries):
    delete stale .autopilot/step-result.json
    prompt = buildPrompt(step, verifyCmd, previousFailure?)
    run backend in a FRESH session (no resume, no shared state)
    stream progress to terminal, log all messages
    read + validate step-result.json
    if result.status == "blocked":
      mark [!], append handoff entry with reason, commit plan + handoff, exit 1
    run verify command (if configured)
    if valid result and verify passed: break (success)
    else: previousFailure = tail of verify output / validation error
          reset working tree to the step's starting commit (git reset --hard + git clean -fd, scoped safely)
  if no success: mark [!] with reason "failed verification", commit plan + handoff only, exit 1
  mark [x], append handoff entry, commit everything:
    message "autopilot: S01 <title>"
  record commit hash in the handoff entry (amend or write before commit using a two-phase approach; implementer's choice, document it)
  check budget, max-steps
```

Requirements:

- Each attempt is an independent session. Never use session resume between steps or attempts.
- A retry prompt includes the previous failure output (truncated to a sensible size, e.g. last 200 lines) so the fresh session knows what went wrong.
- `git clean` must never delete `.autopilot/runs/` or ignored config. Exclude it explicitly.
- The runner must handle SIGINT: stop the current backend process, leave the tree as is, print how to resume, exit 130. Resuming means simply running `autopilot run` again (after the user inspects or resets the tree).
- No-progress guard: if a step is marked done but the plan has the same pending count afterwards, abort with an error (defensive check against parser bugs).

## 9. Prompt

Built in `prompt.ts`. Must be short and point to the skill rather than duplicating it:

```
Use the autopilot-step skill.
Assigned step: S02 "Implement the invoice repository".
Verification command: bun test
Read only the last 8 entries of HANDOFF.md.
[If retry:] The previous attempt failed. Failure output:
<truncated output>
```

## 10. Backends

```ts
interface Backend {
  runStep(input: {
    prompt: string;
    cwd: string;
    allowedTools: string[];
    permissionMode: string;
    maxTurns: number;
    model?: string;
    signal: AbortSignal;
    onEvent: (e: BackendEvent) => void;   // for progress output and logs
  }): Promise<{ ok: boolean; costUsd?: number; turns?: number; error?: string }>;
}
```

- **sdk**: uses `query()` from `@anthropic-ai/claude-agent-sdk`. Must load project settings so the skill and `CLAUDE.md` are visible (`settingSources: ["project"]` or the current equivalent). `"Skill"` must be in allowed tools.
- **cli**: spawns `claude -p <prompt> --output-format stream-json` (or `json` if streaming is impractical) with the equivalent flags. Parses cost and turns from the result when available. Fails with a clear message if `claude` is not on PATH.

## 11. Output and logging

- Terminal: one line per step start, compact progress (tool names as they are used), and a summary line per step: status, attempts, turns, cost, duration.
- Final summary: steps done, blocked, total cost, total time.
- Logs: every backend event for each attempt written as JSONL to `.autopilot/runs/<run-id>/<stepId>-<attempt>.jsonl`.
- `--verbose` prints assistant text as it streams.

## 12. Safety

- Refuse to start on a dirty working tree unless `--allow-dirty`.
- Never push. Never touch remotes.
- Default permission mode is `acceptEdits` with an explicit tool allowlist. Document in the README that bypass-style modes are the user's responsibility and should be used only in a disposable environment (container or VM).
- Never write secrets to logs: redact environment variables that look like keys (`*_KEY`, `*_TOKEN`, `*_SECRET`) if they appear in output.

## 13. Testing

- Unit tests for the plan parser and updater: valid plans, malformed lines, duplicate IDs, byte-for-byte preservation of untouched content, state transitions.
- Unit tests for `step-result.json` validation.
- Unit tests for prompt building (including retry truncation).
- Integration test of the run loop using a **fake backend** that edits files and writes a step result in a temporary git repo: covers success, verify failure then retry success, retry exhaustion, blocked result, missing result file, budget stop, SIGINT handling.
- No tests may call the real API.

## 14. Acceptance criteria

1. `bunx autopilot init` in an empty git repo creates `PLAN.md`, `HANDOFF.md`, the skill, `.autopilot.json` and the `.gitignore` entry, without overwriting existing files (it reports what it skipped).
2. `autopilot status` lists steps with their states and the next step.
3. `autopilot run` on a 3-step plan with a passing verify command produces 3 commits, 3 handoff entries and all boxes checked, each step having run in its own session.
4. A failing verify causes a retry in a fresh session with the failure output in the prompt; after retries are exhausted the step is marked `[!]`, the code changes are discarded, and the runner exits 1.
5. A `blocked` result marks `[!]`, records the reason in the handoff and exits 1 without retrying.
6. `--dry-run` prints the next step and the exact prompt and changes nothing.
7. `bun test` passes with no network access.
8. The README documents installation, the plan grammar, the skill protocol, configuration, exit codes and the safety notes.

## 15. Open questions (decide and document)

- Whether to record the commit hash in the handoff via a second commit, an amend, or by writing the entry before committing and omitting the hash. Pick the simplest correct option.
- Whether steps should support an optional per-step `Verify:` line that overrides the global command. Nice to have; implement only if trivial.
