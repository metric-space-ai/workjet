import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";

const apk = process.argv[2];
NodeAssert.ok(apk, "Pass the signed APK path");
const prefix = "assets/workjet-business-os/";
const entries = NodeChildProcess.execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" }).split(
  "\n",
);
const manifest = JSON.parse(
  NodeChildProcess.execFileSync("unzip", ["-p", apk, `${prefix}manifest.json`], {
    encoding: "utf8",
  }),
);
NodeAssert.equal(manifest.type, "workjet.bundled-business-os-shell.v1");
NodeAssert.match(manifest.packId, /^[0-9a-f]{64}$/u);
NodeAssert.ok(manifest.files.length > 0);
for (const file of manifest.files) {
  NodeAssert.ok(
    entries.includes(`${prefix}payload/${file.path}`),
    `APK omitted shell resource ${file.path}`,
  );
}
for (const file of ["index.html", "mobile-host.js", "mobile-host.css", "mobile-apps.json"]) {
  NodeAssert.ok(entries.includes(`${prefix}payload/${file}`), `APK omitted mobile entry ${file}`);
}
NodeAssert.ok(!entries.some((entry) => entry.startsWith(`${prefix}payload/vendor/ctox-office/`)));
console.log(
  `Verified bundled Business OS ${manifest.packId}: ${manifest.files.length} APK resources`,
);
