import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "skills/decision-hub-escalation/SKILL.md");
const outputPath = resolve(root, "src/generated/decision-hub-skill.ts");
const source = readFileSync(sourcePath, "utf8")
  .replace(/^---\n[\s\S]*?\n---\n+/, "")
  .trim();
const output =
  `// Generated from skills/decision-hub-escalation/SKILL.md. Do not edit.\n` +
  `export const DECISION_HUB_SKILL_PROMPT =\n  ${JSON.stringify(source)};\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== output) process.exit(1);
} else {
  writeFileSync(outputPath, output);
}
