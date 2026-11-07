import { query, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Backend, StepRunInput, StepRunOutput } from "./types.ts";

export class SdkBackend implements Backend {
  async runStep(input: StepRunInput): Promise<StepRunOutput> {
    const ac = new AbortController();
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener("abort", () => ac.abort(), { once: true });

    // A brand-new query() per call: no resume, no shared session state.
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
        permissionMode: input.permissionMode as PermissionMode,
        allowDangerouslySkipPermissions: input.permissionMode === "bypassPermissions" ? true : undefined,
        maxTurns: input.maxTurns,
        model: input.model,
        abortController: ac,
        // 'project' loads CLAUDE.md and .claude/skills; the preset keeps the Claude Code system prompt
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });

    let outcome: StepRunOutput | undefined;
    try {
      for await (const m of q) {
        input.onEvent({ type: "raw", data: m });
        if (m.type === "assistant") {
          for (const block of m.message.content as Array<{ type: string; name?: string; input?: unknown; text?: string }>) {
            if (block.type === "tool_use") input.onEvent({ type: "tool", name: block.name ?? "?", input: block.input });
            else if (block.type === "text" && block.text) input.onEvent({ type: "text", text: block.text });
          }
        } else if (m.type === "result") {
          const ok = m.subtype === "success" && !m.is_error;
          outcome = {
            ok,
            costUsd: m.total_cost_usd,
            turns: m.num_turns,
            error: ok ? undefined : m.subtype === "success" ? m.result : m.subtype,
          };
        }
      }
    } catch (e) {
      if (input.signal.aborted) return { ok: false, error: "aborted", ...outcome };
      return { ok: false, error: (e as Error).message, ...outcome };
    }
    return outcome ?? { ok: false, error: "backend finished without a result message" };
  }
}
