import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, StepRunInput, StepRunOutput } from "../src/backends/types.ts";
import { runInit } from "../src/commands/init.ts";
import { runPlan } from "../src/commands/run.ts";
import { runStatus } from "../src/commands/status.ts";
import { DEFAULTS, type RunOptions } from "../src/config.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
Object.assign(process.env, GIT_ENV);

function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd });
  return p.stdout.toString().trim();
}

const PLAN3 = `# Plan: t

## Steps

- [ ] S01: one
- [ ] S02: two
- [ ] S03: three
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autopilot-"));
  sh(dir, "git init -q && git config commit.gpgsign false && git config user.name t && git config user.email t@t");
  writeFileSync(join(dir, "PLAN.md"), PLAN3);
  writeFileSync(join(dir, "HANDOFF.md"), "# Handoff log\n");
  sh(dir, "git add -A && git commit -q -m init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Script = (call: number, input: StepRunInput, cwd: string) => Promise<StepRunOutput> | StepRunOutput;

class FakeBackend implements Backend {
  calls: StepRunInput[] = [];
  constructor(private script: Script) {}
  async runStep(input: StepRunInput) {
    this.calls.push(input);
    return this.script(this.calls.length, input, input.cwd);
  }
}

function stepIdOf(input: StepRunInput): string {
  return /Assigned step: (S\d+)/.exec(input.prompt)![1]!;
}

function writeResult(cwd: string, result: object) {
  writeFileSync(join(cwd, ".autopilot", "step-result.json"), JSON.stringify(result));
}

const good = (cost = 0.01): Script => (_n, input, cwd) => {
  const id = stepIdOf(input);
  writeFileSync(join(cwd, `${id}.txt`), id);
  writeResult(cwd, { stepId: id, status: "done", summary: `did ${id}`, notes: `note ${id}` });
  return { ok: true, costUsd: cost, turns: 3 };
};

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return { ...DEFAULTS, ...over };
}

async function run(backend: Backend, o: Partial<RunOptions> = {}, signal = new AbortController().signal) {
  const lines: string[] = [];
  const code = await runPlan(opts(o), { backend, signal, cwd: dir, out: (l) => lines.push(l) });
  return { code, lines, text: lines.join("\n") };
}

const plan = () => readFileSync(join(dir, "PLAN.md"), "utf8");
const handoff = () => readFileSync(join(dir, "HANDOFF.md"), "utf8");
const commitCount = () => Number(sh(dir, "git rev-list --count HEAD"));

describe("run loop", () => {
  test("3 steps: 3 commits, 3 handoff entries, 3 fresh sessions", async () => {
    const b = new FakeBackend(good());
    const r = await run(b, { verify: "test -f S01.txt" });
    expect(r.code).toBe(0);
    expect(b.calls).toHaveLength(3);
    expect(plan()).not.toContain("[ ]");
    expect(commitCount()).toBe(4);
    expect(handoff().match(/^## S0\d/gm)).toHaveLength(3);
    expect(sh(dir, "git log --format=%s -n 3")).toContain("autopilot: S03 three");
    expect(sh(dir, "git status --porcelain -- . ':(exclude).autopilot'")).toBe("");
    // runner state is never committed even though .gitignore does not list it
    expect(sh(dir, "git ls-files .autopilot")).toBe("");
  });

  test("verify failure then retry succeeds, with failure output in the retry prompt", async () => {
    const b = new FakeBackend((n, input, cwd) => {
      const id = stepIdOf(input);
      if (n === 1) writeFileSync(join(cwd, "bad.txt"), "x");
      else writeFileSync(join(cwd, "ok.txt"), "x");
      writeResult(cwd, { stepId: id, status: "done", summary: "s" });
      return { ok: true, costUsd: 0.01 };
    });
    const r = await run(b, { only: "S01", verify: "test -f ok.txt || { echo MISSING-OK-FILE; exit 1; }" });
    expect(r.code).toBe(0);
    expect(b.calls).toHaveLength(2);
    expect(b.calls[1]!.prompt).toContain("The previous attempt failed");
    expect(b.calls[1]!.prompt).toContain("MISSING-OK-FILE");
    expect(existsSync(join(dir, "bad.txt"))).toBe(false); // first attempt discarded
    expect(plan()).toContain("[x] S01");
  });

  test("retries exhausted: step blocked, changes discarded, exit 1", async () => {
    const b = new FakeBackend((_n, input, cwd) => {
      writeFileSync(join(cwd, "junk.txt"), "x");
      writeResult(cwd, { stepId: stepIdOf(input), status: "done", summary: "s" });
      return { ok: true };
    });
    const r = await run(b, { verify: "false", retries: 1 });
    expect(r.code).toBe(1);
    expect(b.calls).toHaveLength(2);
    expect(plan()).toContain("[!] S01");
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
    expect(handoff()).toContain("failed verification");
    expect(sh(dir, "git status --porcelain -- . ':(exclude).autopilot'")).toBe("");
    expect(commitCount()).toBe(2);
  });

  test("blocked result: no retry, reason recorded, exit 1", async () => {
    const b = new FakeBackend((_n, input, cwd) => {
      writeFileSync(join(cwd, "partial.txt"), "x");
      writeResult(cwd, { stepId: stepIdOf(input), status: "blocked", summary: "s", blockedReason: "need API key" });
      return { ok: true };
    });
    const r = await run(b, { retries: 3 });
    expect(r.code).toBe(1);
    expect(b.calls).toHaveLength(1);
    expect(plan()).toContain("[!] S01");
    expect(handoff()).toContain("need API key");
    expect(existsSync(join(dir, "partial.txt"))).toBe(false);
  });

  test("missing result file counts as failed attempt", async () => {
    const b = new FakeBackend(() => ({ ok: true }));
    const r = await run(b, { retries: 0 });
    expect(r.code).toBe(1);
    expect(r.text).toContain("step-result.json was not written");
    expect(plan()).toContain("[!] S01");
  });

  test("backend ok:false is a failed attempt and its error reaches the retry", async () => {
    const b = new FakeBackend((n, input, cwd) => {
      if (n === 1) return { ok: false, error: "error_max_turns" };
      return good()(n, input, cwd);
    });
    const r = await run(b, { only: "S01" });
    expect(r.code).toBe(0);
    expect(b.calls[1]!.prompt).toContain("error_max_turns");
  });

  test("budget exceeded after a step stops with exit 3", async () => {
    const b = new FakeBackend(good(1));
    const r = await run(b, { budget: 1.5 });
    expect(r.code).toBe(3);
    expect(b.calls).toHaveLength(2);
    expect(plan()).toContain("[x] S02");
    expect(plan()).toContain("[ ] S03");
  });

  test("max-steps stops with exit 0", async () => {
    const b = new FakeBackend(good());
    const r = await run(b, { maxSteps: 2 });
    expect(r.code).toBe(0);
    expect(b.calls).toHaveLength(2);
  });

  test("agent edits to PLAN.md/HANDOFF.md are overwritten by the runner", async () => {
    const b = new FakeBackend((n, input, cwd) => {
      writeFileSync(join(cwd, "PLAN.md"), PLAN3.replace("[ ] S02", "[x] S02"));
      writeFileSync(join(cwd, "HANDOFF.md"), "# hijacked\n");
      return good()(n, input, cwd);
    });
    const r = await run(b, { only: "S01" });
    expect(r.code).toBe(0);
    expect(plan()).toContain("[ ] S02");
    expect(handoff()).not.toContain("hijacked");
  });

  test("agent commits make the attempt fail and are undone", async () => {
    const b = new FakeBackend((n, input, cwd) => {
      if (n === 1) sh(cwd, "echo y > c.txt && git add c.txt && git commit -q -m sneaky");
      return n === 1 ? (writeResult(cwd, { stepId: stepIdOf(input), status: "done", summary: "s" }), { ok: true }) : good()(n, input, cwd);
    });
    const r = await run(b, { only: "S01" });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "c.txt"))).toBe(false);
    expect(sh(dir, "git log --format=%s")).not.toContain("sneaky");
  });

  test("SIGINT: exit 130, tree left as is", async () => {
    const ac = new AbortController();
    const b = new FakeBackend(async (_n, _i, cwd) => {
      writeFileSync(join(cwd, "wip.txt"), "x");
      ac.abort();
      return { ok: false, error: "aborted" };
    });
    const r = await run(b, {}, ac.signal);
    expect(r.code).toBe(130);
    expect(existsSync(join(dir, "wip.txt"))).toBe(true);
    expect(plan()).toContain("[ ] S01");
    expect(r.text).toContain("autopilot run");
  });

  test("dirty tree: exit 4, backend never called", async () => {
    writeFileSync(join(dir, "stray.txt"), "x");
    const b = new FakeBackend(good());
    const r = await run(b);
    expect(r.code).toBe(4);
    expect(b.calls).toHaveLength(0);
  });

  test("--allow-dirty never rolls back user changes", async () => {
    writeFileSync(join(dir, "mine.txt"), "precious");
    const b = new FakeBackend(() => ({ ok: true }));
    const r = await run(b, { allowDirty: true, retries: 1 });
    expect(r.code).toBe(1);
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("precious");
  });

  test("dry-run prints step and prompt and changes nothing", async () => {
    const b = new FakeBackend(good());
    const before = sh(dir, "git rev-parse HEAD");
    const r = await run(b, { dryRun: true, verify: "bun test" });
    expect(r.code).toBe(0);
    expect(r.text).toContain("Use the autopilot-step skill.");
    expect(r.text).toContain("S01");
    expect(b.calls).toHaveLength(0);
    expect(sh(dir, "git rev-parse HEAD")).toBe(before);
    expect(existsSync(join(dir, ".autopilot"))).toBe(false);
  });

  test("invalid plan and unknown --only exit 2", async () => {
    writeFileSync(join(dir, "PLAN.md"), "- [ ] S01: a\n- [ ] S01: b\n");
    expect((await run(new FakeBackend(good()))).code).toBe(2);
    writeFileSync(join(dir, "PLAN.md"), PLAN3);
    expect((await run(new FakeBackend(good()), { only: "S99" })).code).toBe(2);
  });

  test("per-step Verify: overrides the global command", async () => {
    writeFileSync(join(dir, "PLAN.md"), "- [ ] S01: a\n  - Verify: true\n");
    sh(dir, "git commit -qam plan");
    const r = await run(new FakeBackend(good()), { verify: "false", retries: 0 });
    expect(r.code).toBe(0);
  });

  test("verify command is allowed for the agent, git commit is denied", async () => {
    const b = new FakeBackend(good());
    await run(b, { only: "S01", verify: "npm test" });
    expect(b.calls[0]!.allowedTools).toContain("Bash(npm test:*)");
    expect(b.calls[0]!.allowedTools).toContain("Skill");
    expect(b.calls[0]!.disallowedTools).toContain("Bash(git commit:*)");
  });
});

describe("init and status", () => {
  test("init scaffolds files, skips existing ones, and is idempotent", () => {
    const d = mkdtempSync(join(tmpdir(), "autopilot-init-"));
    try {
      writeFileSync(join(d, "PLAN.md"), "mine");
      const lines: string[] = [];
      runInit(d, (l) => lines.push(l));
      expect(readFileSync(join(d, "PLAN.md"), "utf8")).toBe("mine");
      expect(lines.join("\n")).toContain("skipped  PLAN.md");
      expect(existsSync(join(d, ".claude/skills/autopilot-step/SKILL.md"))).toBe(true);
      expect(existsSync(join(d, ".autopilot.json"))).toBe(true);
      expect(readFileSync(join(d, ".gitignore"), "utf8")).toContain(".autopilot/");
      runInit(d, () => {});
      expect(readFileSync(join(d, ".gitignore"), "utf8").match(/\.autopilot\//g)).toHaveLength(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("status lists steps and the next one", () => {
    const lines: string[] = [];
    expect(runStatus(dir, "PLAN.md", (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("[ ] S01: one");
    expect(lines.join("\n")).toContain("Next: S01 one");
  });
});
