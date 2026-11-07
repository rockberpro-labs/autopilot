import { run } from "./proc.ts";

const EXCLUDE_STATE = ":(exclude).autopilot";

async function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const { stdout, stderr, code } = await run("git", args, { cwd });
  if (code !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  return out.trim() === "true";
}

/** Returns null when the repository has no commits yet. */
export async function headSha(cwd: string): Promise<string | null> {
  const out = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
  return out.trim() || null;
}

/** Runner state under .autopilot/ is ignored even when .gitignore does not list it. */
export async function isClean(cwd: string): Promise<boolean> {
  const out = await git(cwd, ["status", "--porcelain", "--", ".", EXCLUDE_STATE]);
  return out.trim() === "";
}

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  const exists = (await git(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${name}`], { allowFail: true })).trim();
  await git(cwd, exists ? ["checkout", name] : ["checkout", "-b", name]);
}

/** Discards everything since `sha`. Never uses -x; .autopilot/ is always kept. */
export async function resetHard(cwd: string, sha: string): Promise<void> {
  await git(cwd, ["reset", "--hard", sha]);
  await git(cwd, ["clean", "-fd", "-e", ".autopilot"]);
}

/** Moves HEAD back to `sha` but keeps the working tree (used when the tree started dirty). */
export async function resetSoft(cwd: string, sha: string): Promise<void> {
  await git(cwd, ["reset", "--soft", sha]);
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A", "--", ".", EXCLUDE_STATE]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function commitPaths(cwd: string, paths: string[], message: string): Promise<string> {
  await git(cwd, ["add", "--", ...paths]);
  await git(cwd, ["commit", "-q", "-m", message, "--", ...paths]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}
