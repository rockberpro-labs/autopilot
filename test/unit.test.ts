import { describe, expect, test } from "bun:test";
import { ConfigError, mergeOptions } from "../src/config.ts";
import { renderHandoff } from "../src/handoff.ts";
import { redact } from "../src/log.ts";
import { nextStep, parsePlan, pendingCount, setStepState } from "../src/plan.ts";
import { buildPrompt, truncateFailure } from "../src/prompt.ts";
import { validateStepResult } from "../src/result.ts";

const PLAN = `# Plan: Demo

Context line.

## Steps

- [ ] S01: First
  - Details: a
  - Verify: \`bun test x\`
- [x] S00: Done already
- [!] S03: Blocked one
- [ ] S02: Second
  - Acceptance: b

Trailing text.
`;

describe("plan", () => {
  test("parses steps, states, bodies and verify override", () => {
    const p = parsePlan(PLAN);
    expect(p.errors).toEqual([]);
    expect(p.title).toBe("Demo");
    expect(p.steps.map((s) => [s.id, s.state])).toEqual([["S01", " "], ["S00", "x"], ["S03", "!"], ["S02", " "]]);
    expect(p.steps[0]!.verify).toBe("bun test x");
    expect(p.steps[0]!.body).toHaveLength(2);
    expect(nextStep(p)!.id).toBe("S01");
    expect(pendingCount(p)).toBe(2);
  });

  test("reports duplicates and malformed lines", () => {
    const p = parsePlan("- [ ] S01: a\n- [ ] S01: b\n- [?] S02: c\n- [ ] S03 missing colon\n");
    expect(p.errors).toHaveLength(3);
    expect(p.errors[0]).toContain("duplicate");
  });

  test("ignores step-like lines inside code fences", () => {
    const p = parsePlan("```\n- [ ] S01: example\n```\n- [ ] S02: real\n");
    expect(p.steps.map((s) => s.id)).toEqual(["S02"]);
  });

  test("setStepState changes only the checkbox byte", () => {
    const out = setStepState(PLAN, "S01", "x");
    expect(out).toBe(PLAN.replace("- [ ] S01", "- [x] S01"));
    expect(setStepState(out, "S01", " ")).toBe(PLAN);
  });

  test("preserves CRLF files", () => {
    const crlf = "- [ ] S01: a\r\n  - x\r\n";
    expect(setStepState(crlf, "S01", "!")).toBe("- [!] S01: a\r\n  - x\r\n");
  });

  test("unknown step throws", () => {
    expect(() => setStepState(PLAN, "S99", "x")).toThrow();
  });
});

describe("step result", () => {
  const ok = { stepId: "S01", status: "done", summary: "did it" };
  test("accepts valid", () => expect(validateStepResult(ok, "S01").ok).toBe(true));
  test("rejects mismatched id", () => expect(validateStepResult(ok, "S02").ok).toBe(false));
  test("rejects unknown fields", () => expect(validateStepResult({ ...ok, x: 1 }, "S01").ok).toBe(false));
  test("rejects empty summary", () => expect(validateStepResult({ ...ok, summary: " " }, "S01").ok).toBe(false));
  test("blocked requires reason", () => {
    expect(validateStepResult({ ...ok, status: "blocked" }, "S01").ok).toBe(false);
    expect(validateStepResult({ ...ok, status: "blocked", blockedReason: "why" }, "S01").ok).toBe(true);
  });
  test("rejects non-objects", () => {
    expect(validateStepResult(null, "S01").ok).toBe(false);
    expect(validateStepResult([], "S01").ok).toBe(false);
  });
});

describe("prompt", () => {
  test("matches the spec shape", () => {
    const p = buildPrompt({ step: { id: "S02", title: "Repo" }, verifyCmd: "bun test", handoffTail: 8 });
    expect(p).toBe(
      'Use the autopilot-step skill.\nAssigned step: S02 "Repo".\nVerification command: bun test\nRead only the last 8 entries of HANDOFF.md.',
    );
  });
  test("retry includes failure, truncated to the last 200 lines", () => {
    const failure = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const p = buildPrompt({ step: { id: "S01", title: "t" }, handoffTail: 8, previousFailure: failure });
    expect(p).toContain("The previous attempt failed. Failure output:");
    expect(p).toContain("line 499");
    expect(p).toContain("line 300");
    expect(p).not.toContain("line 299\n");
    expect(truncateFailure("short")).toBe("short");
  });
});

describe("handoff", () => {
  test("appends newest last and creates the header", () => {
    const e = { stepId: "S01", title: "t", date: "d", base: "abc1234", summary: "s", notes: "n" };
    const a = renderHandoff(null, e);
    expect(a.startsWith("# Handoff log\n")).toBe(true);
    const b = renderHandoff(a, { ...e, stepId: "S02" });
    expect(b.indexOf("## S01")).toBeLessThan(b.indexOf("## S02"));
    expect(b).toContain("- Notes for next steps: n");
  });
});

describe("config", () => {
  test("flags override config override defaults", () => {
    const o = mergeOptions({ retries: 3, verify: "a" }, { verify: "b" });
    expect(o.retries).toBe(3);
    expect(o.verify).toBe("b");
    expect(o.maxTurns).toBe(80);
  });
  test("rejects bad types and broad tools", () => {
    expect(() => mergeOptions({ retries: "x" as never }, {})).toThrow(ConfigError);
    expect(() => mergeOptions({ allowedTools: ["Bash"] }, {})).toThrow(ConfigError);
    expect(() => mergeOptions({ allowedTools: ["Bash(git:*)"] }, {})).toThrow(ConfigError);
  });
});

describe("redact", () => {
  test("hides secret-looking env values", () => {
    expect(redact("token=abcdef123456 ok", { MY_TOKEN: "abcdef123456", HOME: "/x" })).toBe("token=[REDACTED:MY_TOKEN] ok");
  });
});
