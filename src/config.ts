import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type RunOptions = {
  plan: string;
  handoff: string;
  backend: "sdk" | "cli";
  verify?: string;
  maxSteps?: number;
  only?: string;
  maxTurns: number;
  retries: number;
  budget?: number;
  model?: string;
  permissionMode: string;
  allowDirty: boolean;
  branch?: string;
  dryRun: boolean;
  verbose: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  handoffTail: number;
  handoffMaxBytes: number;
  keepLogs: boolean;
};

export const DEFAULT_ALLOWED_TOOLS = [
  "Skill",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
];

export const DEFAULT_DISALLOWED_TOOLS = ["Bash(git commit:*)", "Bash(git push:*)"];

export const DEFAULTS: RunOptions = {
  plan: "PLAN.md",
  handoff: "HANDOFF.md",
  backend: "sdk",
  maxTurns: 80,
  retries: 1,
  permissionMode: "acceptEdits",
  allowDirty: false,
  dryRun: false,
  verbose: false,
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  disallowedTools: DEFAULT_DISALLOWED_TOOLS,
  handoffTail: 8,
  handoffMaxBytes: 12 * 1024,
  keepLogs: false,
};

export class ConfigError extends Error {}

export async function loadConfigFile(cwd: string): Promise<Partial<RunOptions>> {
  const path = join(cwd, ".autopilot.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("must be an object");
    return parsed;
  } catch (e) {
    throw new ConfigError(`.autopilot.json: ${(e as Error).message}`);
  }
}

const TYPES: Record<keyof RunOptions, "string" | "number" | "boolean" | "string[]"> = {
  plan: "string",
  handoff: "string",
  backend: "string",
  verify: "string",
  maxSteps: "number",
  only: "string",
  maxTurns: "number",
  retries: "number",
  budget: "number",
  model: "string",
  permissionMode: "string",
  allowDirty: "boolean",
  branch: "string",
  dryRun: "boolean",
  verbose: "boolean",
  allowedTools: "string[]",
  disallowedTools: "string[]",
  handoffTail: "number",
  handoffMaxBytes: "number",
  keepLogs: "boolean",
};

function checkType(key: string, value: unknown, type: string): void {
  const ok =
    type === "string[]"
      ? Array.isArray(value) && value.every((v) => typeof v === "string")
      : typeof value === type && !(type === "number" && !Number.isFinite(value));
  if (!ok) throw new ConfigError(`option "${key}" must be of type ${type}`);
}

/** Precedence: defaults < config file < flags. Undefined values never override. */
export function mergeOptions(config: Partial<RunOptions>, flags: Partial<RunOptions>): RunOptions {
  const merged: Record<string, unknown> = { ...DEFAULTS };
  for (const source of [config, flags]) {
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) continue;
      if (k === "plan" || k === "handoff" || k in TYPES) {
        checkType(k, v, TYPES[k as keyof RunOptions]);
        merged[k] = v;
      }
    }
  }
  const o = merged as RunOptions;
  if (o.backend !== "sdk" && o.backend !== "cli") throw new ConfigError('backend must be "sdk" or "cli"');
  for (const [k, min] of [["maxTurns", 1], ["retries", 0], ["handoffTail", 1], ["maxSteps", 1]] as const) {
    const v = o[k];
    if (v !== undefined && (!Number.isInteger(v) || v < min)) throw new ConfigError(`${k} must be an integer >= ${min}`);
  }
  if (o.budget !== undefined && o.budget <= 0) throw new ConfigError("budget must be > 0");
  for (const t of o.allowedTools) {
    if (t === "Bash" || /^Bash\(\s*(\*|git:?\s*\*?|git\s+\*|git:\*)\s*\)$/.test(t)) {
      throw new ConfigError(`allowedTools entry "${t}" is too broad (it would permit git commit/push); list specific commands`);
    }
  }
  return o;
}

/** Tools the agent may use, including the verification commands it must run. */
export function effectiveAllowedTools(opts: RunOptions, stepVerify?: string): string[] {
  const tools = new Set(opts.allowedTools);
  tools.add("Skill");
  for (const cmd of [opts.verify, stepVerify]) {
    if (cmd) tools.add(`Bash(${cmd}:*)`);
  }
  return [...tools];
}
