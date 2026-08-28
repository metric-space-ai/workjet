import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const root = NodePath.resolve(import.meta.dirname, "..");
const exceptionExpiresAt = Date.parse("2026-09-30T00:00:00Z");
const patchPath = NodePath.join(root, "patches/image-size@1.2.1.patch");
const expectedPatchSha256 = "1433e7cd28491073297af5d30f5514a4d6c5aae14b8fef5d111cd88200381cd1";
const acceptedImageSizeAdvisories = new Set(["GHSA-w3rx-r6r6-pgpr", "GHSA-5p2g-fcmc-qvqq"]);
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

if (Date.now() >= exceptionExpiresAt) {
  fail("the image-size@1.2.1 exception expired; upgrade or renew it with review evidence");
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

const patch = NodeFS.readFileSync(patchPath);
const patchSha256 = NodeCrypto.createHash("sha256").update(patch).digest("hex");
if (patchSha256 !== expectedPatchSha256) fail("image-size parser patch hash changed");

const patchText = patch.toString("utf8");
for (const parser of ["heif", "icns", "jxl", "jxl-stream"]) {
  if (
    !patchText.includes(`-const ${parser.replace("-", "_")}_1 = require("./${parser}");`) &&
    parser !== "jxl-stream"
  ) {
    fail(`patch does not remove the ${parser} parser import`);
  }
  if (!patchText.includes(`-    ${parser === "jxl-stream" ? "'jxl-stream'" : parser}:`)) {
    fail(`patch does not remove the ${parser} parser handler`);
  }
}

const workspace = NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8");
if (!/image-size@1\.2\.1:\s+patches\/image-size@1\.2\.1\.patch/.test(workspace)) {
  fail("image-size@1.2.1 is not bound to the reviewed patch");
}

let registryResponse;
try {
  registryResponse = await fetch("https://registry.npmjs.org/image-size", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  fail(`could not inspect available image-size releases: ${String(error)}`);
}
if (!registryResponse.ok) {
  fail(`registry returned unexpected status ${registryResponse.status} for image-size metadata`);
}
let registryMetadata;
try {
  registryMetadata = await registryResponse.json();
} catch (error) {
  fail(`registry returned invalid image-size metadata: ${String(error)}`);
}
const newerStableRelease = Object.keys(registryMetadata.versions ?? {}).find((version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patchVersion] = match.map(Number);
  return major > 2 || (major === 2 && (minor > 0 || (minor === 0 && patchVersion > 2)));
});
if (newerStableRelease) {
  fail(
    `image-size@${newerStableRelease} is available; remove the exception and review the upgrade`,
  );
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

const acceptedSeen = new Set();
for (const advisory of Object.values(auditReport.advisories ?? {})) {
  if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
  const id = advisory.github_advisory_id;
  if (
    advisory.module_name === "image-size" &&
    advisory.findings?.every((finding) => finding.version === "1.2.1") &&
    acceptedImageSizeAdvisories.has(id)
  ) {
    acceptedSeen.add(id);
    continue;
  }
  fail(`unaccepted ${advisory.severity} advisory ${id ?? advisory.id} in ${advisory.module_name}`);
}
for (const id of acceptedImageSizeAdvisories) {
  if (!acceptedSeen.has(id)) fail(`${id} disappeared; remove the now-obsolete exception`);
}

const virtualStore = NodePath.join(root, "node_modules", ".pnpm");
if (!NodeFS.existsSync(virtualStore)) fail("node_modules is missing; run pnpm install first");
const imageSizeEntry = NodeFS.readdirSync(virtualStore).find((name) =>
  name.startsWith("image-size@1.2.1"),
);
if (!imageSizeEntry) fail("patched image-size@1.2.1 installation is missing");
const imageSizeRoot = NodePath.join(virtualStore, imageSizeEntry, "node_modules", "image-size");
const handlersSource = NodeFS.readFileSync(
  NodePath.join(imageSizeRoot, "dist", "types", "index.js"),
  "utf8",
);
if (/require\("\.\/(?:heif|icns|jxl|jxl-stream)"\)/.test(handlersSource)) {
  fail("a disabled image parser is still imported by the installed package");
}
if (/^\s*(?:heif|icns|jxl|'jxl-stream')\s*:/mu.test(handlersSource)) {
  fail("a disabled image parser is still registered by the installed package");
}

const imported = NodeModule.createRequire(import.meta.url)(imageSizeRoot);
const imageSize = imported.imageSize ?? imported.default ?? imported;
const probes = [
  ["icns", Buffer.concat([Buffer.from("icns"), Buffer.alloc(20)])],
  ["jxl", Buffer.from([0xff, 0x0a, ...new Array(22).fill(0)])],
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
  "Supply-chain guard OK (no unaccepted high/critical advisories; image-size exception bounded).",
);
