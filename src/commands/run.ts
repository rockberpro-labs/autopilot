import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Backend } from "../backends/types.ts";
import { effectiveAllowedTools, type RunOptions } from "../config.ts";
import * as git from "../git.ts";
import { renderHandoff, isOversized } from "../handoff.ts";
import { formatCost, formatDuration, newRunId, RunLog } from "../log.ts";
import { nextStep, parsePlan, pendingCount, setStepState, type Step } from "../plan.ts";
import { buildPrompt } from "../prompt.ts";
import { readStepResult, type StepResult } from "../result.ts";
import { runVerify } from "../verify.ts";

export const EXIT = { OK: 0, FAILED: 1, INVALID: 2, BUDGET: 3, DIRTY: 4, INTERRUPTED: 130 } as const;

export type RunDeps = {
  backend: Backend;
  signal: AbortSignal;
  cwd: string;
  out: (line: string) => void;
};

type AttemptFailure = { kind: "verify" | "other"; text: string };

export async function runPlan(opts: RunOptions, deps: RunDeps): Promise<number> {
  const { cwd, out, signal } = deps;
  const planPath = resolve(cwd, opts.plan);
  const handoffPath = resolve(cwd, opts.handoff);
  const stateDir = join(cwd, ".autopilot");
  const resultPath = join(stateDir, "step-result.json");
  const planRel = relative(cwd, planPath);
  const handoffRel = relative(cwd, handoffPath);

  const readPlan = (): string | null => (existsSync(planPath) ? readFileSync(planPath, "utf8") : null);

  // ---- validate ----
  const initialText = readPlan();
  if (initialText === null) {
    out(`error: plan file not found: ${opts.plan}`);
    return EXIT.INVALID;
  }
  const initial = parsePlan(initialText);
  if (initial.errors.length) {
    for (const e of initial.errors) out(`error: ${opts.plan}: ${e}`);
    return EXIT.INVALID;
  }
  if (opts.only && !initial.steps.some((s) => s.id === opts.only)) {
    out(`error: --only ${opts.only}: no such step`);
    return EXIT.INVALID;
  }
  if (!(await git.isGitRepo(cwd))) {
    out("error: not inside a git repository");
    return EXIT.INVALID;
  }
  if (!(await git.headSha(cwd))) {
    out("error: the repository has no commits yet; commit the scaffolded files first");
    return EXIT.INVALID;
  }

  const pick = (plan = initial): Step | undefined =>
    opts.only ? plan.steps.find((s) => s.id === opts.only && s.state === " ") : nextStep(plan);

  // ---- dry run: print and stop, touching nothing ----
  if (opts.dryRun) {
    const step = pick();
    if (!step) {
      out("nothing to do: no pending step");
      return EXIT.OK;
    }
    const verifyCmd = step.verify ?? opts.verify;
    out(`Next step: ${step.id} ${step.title}`);
    out("--- prompt ---");
    out(buildPrompt({ step, verifyCmd, handoffTail: opts.handoffTail }));
    return EXIT.OK;
  }

  // ---- clean tree, branch ----
  const dirty = !(await git.isClean(cwd));
  if (dirty && !opts.allowDirty) {
    out("error: working tree is not clean (commit or stash first, or pass --allow-dirty)");
    return EXIT.DIRTY;
  }
  if (dirty) {
    out("warning: --allow-dirty: existing changes will be included in step commits, and failed attempts are NOT rolled back");
  }
  if (opts.branch) await git.checkoutBranch(cwd, opts.branch);

  const runId = newRunId();
  const log = new RunLog(stateDir, runId);
  const summary = { done: 0, blocked: 0, cost: 0, costKnown: false };
  const t0 = Date.now();
  let warnedNoCost = false;

  const finish = (code: number): number => {
    out(
      `\nSummary: ${summary.done} done, ${summary.blocked} blocked, cost ${formatCost(summary.costKnown ? summary.cost : undefined)}, time ${formatDuration(Date.now() - t0)}`,
    );
    return code;
  };
  const interrupted = (): number => {
    out("\nInterrupted. The working tree was left as is. Inspect or reset it (git status / git reset --hard), then run `autopilot run` again to resume.");
    return EXIT.INTERRUPTED;
  };
  const discard = async (sha: string) => {
    if (!dirty) await git.resetHard(cwd, sha);
  };

  let ran = 0;
  for (;;) {
    if (signal.aborted) return interrupted();
    if (opts.maxSteps !== undefined && summary.done >= opts.maxSteps) return finish(EXIT.OK);

    const planBefore = readPlan()!;
    const parsed = parsePlan(planBefore);
    if (parsed.errors.length) {
      for (const e of parsed.errors) out(`error: ${opts.plan}: ${e}`);
      return finish(EXIT.INVALID);
    }
    if (opts.only && ran > 0) return finish(EXIT.OK);
    const step = pick(parsed);
    if (!step) {
      if (opts.only) {
        out(`error: step ${opts.only} is not pending`);
        return finish(EXIT.INVALID);
      }
      out(parsed.steps.some((s) => s.state === "!") ? "No more pending steps (some are blocked)." : "Plan complete.");
      return finish(EXIT.OK);
    }
    ran++;

    // The runner is the authority: plan and handoff text are captured here and written back after
    // every attempt, so anything the agent did to those files is discarded.
    const handoffBefore = existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : null;
    if (handoffBefore && isOversized(handoffBefore, opts.handoffMaxBytes)) {
      out(`warning: ${opts.handoff} exceeds ${opts.handoffMaxBytes} bytes; the agent is told to read only the last ${opts.handoffTail} entries`);
    }
    const restoreFiles = () => {
      writeFileSync(planPath, planBefore);
      if (handoffBefore === null) rmSync(handoffPath, { force: true });
      else writeFileSync(handoffPath, handoffBefore);
    };

    const stepStart = (await git.headSha(cwd))!;
    const verifyCmd = step.verify ?? opts.verify;
    const maxAttempts = 1 + opts.retries;
    const stepT0 = Date.now();
    out(`\n▶ ${step.id}: ${step.title}`);

    let stepCost = 0;
    let turns = 0;
    let attempts = 0;
    let success: StepResult | undefined;
    let failure: AttemptFailure | undefined;
    let blockedResult: StepResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      rmSync(resultPath, { force: true });
      mkdirSync(stateDir, { recursive: true });
      const prompt = buildPrompt({ step, verifyCmd, handoffTail: opts.handoffTail, previousFailure: failure?.text });
      if (attempt > 1) out(`  retry ${attempt - 1}/${opts.retries} (fresh session)`);

      let r;
      try {
        r = await deps.backend.runStep({
          prompt,
          cwd,
          allowedTools: effectiveAllowedTools(opts, step.verify),
          disallowedTools: opts.disallowedTools,
          permissionMode: opts.permissionMode,
          maxTurns: opts.maxTurns,
          model: opts.model,
          signal,
          onEvent: (e) => {
            log.write(step.id, attempt, e);
            if (e.type === "tool") out(`  · ${e.name}`);
            else if (e.type === "text" && opts.verbose) out(e.text);
          },
        });
      } catch (e) {
        r = { ok: false, error: (e as Error).message } as Awaited<ReturnType<Backend["runStep"]>>;
      }
      if (signal.aborted) return interrupted();

      if (r.costUsd !== undefined) {
        stepCost += r.costUsd;
        summary.cost += r.costUsd;
        summary.costKnown = true;
      } else if (opts.budget !== undefined && !warnedNoCost) {
        warnedNoCost = true;
        out("warning: backend did not report cost; --budget cannot be enforced");
      }
      turns += r.turns ?? 0;

      // restore runner-owned files, and detect agent commits
      restoreFiles();
      let attemptFailure: AttemptFailure | undefined;
      const head = await git.headSha(cwd);
      if (head !== stepStart) {
        attemptFailure = { kind: "other", text: "The agent created git commits. Never commit: the runner does that." };
        if (dirty) await git.resetSoft(cwd, stepStart);
        else await git.resetHard(cwd, stepStart);
      } else if (!r.ok) {
        attemptFailure = { kind: "other", text: `The agent session failed: ${r.error ?? "unknown error"}` };
      } else {
        const res = await readStepResult(resultPath, step.id);
        if (!res.ok) attemptFailure = { kind: "other", text: res.error };
        else if (res.result.status === "blocked") {
          blockedResult = res.result;
        } else {
          if (verifyCmd) {
            const v = await runVerify(verifyCmd, cwd);
            if (!v.ok) attemptFailure = { kind: "verify", text: `\`${verifyCmd}\` exited with code ${v.code}\n${v.output}` };
          }
          if (!attemptFailure) success = res.result;
        }
      }

      if (blockedResult || success) break;

      failure = attemptFailure!;
      out(`  ✗ attempt ${attempt} failed: ${failure.text.split("\n")[0]}`);
      const overBudget = opts.budget !== undefined && summary.cost > opts.budget;
      if (attempt < maxAttempts && !overBudget) await discard(stepStart);
      if (overBudget) {
        await discard(stepStart);
        out(`Budget exceeded (${formatCost(summary.cost)} > $${opts.budget}). ${step.id} left pending.`);
        return finish(EXIT.BUDGET);
      }
    }

    const duration = formatDuration(Date.now() - stepT0);
    const base = { stepId: step.id, title: step.title, date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), base: stepStart.slice(0, 7) };

    // ---- blocked ----
    if (blockedResult) {
      await discard(stepStart);
      writeFileSync(planPath, setStepState(planBefore, step.id, "!"));
      writeFileSync(handoffPath, renderHandoff(handoffBefore, { ...base, summary: blockedResult.summary, notes: blockedResult.notes, blockedReason: blockedResult.blockedReason }));
      await git.commitPaths(cwd, [planRel, handoffRel], `autopilot: ${step.id} blocked`);
      summary.blocked++;
      out(`■ ${step.id} blocked: ${blockedResult.blockedReason} (attempts ${attempts}, turns ${turns}, ${formatCost(stepCost)}, ${duration})`);
      return finish(EXIT.FAILED);
    }

    // ---- exhausted ----
    if (!success) {
      await discard(stepStart);
      const reason = failure!.kind === "verify" ? "failed verification" : failure!.text.split("\n")[0]!;
      writeFileSync(planPath, setStepState(planBefore, step.id, "!"));
      writeFileSync(
        handoffPath,
        renderHandoff(handoffBefore, { ...base, summary: `Failed after ${attempts} attempt(s).`, blockedReason: reason }),
      );
      await git.commitPaths(cwd, [planRel, handoffRel], `autopilot: ${step.id} failed`);
      summary.blocked++;
      out(`■ ${step.id} failed: ${reason} (attempts ${attempts}, turns ${turns}, ${formatCost(stepCost)}, ${duration})`);
      return finish(EXIT.FAILED);
    }

    // ---- success ----
    const planAfter = setStepState(planBefore, step.id, "x");
    if (pendingCount(parsePlan(planAfter)) >= pendingCount(parsed)) {
      out(`error: no progress after marking ${step.id} done (plan parser bug?); aborting`);
      return finish(EXIT.FAILED);
    }
    writeFileSync(planPath, planAfter);
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, renderHandoff(handoffBefore, { ...base, summary: success.summary, notes: success.notes }));
    const sha = await git.commitAll(cwd, `autopilot: ${step.id} ${step.title}`);
    summary.done++;
    out(`✔ ${step.id} done as ${sha} (attempts ${attempts}, turns ${turns}, ${formatCost(stepCost)}, ${duration})`);

    if (opts.budget !== undefined && summary.cost > opts.budget) {
      out(`Budget exceeded (${formatCost(summary.cost)} > $${opts.budget}).`);
      return finish(EXIT.BUDGET);
    }
  }
}
