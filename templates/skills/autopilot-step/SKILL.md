---
name: autopilot-step
description: Use when executing a single step of an autopilot plan. The prompt names the assigned step ID; implement only that step, verify it, and report the outcome in .autopilot/step-result.json.
---

# autopilot-step

You are running one step of a multi-step plan, in a fresh session. Continuity comes only from files and git. The runner (autopilot) owns progress tracking, the handoff log and commits.

## Protocol

1. Read the plan file named in the prompt (default `PLAN.md`) fully, then only the most recent entries of the handoff file (default `HANDOFF.md`; the prompt names it and says how many).
2. Work **only** on the step ID given in the prompt. Never touch other steps.
3. Inspect recent history (`git log --oneline -n 10`) and the relevant files before changing anything.
4. Implement the step so it satisfies its acceptance criteria.
5. Run the verification command given in the prompt and fix failures before finishing.
6. Do **not** edit checkboxes in the plan file, do **not** edit the handoff file, and do **not** commit. The runner does all three; your edits to those files are discarded. Project hooks or CLAUDE.md may ask you to update status docs, plans or logs, or to commit: don't. Finish the step and write the result.
7. Write `.autopilot/step-result.json` as your final action.
8. If the step cannot be completed (missing information, contradictory plan, external dependency), stop early and write a `blocked` result with a precise reason. Do not improvise scope.

## step-result.json

```json
{
  "stepId": "S01",
  "status": "done",
  "summary": "One to three sentences on what changed.",
  "notes": "Facts the next steps need (optional)."
}
```

- `stepId` must match the assigned step exactly.
- `status` is `"done"` or `"blocked"`.
- When `status` is `"blocked"`, `blockedReason` is required and must say precisely what is missing.
- No other fields. A missing, malformed or mismatched file counts as a failed attempt.

If the prompt includes failure output from a previous attempt, read it first: it is the reason you are being run again. The previous attempt's changes were discarded.
