import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Backend, StepRunInput, StepRunOutput } from "./types.ts";

/**
 * Spawns `claude -p` in stream-json mode. The prompt goes through stdin because
 * --allowedTools is variadic and would swallow a positional prompt. The CLI has no
 * turn-cap flag, so the cap is enforced here by counting assistant messages.
 */
export class CliBackend implements Backend {
  async runStep(input: StepRunInput): Promise<StepRunOutput> {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", input.permissionMode,
      "--setting-sources", "project",
      "--allowedTools", input.allowedTools.join(","),
    ];
    if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
    if (input.model) args.push("--model", input.model);

    const proc = spawn("claude", args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });

    let spawnError: Error | undefined;
    proc.on("error", (e) => (spawnError = e));
    proc.stdin.on("error", () => {}); // EPIPE when the process dies early
    proc.stdin.end(input.prompt);

    let stderr = "";
    proc.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));

    let turnLimitHit = false;
    const kill = () => proc.kill();
    if (input.signal.aborted) kill();
    else input.signal.addEventListener("abort", kill, { once: true });

    let outcome: StepRunOutput | undefined;
    let assistantTurns = 0;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        input.onEvent({ type: "raw", data: line });
        return;
      }
      input.onEvent({ type: "raw", data: m });
      if (m.type === "assistant") {
        assistantTurns++;
        for (const block of m.message?.content ?? []) {
          if (block.type === "tool_use") input.onEvent({ type: "tool", name: block.name, input: block.input });
          else if (block.type === "text" && block.text) input.onEvent({ type: "text", text: block.text });
        }
        if (assistantTurns > input.maxTurns) {
          turnLimitHit = true;
          kill();
        }
      } else if (m.type === "result") {
        const ok = m.subtype === "success" && !m.is_error;
        outcome = {
          ok,
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
          turns: typeof m.num_turns === "number" ? m.num_turns : undefined,
          error: ok ? undefined : String(m.result ?? m.subtype),
        };
      }
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", handleLine);

    // 'close' fires after the process exited and stdio is drained; 'error' (ENOENT) may fire without it
    const code = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    });
    input.signal.removeEventListener("abort", kill);

    if (spawnError && (spawnError as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "the `claude` CLI was not found on PATH; install Claude Code or use --backend sdk" };
    }
    if (spawnError) return { ok: false, error: `could not start claude: ${spawnError.message}` };
    if (input.signal.aborted) return { ok: false, error: "aborted", ...outcome };
    if (turnLimitHit) return { ok: false, error: `exceeded max turns (${input.maxTurns})`, turns: assistantTurns, ...outcome };
    if (outcome) return outcome;
    const tail = stderr.trim();
    return { ok: false, error: `claude exited with code ${code} without a result${tail ? `: ${tail}` : ""}` };
  }
}
