export type StepState = " " | "x" | "!";

export type Step = {
  id: string;
  title: string;
  state: StepState;
  /** zero-based index of the step line in the file */
  line: number;
  /** indented lines under the step, verbatim */
  body: string[];
  /** per-step verification override (`- Verify: <cmd>` in the body) */
  verify?: string;
};

export type ParsedPlan = {
  title: string;
  steps: Step[];
  errors: string[];
};

const STEP_RE = /^- \[( |x|!)\] (S\d+): (.+)$/;
const STEP_LIKE_RE = /^- \[[^\]]*\]/;
const VERIFY_RE = /^\s*-\s*Verify:\s*(.+?)\s*$/i;

function splitLines(text: string): string[] {
  return text.split("\n");
}

export function parsePlan(text: string): ParsedPlan {
  const lines = splitLines(text);
  const steps: Step[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  let title = "";
  let inFence = false;
  let current: Step | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current = null;
      continue;
    }
    if (inFence) continue;

    if (!title) {
      const m = /^#\s+(?:Plan:\s*)?(.+)$/.exec(line);
      if (m) title = m[1]!.trim();
    }

    const m = STEP_RE.exec(line);
    if (m) {
      const id = m[2]!;
      if (seen.has(id)) {
        errors.push(`line ${i + 1}: duplicate step id ${id} (first at line ${seen.get(id)! + 1})`);
      }
      seen.set(id, i);
      current = { id, title: m[3]!.trim(), state: m[1] as StepState, line: i, body: [] };
      steps.push(current);
      continue;
    }

    if (STEP_LIKE_RE.test(line)) {
      errors.push(`line ${i + 1}: malformed step line: ${line}`);
      current = null;
      continue;
    }

    if (current && (line.trim() === "" || /^\s+\S/.test(line))) {
      current.body.push(line);
      const v = VERIFY_RE.exec(line);
      if (v) current.verify = v[1]!.replace(/^`(.*)`$/, "$1");
    } else {
      current = null;
    }
  }

  for (const s of steps) {
    while (s.body.length && s.body[s.body.length - 1]!.trim() === "") s.body.pop();
  }

  return { title, steps, errors };
}

export function nextStep(plan: ParsedPlan): Step | undefined {
  return plan.steps.find((s) => s.state === " ");
}

export function pendingCount(plan: ParsedPlan): number {
  return plan.steps.filter((s) => s.state === " ").length;
}

/** Changes only the checkbox character of the given step; every other byte is preserved. */
export function setStepState(text: string, id: string, state: StepState): string {
  const plan = parsePlan(text);
  const step = plan.steps.find((s) => s.id === id);
  if (!step) throw new Error(`step ${id} not found in plan`);
  const lines = splitLines(text);
  const line = lines[step.line]!;
  // "- [" is 3 chars, the state char is at index 3
  lines[step.line] = line.slice(0, 3) + state + line.slice(4);
  return lines.join("\n");
}
