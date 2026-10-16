// @effect-diagnostics nodeBuiltinImport:off - Der Wächter liest die vendorten Bytes direkt.
// The vendored kernel and the Workjet bridge contract are byte copies of CTOX at KERNEL_PIN.
// A pin change is one line in kernel/KERNEL_PIN plus `node scripts/v4-vendor-kernel.mjs <ctox>`.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url));
const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const provenance: {
  commit: string;
  files: { path: string; sha256: string }[];
  contracts: { path: string; sha256: string }[];
  licenseSha256: string;
} = JSON.parse(read("./kernel/PROVENANCE.json").toString("utf8"));

it("pins exactly one kernel commit", () => {
  expect(read("./kernel/KERNEL_PIN").toString("utf8").trim()).toBe(provenance.commit);
  expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
});

it("keeps every vendored kernel file, the license and the contract byte-identical", () => {
  expect(provenance.files.length).toBeGreaterThan(0);
  for (const file of provenance.files)
    expect(sha256(read(`./kernel/${file.path}`)), file.path).toBe(file.sha256);
  expect(sha256(read("./kernel/LICENSE"))).toBe(provenance.licenseSha256);
  for (const contract of provenance.contracts)
    expect(sha256(read(`./contract/${contract.path.split("/").at(-1)}`)), contract.path).toBe(
      contract.sha256,
    );
});

const pinned = (dir: string) =>
  [
    ...read(`./${dir}/PIN.md`)
      .toString("utf8")
      .matchAll(/^\| *([\w.-]+\.(?:m?js|d\.ts)) *\|(?:[^|]*\|)? *([0-9a-f]{64}) *\|$/gm),
  ].map(([, file, hash]) => ({ file: file!, hash: hash! }));

it.each([
  [
    "contract/workjet-dispatch",
    ["dispatch.js", "outcome-contract.js", "sha256.js", "workjet.worker.dispatch.js"],
  ],
  ["stub-e51", ["ctox-app-api-stub.mjs", "index.d.ts"]],
])("keeps the pinned copy in %s byte-identical", (dir, files) => {
  const rows = pinned(dir);
  expect(rows.map((row) => row.file).sort()).toEqual([...files].sort());
  for (const { file, hash } of rows) expect(sha256(read(`./${dir}/${file}`)), file).toBe(hash);
});
