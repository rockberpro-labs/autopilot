import type { Step } from "./plan.ts";

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
  previousFailure?: string;
}): string {
  const out = [
    "Use the autopilot-step skill.",
    `Assigned step: ${input.step.id} "${input.step.title}".`,
    `Verification command: ${input.verifyCmd ?? "none configured"}`,
    `Read only the last ${input.handoffTail} entries of HANDOFF.md.`,
  ];
  if (input.previousFailure !== undefined) {
    out.push("The previous attempt failed. Failure output:", truncateFailure(input.previousFailure));
  }
  return out.join("\n");
}
