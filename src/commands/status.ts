import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextStep, parsePlan } from "../plan.ts";

const GLYPH = { " ": "[ ]", x: "[x]", "!": "[!]" } as const;

export function runStatus(cwd: string, planFile: string, out: (line: string) => void): number {
  const path = resolve(cwd, planFile);
  if (!existsSync(path)) {
    out(`error: plan file not found: ${planFile}`);
    return 2;
  }
  const plan = parsePlan(readFileSync(path, "utf8"));
  if (plan.errors.length) {
    for (const e of plan.errors) out(`error: ${planFile}: ${e}`);
    return 2;
  }
  out(`Plan: ${plan.title || "(untitled)"}`);
  for (const s of plan.steps) out(`  ${GLYPH[s.state]} ${s.id}: ${s.title}`);
  const count = (st: string) => plan.steps.filter((s) => s.state === st).length;
  out(`\n${count("x")} done, ${count(" ")} pending, ${count("!")} blocked`);
  const next = nextStep(plan);
  out(next ? `Next: ${next.id} ${next.title}` : "Next: none");
  return 0;
}
