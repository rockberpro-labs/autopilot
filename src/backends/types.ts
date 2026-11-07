export type BackendEvent =
  | { type: "tool"; name: string; input?: unknown }
  | { type: "text"; text: string }
  | { type: "raw"; data: unknown };

export type StepRunInput = {
  prompt: string;
  cwd: string;
  allowedTools: string[];
  disallowedTools?: string[];
  permissionMode: string;
  maxTurns: number;
  model?: string;
  signal: AbortSignal;
  onEvent: (e: BackendEvent) => void;
};

export type StepRunOutput = { ok: boolean; costUsd?: number; turns?: number; error?: string };

export interface Backend {
  runStep(input: StepRunInput): Promise<StepRunOutput>;
}
