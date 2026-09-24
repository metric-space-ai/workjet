import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(import.meta.dirname, "..");
const reviewedImageSizeVersion = "2.0.4";
const mobileProductionWorkflowPath = NodePath.join(
  root,
  ".github/workflows/mobile-eas-production.yml",
);
const mobilePreviewWorkflowPath = NodePath.join(root, ".github/workflows/mobile-eas-preview.yml");
const mobileEasConfigPath = NodePath.join(root, "apps/mobile/eas.json");
const mobileAppConfigPath = NodePath.join(root, "apps/mobile/app.config.ts");

function fail(message) {
  console.error(`supply-chain guard failed: ${message}`);
  process.exit(1);
}

const mobileProductionWorkflow = NodeFS.readFileSync(mobileProductionWorkflowPath, "utf8");
const mobilePreviewWorkflow = NodeFS.readFileSync(mobilePreviewWorkflowPath, "utf8");
const mobileEasConfig = JSON.parse(NodeFS.readFileSync(mobileEasConfigPath, "utf8"));
const mobileAppConfig = NodeFS.readFileSync(mobileAppConfigPath, "utf8");
if (mobileEasConfig.cli?.version !== "22.6.0") {
  fail("apps/mobile/eas.json must pin the reviewed EAS CLI version 22.6.0 exactly");
}
if (mobileProductionWorkflow.includes("--no-wait")) {
  fail("the mobile production workflow may not detach signed EAS builds");
}
for (const [source, label] of [
  [mobileProductionWorkflow, "production workflow"],
  [mobilePreviewWorkflow, "preview workflow"],
  [mobileAppConfig, "Expo app config"],
  [JSON.stringify(mobileEasConfig), "EAS config"],
]) {
  if (/continuous-deploy-fingerprint|\beas update\b|MOBILE_VERSION_POLICY/u.test(source)) {
    fail(`${label} reintroduced an OTA or fingerprint deployment path`);
  }
}
if (
  !/eas build --platform all --profile preview --non-interactive --wait/u.test(
    mobilePreviewWorkflow,
  )
) {
  fail("the preview workflow must produce completed signed internal binaries");
}
if (!/NSAllowsArbitraryLoads:\s*false/u.test(mobileAppConfig)) {
  fail("the iOS production config must keep arbitrary network loads disabled");
}
const androidCleartextPlugin = NodeFS.readFileSync(
  NodePath.join(root, "apps/mobile/plugins/withAndroidCleartextTraffic.cjs"),
  "utf8",
);
if (!/android:usesCleartextTraffic"\]\s*=\s*"false"/u.test(androidCleartextPlugin)) {
  fail("the Android manifest plugin must keep cleartext traffic disabled");
}
if ((mobileProductionWorkflow.match(/eas build .*--wait/g) ?? []).length < 2) {
  fail("manual and automatic mobile production builds must wait for EAS completion");
}
for (const releaseEvidenceFlag of ["--status finished", '--git-commit-hash "$GITHUB_SHA"']) {
  if (!mobileProductionWorkflow.includes(releaseEvidenceFlag)) {
    fail(
      `the mobile production workflow is missing exact release evidence: ${releaseEvidenceFlag}`,
    );
  }
}
for (const [setting, expected] of [
  ["deploymentTarget", '"26.0"'],
  ["minSdkVersion", "24"],
  ["compileSdkVersion", "36"],
  ["targetSdkVersion", "36"],
  ["buildToolsVersion", '"36.0.0"'],
]) {
  const pattern = new RegExp(`\\b${setting}:\\s*${expected.replaceAll(".", "\\.")}(?:,|\\s)`);
  if (!pattern.test(mobileAppConfig)) {
    fail(`apps/mobile/app.config.ts must pin the reviewed Expo 56 ${setting} value ${expected}`);
  }
}
for (const [pod, version] of [
  ["GoogleUtilities", "8.1.3"],
  ["RecaptchaInterop", "101.0.0"],
]) {
  const pattern = new RegExp(
    `name:\\s*["']${pod}["'][\\s\\S]{0,100}version:\\s*["']${version.replaceAll(".", "\\.")}["']`,
  );
  if (!pattern.test(mobileAppConfig)) {
    fail(`apps/mobile/app.config.ts must pin ${pod} ${version} exactly`);
  }
}

const workspace = NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8");
if (!/^  image-size: 2\.0\.4$/m.test(workspace)) {
  fail(`image-size must be overridden to reviewed ${reviewedImageSizeVersion}`);
}

if (!/^  image-size@2\.0\.4: patches\/image-size@2\.0\.4\.patch$/m.test(workspace)) {
  fail("image-size@2.0.4 must use the reviewed Metro compatibility patch");
}
const imageSizePatch = NodeFS.readFileSync(NodePath.join(root, "patches/image-size@2.0.4.patch"));
const imageSizePatchHash = NodeCrypto.createHash("sha256").update(imageSizePatch).digest("hex");
if (imageSizePatchHash !== "c54eef7bb5043a964fc89d57b5a7c970dd60e97b4c11f2d0f0458e71a2783cf2") {
  fail("image-size@2.0.4 Metro compatibility patch changed");
}

const audit = NodeChildProcess.spawnSync("pnpm", ["audit", "--prod", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const jsonStart = audit.stdout.indexOf("{");
if (jsonStart < 0) fail(`pnpm audit returned no JSON: ${audit.stderr.trim()}`);
let auditReport;
try {
  auditReport = JSON.parse(audit.stdout.slice(jsonStart));
} catch (error) {
  fail(`pnpm audit JSON was invalid: ${String(error)}`);
}

for (const advisory of Object.values(auditReport.advisories ?? {})) {
  if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
  const id = advisory.github_advisory_id;
  fail(`unaccepted ${advisory.severity} advisory ${id ?? advisory.id} in ${advisory.module_name}`);
}

const virtualStore = NodePath.join(root, "node_modules", ".pnpm");
if (!NodeFS.existsSync(virtualStore)) fail("node_modules is missing; run pnpm install first");
const imageSizeEntry = NodeFS.readdirSync(virtualStore).find((name) =>
  name.startsWith(`image-size@${reviewedImageSizeVersion}`),
);
if (!imageSizeEntry) fail(`image-size@${reviewedImageSizeVersion} installation is missing`);
const imageSizeRoot = NodePath.join(virtualStore, imageSizeEntry, "node_modules", "image-size");
const imported = NodeModule.createRequire(import.meta.url)(imageSizeRoot);
if (typeof imported.default !== "function")
  fail("Metro's default image-size import is not callable");
const imageSize = imported.default;
const probes = [
  ["icns", Buffer.from([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 16, 0x69, 0x63, 0x30, 0x37, 0, 0, 0, 0])],
  ["jxl", Buffer.from([0, 0, 0, 0, 0x4a, 0x58, 0x4c, 0x20])],
  ["heif", Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
];
const parserProbe = NodeChildProcess.spawnSync(
  process.execPath,
  [
    "-e",
    [
      "async function run() {",
      "  const cjs = require(process.argv[1]).default;",
      "  const esm = (await import(require('node:url').pathToFileURL(process.argv[2]).href)).default;",
      "  for (const [format, imageSize] of [['CommonJS', cjs], ['ESM', esm]]) {",
      "    for (const [name, bytes] of JSON.parse(process.argv[3])) {",
      "      for (const input of [Buffer.from(bytes), bytes]) {",
      "        let rejected = false;",
      "        try { imageSize(input); } catch { rejected = true; }",
      "        if (!rejected) { console.error(format + ' ' + name + ' malformed input was accepted'); process.exit(2); }",
      "      }",
      "    }",
      "  }",
      "}",
      "run().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n"),
    imageSizeRoot,
    NodePath.join(imageSizeRoot, "dist/esm/index.js"),
    JSON.stringify(probes.map(([name, bytes]) => [name, Array.from(bytes)])),
  ],
  { encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024 },
);
if (parserProbe.error)
  fail("image-size malformed-input probe failed or timed out: " + parserProbe.error);
if (parserProbe.status !== 0)
  fail("image-size malformed-input probe failed: " + parserProbe.stderr);
const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 0, 0, 0, 0,
]);
const dimensions = imageSize(png);
if (dimensions.width !== 1 || dimensions.height !== 1) {
  fail("image-size no longer parses a valid 1×1 PNG for Metro");
}
const imageSizeEsm = (
  await import(NodeURL.pathToFileURL(NodePath.join(imageSizeRoot, "dist/esm/index.js")).href)
).default;
if (typeof imageSizeEsm !== "function") fail("Metro's ESM image-size import is not callable");
for (const [format, parse] of [
  ["CommonJS", imageSize],
  ["ESM", imageSizeEsm],
]) {
  const arrayPng = parse(Array.from(png));
  if (arrayPng.width !== 1 || arrayPng.height !== 1) {
    fail(format + " image-size cannot parse Metro's plain-array PNG input");
  }
  for (const asset of ["assets/ctox/ctox-app-icon.png", "assets/nightly/nightly-ios-1024.png"]) {
    const bytes = NodeFS.readFileSync(NodePath.join(root, asset));
    const size = parse(Array.from(bytes));
    if (!(size.width > 0 && size.height > 0)) {
      fail(format + " image-size cannot parse Metro asset " + asset);
    }
  }
}

console.log(
  "Supply-chain guard OK (no high/critical advisories; reviewed image-size release probed).",
);
