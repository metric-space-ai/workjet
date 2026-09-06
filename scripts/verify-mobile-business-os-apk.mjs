import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const apk = process.argv[2];
assert(apk, "Pass the signed APK path");
const prefix = "assets/workjet-business-os/";
const entries = execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" }).split("\n");
const manifest = JSON.parse(
  execFileSync("unzip", ["-p", apk, `${prefix}manifest.json`], { encoding: "utf8" }),
);
assert.equal(manifest.type, "workjet.bundled-business-os-shell.v1");
assert.match(manifest.packId, /^[0-9a-f]{64}$/u);
assert(manifest.files.length > 0);
for (const file of manifest.files) {
  assert(
    entries.includes(`${prefix}payload/${file.path}`),
    `APK omitted shell resource ${file.path}`,
  );
}
for (const file of ["index.html", "mobile-host.js", "mobile-host.css", "mobile-apps.json"]) {
  assert(entries.includes(`${prefix}payload/${file}`), `APK omitted mobile entry ${file}`);
}
assert(!entries.some((entry) => entry.startsWith(`${prefix}payload/vendor/ctox-office/`)));
console.log(
  `Verified bundled Business OS ${manifest.packId}: ${manifest.files.length} APK resources`,
);
