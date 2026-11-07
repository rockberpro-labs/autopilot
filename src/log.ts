import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAME_RE = /(_KEY|_TOKEN|_SECRET)$/i;

/** Replaces values of env vars that look like secrets. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 6 && SECRET_NAME_RE.test(name)) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}

export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export class RunLog {
  readonly dir: string;
  constructor(autopilotDir: string, runId: string) {
    this.dir = join(autopilotDir, "runs", runId);
  }

  /** Appends one JSONL line to <stepId>-<attempt>.jsonl */
  write(stepId: string, attempt: number, event: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const line = redact(JSON.stringify(event)) + "\n";
    appendFileSync(join(this.dir, `${stepId}-${attempt}.jsonl`), line);
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function formatCost(usd: number | undefined): string {
  return usd === undefined ? "n/a" : `$${usd.toFixed(4)}`;
}
