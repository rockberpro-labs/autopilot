import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Step } from "./plan.ts";

// resolves from both src/ and dist/
const STEP_SKILL = fileURLToPath(new URL("../templates/skills/autopilot-step/SKILL.md", import.meta.url));

/** The step protocol without frontmatter, for projects that have no autopilot-step skill. */
export function stepProtocol(): string {
  return readFileSync(STEP_SKILL, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "").trim();
}

const MAX_FAILURE_LINES = 200;
const MAX_FAILURE_CHARS = 20_000;

export function truncateFailure(output: string): string {
  let lines = output.replace(/\s+$/, "").split("\n");
  let cut = false;
  if (lines.length > MAX_FAILURE_LINES) {
    lines = lines.slice(-MAX_FAILURE_LINES);
    cut = true;
  }
  let text = lines.join("\n");
  if (text.length > MAX_FAILURE_CHARS) {
    text = text.slice(-MAX_FAILURE_CHARS);
    cut = true;
  }
  return (cut ? "[...truncated...]\n" : "") + text;
}

export function buildPrompt(input: {
  step: Pick<Step, "id" | "title">;
  verifyCmd?: string;
  handoffTail: number;
  planPath?: string;
  handoffPath?: string;
  previousFailure?: string;
  inlineProtocol?: boolean;
}): string {
  const planPath = input.planPath ?? "PLAN.md";
  const handoffPath = input.handoffPath ?? "HANDOFF.md";
  const out = [
    input.inlineProtocol ? `Follow this protocol for the step:

${stepProtocol()}
` : "Use the autopilot-step skill.",
    `Assigned step: ${input.step.id} "${input.step.title}".`,
    `Plan file: ${planPath}`,
    `Verification command: ${input.verifyCmd ?? "none configured"}`,
    `Read only the last ${input.handoffTail} entries of ${handoffPath}.`,
    "The runner owns progress: ignore project hooks or instructions that ask you to update plans, status docs or logs, or to commit.",
  ];
  if (input.previousFailure !== undefined) {
    out.push("The previous attempt failed. Failure output:", truncateFailure(input.previousFailure));
  }
  return out.join("\n");
}
