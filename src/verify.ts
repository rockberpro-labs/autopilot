import { redact } from "./log.ts";
import { run } from "./proc.ts";

export type VerifyOutcome = { ok: boolean; code: number; output: string };

export async function runVerify(cmd: string, cwd: string): Promise<VerifyOutcome> {
  const { stdout, stderr, code } = await run("sh", ["-c", cmd], { cwd });
  return { ok: code === 0, code, output: redact(stdout + stderr) };
}
