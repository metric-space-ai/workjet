import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const sourcePath = NodePath.resolve(root, "skills/decision-hub-escalation/SKILL.md");
const outputPath = NodePath.resolve(root, "src/generated/decision-hub-skill.ts");
const source = NodeFS.readFileSync(sourcePath, "utf8")
  .replace(/^---\n[\s\S]*?\n---\n+/, "")
  .trim();
const output =
  `// Generated from skills/decision-hub-escalation/SKILL.md. Do not edit.\n` +
  `export const DECISION_HUB_SKILL_PROMPT =\n  ${JSON.stringify(source)};\n`;
if (process.argv.includes("--check")) {
  if (NodeFS.readFileSync(outputPath, "utf8") !== output) process.exit(1);
} else {
  NodeFS.writeFileSync(outputPath, output);
}
