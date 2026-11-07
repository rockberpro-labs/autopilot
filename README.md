# autopilot

Runs a multi-step implementation plan with Claude Code, **one fresh session per step**. Continuity lives on disk (plan, handoff log, git history), never in session context. The runner is the authority over progress: the agent implements a step and reports back; the runner verifies, updates the plan, writes the handoff and commits.

## Install

Requires Node.js 20 or newer and git. Bun is **not** required.

```sh
npx autopilot init         # in a git repository
```

Or install it globally:

```sh
npm install -g autopilot
autopilot init
```

Bun users can run it the same way: `bunx autopilot init`.

The `sdk` backend uses `@anthropic-ai/claude-agent-sdk`; the `cli` backend needs `claude` on PATH. The examples below use the bare `autopilot` command; prefix it with `npx` (or `bunx`) if you did not install it globally.

## Quick start

```sh
autopilot init                  # PLAN.md, HANDOFF.md, skill, .autopilot.json, .gitignore entry
$EDITOR PLAN.md                 # or generate it: /autopilot:plan <description> (see below)
git add -A && git commit -m "autopilot scaffold"   # run requires a clean tree
autopilot status
autopilot run --dry-run         # shows the next step and the exact prompt
autopilot run
```

`init` never overwrites existing files and reports what it skipped.

## Claude Code plugin

The repo is also a Claude Code plugin. Install it, then describe what you want and run it:

```
/plugin marketplace add rockberpro-labs/autopilot
/plugin install autopilot@autopilot
/autopilot:plan add a --json flag to the status command
/autopilot:run --max-steps 1
```

`/autopilot:plan` reads the repo, writes a `PLAN.md` in the grammar below and validates it with `autopilot status`. If a plan with progress or content already exists, it asks before replacing or appending. It never commits or runs the plan.

`/autopilot:run [flags]` wraps `autopilot run`: it checks the plan and the clean tree, shows a dry run, asks for confirmation, then runs in the background and reports the exit code. It adds no runner logic; the CLI stays the authority over progress.

## Plan grammar

```markdown
# Plan: <title>

Context the agent reads every step.

## Steps

- [ ] S01: Create the database schema
  - Details: tables invoices and invoice_items.
  - Acceptance: migration runs; `bun test test/schema.test.ts` passes.
  - Verify: bun test test/schema.test.ts
- [x] S00: Already done
- [!] S03: Blocked
```

- Step line: `^- \[( |x|!)\] (S\d+): (.+)$`. `[ ]` pending, `[x]` done, `[!]` blocked.
- Indented lines under a step are its body. IDs must be unique. Malformed or duplicate steps make the plan invalid (exit 2). Lines inside code fences are ignored.
- The next step is the first `[ ]` in document order.
- Only the runner changes checkboxes, and only the single checkbox character: everything else is preserved byte for byte.
- Optional `Verify: <cmd>` body line overrides the global verify command for that step.

## Skill protocol

`init` scaffolds `.claude/skills/autopilot-step/SKILL.md`. For its single step the agent must: read `PLAN.md` and the last handoff entries; work only on the assigned step; inspect git history; implement; run the verification command; **not** edit checkboxes, `HANDOFF.md`, or commit; write `.autopilot/step-result.json` last; and write a `blocked` result with a precise reason rather than improvising.

```ts
type StepResult = {
  stepId: string;               // must match the assigned step
  status: "done" | "blocked";
  summary: string;
  notes?: string;
  blockedReason?: string;       // required when blocked
};
```

A missing, malformed or mismatched file counts as a failed attempt.

## Run loop

For each pending step, up to `1 + retries` attempts, each in a brand-new session (never resumed):

1. Delete the stale `step-result.json`, build the prompt (plus the previous failure's last 200 lines on retries), run the backend.
2. Restore `PLAN.md` / `HANDOFF.md` from the text captured at step start (anything the agent did to them is discarded). If the agent committed, the attempt fails and the commit is undone.
3. Validate the result. `blocked` → mark `[!]`, record the reason, commit plan + handoff, exit 1, no retry.
4. Run the verify command. Failure → `git reset --hard` + `git clean -fd -e .autopilot` to the step's starting commit, then retry.
5. Success → mark `[x]`, append the handoff entry, commit everything as `autopilot: S01 <title>`.

Exhausted retries mark the step `[!]` ("failed verification"), discard code changes and commit only plan + handoff.

### Design decisions

- **Commit hash in the handoff**: a commit cannot contain its own hash, and an amend or a second commit would break "one commit per step". The handoff entry records `Base:` (the commit the step started from); the step's commit is the one titled `autopilot: <id> <title>`.
- **Per-step `Verify:`** is supported.
- **Runner state** (`.autopilot/`) is excluded from commits and from the clean-tree check via pathspec, so it works even if `.gitignore` lacks the entry. `git clean` never uses `-x`.
- **Budget**: checked after every attempt. A finished step is committed before stopping with exit 3; an unfinished one is discarded and left `[ ]`. The `cli` backend reports cost when `claude` does; otherwise a warning says the budget cannot be enforced.
- **`cli` backend turn cap**: the `claude` CLI has no turn-limit flag, so autopilot counts assistant messages and kills the process past `--max-turns`.
- **`--allow-dirty`**: the runner never resets in this mode (it would destroy your uncommitted work). Failed attempts are not rolled back, retries run on top of the previous attempt, and your pre-existing changes end up in the step commit.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--plan <path>` | `PLAN.md` | Plan file |
| `--handoff <path>` | `HANDOFF.md` | Handoff file |
| `--backend <sdk\|cli>` | `sdk` | Agent backend |
| `--verify <cmd>` | config | Verification command run after each step |
| `--max-steps <n>` | unlimited | Stop after n completed steps |
| `--only <id>` | | Run just this step |
| `--max-turns <n>` | `80` | Turn cap per attempt |
| `--retries <n>` | `1` | Extra attempts after a failed attempt |
| `--budget <usd>` | unlimited | Stop when accumulated cost exceeds this |
| `--model <name>` | backend default | Model override |
| `--permission-mode <mode>` | `acceptEdits` | Passed to the backend |
| `--allow-dirty` | false | Skip the clean-tree check |
| `--branch <name>` | | Create/checkout this branch first |
| `--dry-run` | false | Print next step and prompt, change nothing |
| `--verbose` | false | Print assistant text as it streams |

### `.autopilot.json`

Same keys as the flags (camelCase), plus:

```json
{
  "verify": "bun test",
  "allowedTools": ["Skill", "Read", "Edit", "Write", "Glob", "Grep", "Bash(bun test:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)"],
  "disallowedTools": ["Bash(git commit:*)", "Bash(git push:*)"],
  "handoffTail": 8,
  "handoffMaxBytes": 12288,
  "keepLogs": false
}
```

Flags override the config file. The verify command (global and per-step) is automatically added to the agent's allowed tools so it can run it. Bare `Bash` and `Bash(git:*)` are rejected, since the agent must not commit. `HANDOFF.md` over `handoffMaxBytes` triggers a warning; the prompt always tells the agent to read only the last `handoffTail` entries.

Logs: every backend event, as JSONL (secret-looking env values redacted), in `.autopilot/runs/<run-id>/<stepId>-<attempt>.jsonl`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Plan complete, or `--max-steps` / `--only` finished |
| 1 | Step failed or blocked |
| 2 | Invalid plan or config |
| 3 | Budget exceeded |
| 4 | Dirty working tree |
| 130 | Interrupted (SIGINT): tree left as is; run `autopilot run` again after inspecting it |

## Safety

- Refuses to start on a dirty tree unless `--allow-dirty`. Never pushes, never touches remotes.
- Default `acceptEdits` plus an explicit allowlist; `git commit` / `git push` are denied to the agent.
- **Bypass-style permission modes (`bypassPermissions`) are your responsibility.** Use them only in a disposable environment (container or VM).
- Values of env vars named `*_KEY`, `*_TOKEN`, `*_SECRET` are redacted from logs and verify output.

## Development

Contributors use Bun for tests and for running the TypeScript sources directly. The published package ships compiled JavaScript and runs on plain Node.

```sh
bun install
bun test                 # offline; uses a fake backend, never calls the API
bun src/cli.ts --help    # run from source
bunx tsc --noEmit        # typecheck
npm run build            # compile src/ to dist/ (also runs on npm pack / publish)
```
