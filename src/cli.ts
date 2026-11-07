#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CliBackend } from "./backends/cli.ts";
import { runInit } from "./commands/init.ts";
import { EXIT, runPlan } from "./commands/run.ts";
import { runStatus } from "./commands/status.ts";
import { ConfigError, loadConfigFile, mergeOptions, type RunOptions } from "./config.ts";

const HELP = `autopilot: run a multi-step plan with Claude Code, one fresh session per step

Usage:
  autopilot init                 scaffold PLAN.md, HANDOFF.md, skill, config, .gitignore entry
  autopilot status [--plan P]    show steps, states and the next step
  autopilot run [options]        execute pending steps

run options:
  --plan <path>  --handoff <path>  --backend <sdk|cli>  --verify <cmd>
  --max-steps <n>  --only <id>  --max-turns <n>  --retries <n>  --budget <usd>
  --model <name>  --permission-mode <mode>  --allow-dirty  --branch <name>
  --dry-run  --verbose

Exit codes: 0 ok, 1 step failed/blocked, 2 invalid plan or config, 3 budget exceeded,
            4 dirty working tree, 130 interrupted`;

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`--${name} must be a number`);
  return n;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const out = (l: string) => console.log(l);
  const cwd = process.cwd();

  if (!command || command === "--help" || command === "-h" || command === "help") {
    out(HELP);
    return command ? 0 : 2;
  }

  try {
    if (command === "init") return runInit(cwd, out);

    const { values } = parseArgs({
      args: rest,
      options: {
        plan: { type: "string" },
        handoff: { type: "string" },
        backend: { type: "string" },
        verify: { type: "string" },
        "max-steps": { type: "string" },
        only: { type: "string" },
        "max-turns": { type: "string" },
        retries: { type: "string" },
        budget: { type: "string" },
        model: { type: "string" },
        "permission-mode": { type: "string" },
        "allow-dirty": { type: "boolean" },
        branch: { type: "string" },
        "dry-run": { type: "boolean" },
        verbose: { type: "boolean" },
      },
      strict: true,
    });

    const flags: Partial<RunOptions> = {
      plan: values.plan,
      handoff: values.handoff,
      backend: values.backend as RunOptions["backend"] | undefined,
      verify: values.verify,
      maxSteps: num(values["max-steps"], "max-steps"),
      only: values.only,
      maxTurns: num(values["max-turns"], "max-turns"),
      retries: num(values.retries, "retries"),
      budget: num(values.budget, "budget"),
      model: values.model,
      permissionMode: values["permission-mode"],
      allowDirty: values["allow-dirty"],
      branch: values.branch,
      dryRun: values["dry-run"],
      verbose: values.verbose,
    };
    const opts = mergeOptions(await loadConfigFile(cwd), flags);

    if (command === "status") return runStatus(cwd, opts.plan, out);
    if (command !== "run") {
      out(`unknown command: ${command}\n\n${HELP}`);
      return 2;
    }

    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    process.on("SIGTERM", () => ac.abort());
    const backend = opts.backend === "cli" ? new CliBackend() : new (await import("./backends/sdk.ts")).SdkBackend();
    return await runPlan(opts, { backend, signal: ac.signal, cwd, out });
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return e instanceof ConfigError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? EXIT.INVALID : EXIT.FAILED;
  }
}

process.exit(await main());
