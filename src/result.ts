import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type StepResult = {
  stepId: string;
  status: "done" | "blocked";
  summary: string;
  notes?: string;
  blockedReason?: string;
};

export type ValidationOutcome = { ok: true; result: StepResult } | { ok: false; error: string };

const KNOWN_KEYS = new Set(["stepId", "status", "summary", "notes", "blockedReason"]);

export function validateStepResult(raw: unknown, expectedId: string): ValidationOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "step-result.json must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!KNOWN_KEYS.has(k)) return { ok: false, error: `step-result.json: unknown field "${k}"` };
  }
  if (typeof o.stepId !== "string") return { ok: false, error: "step-result.json: stepId must be a string" };
  if (o.stepId !== expectedId) {
    return { ok: false, error: `step-result.json: stepId "${o.stepId}" does not match assigned step ${expectedId}` };
  }
  if (o.status !== "done" && o.status !== "blocked") {
    return { ok: false, error: 'step-result.json: status must be "done" or "blocked"' };
  }
  if (typeof o.summary !== "string" || o.summary.trim() === "") {
    return { ok: false, error: "step-result.json: summary must be a non-empty string" };
  }
  if (o.notes !== undefined && typeof o.notes !== "string") {
    return { ok: false, error: "step-result.json: notes must be a string" };
  }
  if (o.blockedReason !== undefined && typeof o.blockedReason !== "string") {
    return { ok: false, error: "step-result.json: blockedReason must be a string" };
  }
  if (o.status === "blocked" && (typeof o.blockedReason !== "string" || o.blockedReason.trim() === "")) {
    return { ok: false, error: 'step-result.json: blockedReason is required when status is "blocked"' };
  }
  return {
    ok: true,
    result: {
      stepId: o.stepId,
      status: o.status,
      summary: o.summary.trim(),
      notes: o.notes?.trim() || undefined,
      blockedReason: (o.blockedReason as string | undefined)?.trim() || undefined,
    },
  };
}

export async function readStepResult(path: string, expectedId: string): Promise<ValidationOutcome> {
  if (!existsSync(path)) return { ok: false, error: "step-result.json was not written" };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    return { ok: false, error: `step-result.json is not valid JSON: ${(e as Error).message}` };
  }
  return validateStepResult(raw, expectedId);
}
