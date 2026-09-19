import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const root = NodePath.resolve(import.meta.dirname, "..");
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

const mobileRequire = NodeModule.createRequire(NodePath.join(root, "apps/mobile/package.json"));
const expoRequire = NodeModule.createRequire(mobileRequire.resolve("expo/package.json"));
const expoMetroRequire = NodeModule.createRequire(expoRequire.resolve("@expo/metro/package.json"));
const metroRequire = NodeModule.createRequire(expoMetroRequire.resolve("metro/package.json"));
const imageSizePackage = JSON.parse(
  NodeFS.readFileSync(
    NodePath.resolve(metroRequire.resolve("image-size"), "../../../package.json"),
    "utf8",
  ),
);
if (imageSizePackage.version !== "2.0.4") {
  fail("Metro must resolve the reviewed image-size@2.0.4 installation");
}
const imported = metroRequire("image-size");
const imageSize = imported.imageSize ?? imported.default ?? imported;
const { getAssetSize } = expoMetroRequire("metro/private/Assets");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const dimensions = getAssetSize("png", png, "supply-chain-probe.png");
if (dimensions?.width !== 1 || dimensions?.height !== 1) {
  fail("Metro image-size buffer compatibility probe returned incorrect PNG dimensions");
}
const probes = [
  ["icns", Buffer.concat([Buffer.from("icns"), Buffer.alloc(20)])],
  ["jxl", Buffer.from("00000018667479706a786c20000000006a786c2000000000000000006a786c63", "hex")],
  ["heif", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)])],
];
for (const [name, bytes] of probes) {
  const startedAt = performance.now();
  let rejected = false;
  try {
    imageSize(bytes);
  } catch {
    rejected = true;
  }
  if (!rejected) fail(`${name} negative parser probe was accepted`);
  if (performance.now() - startedAt > 100) fail(`${name} negative parser probe exceeded 100 ms`);
}

console.log(
  "Supply-chain guard OK (no high/critical advisories; reviewed image-size parser probes passed).",
);
