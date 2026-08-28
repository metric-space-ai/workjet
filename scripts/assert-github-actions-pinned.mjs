import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const workflowRoot = NodeURL.fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const USES_LINE = /^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u;

function mutableActionReference(line) {
  const match = USES_LINE.exec(line);
  if (!match || match[1].startsWith("./")) return null;
  const separator = match[1].lastIndexOf("@");
  if (separator <= 0) return match[1];
  const reference = match[1].slice(separator + 1);
  return COMMIT_SHA.test(reference) ? null : match[1];
}

async function workflowFiles(directory) {
  const files = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await workflowFiles(path)));
    if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function selfTest() {
  if (mutableActionReference("  uses: actions/checkout@v6") === null) {
    throw new Error("mutable tag was accepted");
  }
  if (mutableActionReference("  uses: owner/action@main") === null) {
    throw new Error("mutable branch was accepted");
  }
  if (
    mutableActionReference(
      "  uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    ) !== null
  ) {
    throw new Error("immutable commit pin was rejected");
  }
  if (mutableActionReference("  uses: ./local-action") !== null) {
    throw new Error("local action was rejected");
  }
}

selfTest();
const failures = [];
for (const file of await workflowFiles(workflowRoot)) {
  const lines = (await NodeFSP.readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    const reference = mutableActionReference(line);
    if (reference) {
      failures.push(`${NodePath.relative(workflowRoot, file)}:${index + 1}: ${reference}`);
    }
  });
}

if (failures.length > 0) {
  console.error("GitHub Actions must use immutable 40-character commit SHAs:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("GitHub Actions immutable-pin guard passed");
