// Single source: ctox `src/skills/system/integrations/ctox-toolhub/SKILL.md`,
// vendored verbatim to skills/ctox-toolhub/SKILL.md. Only the text between the
// `toolhub-prompt` markers becomes the role-aware capability prompt.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const sourcePath = NodePath.resolve(root, "skills/ctox-toolhub/SKILL.md");
const outputPath = NodePath.resolve(root, "src/generated/ctox-toolhub-skill.ts");
const raw = NodeFS.readFileSync(sourcePath, "utf8");
const block = (marker) => {
  const open = `<!-- toolhub-prompt:${marker} -->`;
  const start = raw.indexOf(open);
  if (start < 0) throw new Error(`ctox-toolhub skill: missing ${open}`);
  const rest = raw.slice(start + open.length);
  const end = rest.indexOf("<!-- toolhub-prompt:");
  if (end < 0) throw new Error(`ctox-toolhub skill: unterminated ${open}`);
  return rest.slice(0, end).trim();
};
const prompt = {
  common: block("common"),
  roles: {
    supervisor: block("role:supervisor"),
    persistent_worker: block("role:persistent_worker"),
    one_shot_worker: block("role:one_shot_worker"),
    operator: block("role:operator"),
  },
};
const sha = NodeCrypto.createHash("sha256").update(raw).digest("hex");
const output =
  `// Generated from skills/ctox-toolhub/SKILL.md (ctox source, sha256 ${sha}). Do not edit.\n` +
  `export const CTOX_TOOLHUB_PROMPT = ${JSON.stringify(prompt, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (NodeFS.readFileSync(outputPath, "utf8") !== output) process.exit(1);
} else {
  NodeFS.writeFileSync(outputPath, output);
}
