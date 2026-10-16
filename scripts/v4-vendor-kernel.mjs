#!/usr/bin/env node
// Vendors the CTOX v4 kernel byte-for-byte from a local ctox checkout at the commit in
// apps/web/src/ctox/kernel/KERNEL_PIN (one line). A pin change is: edit KERNEL_PIN, run
//   node scripts/v4-vendor-kernel.mjs <path-to-ctox-checkout>
// and commit. PROVENANCE.json records the commit, git blob and sha256 of every file;
// apps/web/src/ctox/kernelProvenance.test.ts verifies them.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { execFileSync } = NodeChildProcess;
const { createHash } = NodeCrypto;
const { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = NodeFS;
const { dirname, join } = NodePath;
const { fileURLToPath } = NodeURL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "apps/web/src/ctox/kernel");
const ctox = process.argv[2];
if (!ctox) throw new Error("usage: v4-vendor-kernel.mjs <ctox-checkout>");
const pin = readFileSync(join(target, "KERNEL_PIN"), "utf8").trim();
if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error("KERNEL_PIN must be a full 40-hex commit");
const source = "src/apps/business-os/kernel";
const git = (...args) => execFileSync("git", ["-C", ctox, ...args], { maxBuffer: 1 << 28 });
const listed = git("ls-tree", "-r", "--name-only", pin, `${source}/`)
  .toString()
  .split("\n")
  .filter(Boolean)
  .map((path) => path.slice(source.length + 1));
// Runtime modules + public types only: no tests, testkit or docs (E38.2).
const files = listed.filter(
  (path) =>
    !path.startsWith("tests/") &&
    !path.startsWith("testkit/") &&
    (/^[^/]+\.mjs$/.test(path) || path === "index.d.ts" || /^vendor\/[^/]+\.(m?js)$/.test(path)),
);
for (const name of readdirSync(target))
  if (name.endsWith(".mjs") || name === "index.d.ts") rmSync(join(target, name));
rmSync(join(target, "vendor"), { recursive: true, force: true });
const entries = [];
for (const path of files.sort()) {
  const bytes = git("show", `${pin}:${source}/${path}`);
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), bytes);
  entries.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlob: git("rev-parse", `${pin}:${source}/${path}`).toString().trim(),
  });
}
// The Workjet bridge command contract (E27.6) at the same pin; the gate tests check against it.
const contracts = [];
for (const path of ["tests/sync_v4_e25/wjb-command-types.json"]) {
  const bytes = git("show", `${pin}:${path}`);
  const out = join(root, "apps/web/src/ctox/contract", path.split("/").at(-1));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  contracts.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const license = git("show", `${pin}:LICENSE`);
writeFileSync(join(target, "LICENSE"), license);
writeFileSync(
  join(target, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      repository: "https://github.com/metric-space-ai/ctox",
      commit: pin,
      sourceDirectory: source,
      files: entries,
      contracts,
      licenseSha256: createHash("sha256").update(license).digest("hex"),
    },
    null,
    2,
  )}\n`,
);
console.log(`vendored ${entries.length} kernel files at ${pin}`);
