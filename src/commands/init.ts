import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// resolves from both src/commands/ and dist/commands/
const TEMPLATES = fileURLToPath(new URL("../../templates", import.meta.url));

const DEFAULT_CONFIG = {
  verify: "bun test",
  allowedTools: [
    "Skill", "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(bun test:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  ],
  handoffTail: 8,
  keepLogs: false,
};

export function runInit(cwd: string, out: (line: string) => void): number {
  const files: Array<[string, string]> = [
    ["PLAN.md", readFileSync(join(TEMPLATES, "PLAN.md"), "utf8")],
    ["HANDOFF.md", readFileSync(join(TEMPLATES, "HANDOFF.md"), "utf8")],
    [".claude/skills/autopilot-step/SKILL.md", readFileSync(join(TEMPLATES, "skills/autopilot-step/SKILL.md"), "utf8")],
    [".autopilot.json", JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n"],
  ];

  for (const [rel, content] of files) {
    const path = join(cwd, rel);
    if (existsSync(path)) {
      out(`skipped  ${rel} (already exists)`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    out(`created  ${rel}`);
  }

  const giPath = join(cwd, ".gitignore");
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const has = existing.split("\n").some((l) => /^\/?\.autopilot\/?\*?$/.test(l.trim()));
  if (has) out("skipped  .gitignore (.autopilot/ already ignored)");
  else {
    appendFileSync(giPath, (existing && !existing.endsWith("\n") ? "\n" : "") + ".autopilot/\n");
    out(`${existing ? "updated " : "created "} .gitignore (.autopilot/)`);
  }

  out("\nNext: edit PLAN.md (or generate it with /autopilot:plan <description>), commit the scaffolded files (run requires a clean tree), then `autopilot run`.");
  return 0;
}
