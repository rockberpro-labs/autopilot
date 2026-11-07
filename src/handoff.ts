export const HANDOFF_HEADER = "# Handoff log\n";
export const DEFAULT_HANDOFF_MAX_BYTES = 12 * 1024;

export type HandoffEntry = {
  stepId: string;
  title: string;
  date: string;
  /** commit the step started from; the step's own commit cannot contain its hash */
  base: string;
  summary: string;
  notes?: string;
  blockedReason?: string;
};

export function formatEntry(e: HandoffEntry): string {
  const lines = [`## ${e.stepId}: ${e.title}`, `- Date: ${e.date}`, `- Base: ${e.base}`];
  if (e.blockedReason) lines.push(`- Blocked: ${e.blockedReason}`);
  lines.push(`- Summary: ${e.summary}`);
  if (e.notes) lines.push(`- Notes for next steps: ${e.notes}`);
  return lines.join("\n") + "\n";
}

/** Pure: returns the handoff text with the entry appended (newest last). */
export function renderHandoff(existing: string | null, entry: HandoffEntry): string {
  let base = existing && existing.trim() !== "" ? existing : HANDOFF_HEADER;
  if (!base.endsWith("\n")) base += "\n";
  return base + "\n" + formatEntry(entry);
}

export function isOversized(text: string, maxBytes = DEFAULT_HANDOFF_MAX_BYTES): boolean {
  return Buffer.byteLength(text) > maxBytes;
}
