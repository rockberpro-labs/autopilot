import { spawn } from "node:child_process";

export type ProcResult = { stdout: string; stderr: string; code: number };

/** Runs a command to completion. A spawn failure (e.g. ENOENT) resolves with code -1 and the error in stderr. */
export function run(cmd: string, args: string[], opts: { cwd: string }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    p.on("error", (e) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
