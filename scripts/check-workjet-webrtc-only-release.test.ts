import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ACTIVE_PRODUCT_ROOTS,
  FORBIDDEN_REFERENCES,
  checkWorkjetWebRtcOnlyRelease,
  isAllowlistedLegacyReference,
  scanLegacyReleaseText,
} from "./check-workjet-webrtc-only-release.ts";

test("detects every forbidden legacy transport and web-session marker family", async () => {
  const fixturePath = new URL(
    "./fixtures/workjet-webrtc-only-release/legacy-markers.txt",
    import.meta.url,
  );
  const source = await readFile(fixturePath, "utf8");

  const markerIds = new Set(
    scanLegacyReleaseText("apps/web/src/legacy.ts", source).map(({ markerId }) => markerId),
  );
  assert.deepEqual([...markerIds].sort(), FORBIDDEN_REFERENCES.map(({ id }) => id).sort());
  assert.deepEqual(
    scanLegacyReleaseText(
      "scripts/fixtures/workjet-webrtc-only-release/legacy-markers.txt",
      source,
    ),
    [],
  );
});

test("accepts a CTOX RxDB/WebRTC-only product path", () => {
  const source = [
    'const protocol = "ctox.workjet.device.v1";',
    'const actions = ["invite.create", "invite.revoke", "binding.list", "binding.revoke"];',
    "await activeGuest.requestAuxiliary({ protocol, request_id, action, payload });",
    "projectRxdbStateToHost(activeInstanceId);",
  ].join("\n");

  assert.deepEqual(scanLegacyReleaseText("apps/desktop/src/ctox/deviceControl.ts", source), []);
});

test("allows only exact fixtures and historical docs, never active product source", () => {
  assert.equal(
    isAllowlistedLegacyReference(
      "scripts/fixtures/workjet-webrtc-only-release/legacy-markers.txt",
      "managed-relay",
    ),
    true,
  );
  assert.equal(
    isAllowlistedLegacyReference("docs/internals/t3-connect.md", "t3-relay-origin"),
    true,
  );
  assert.equal(
    isAllowlistedLegacyReference("docs/internals/t3-connect.md", "device-session-http"),
    false,
  );
  assert.equal(
    isAllowlistedLegacyReference("apps/web/src/t3-connect.md", "t3-relay-origin"),
    false,
  );
  assert.equal(
    scanLegacyReleaseText("apps/web/src/legacy.ts", "createManagedRelayClient").length,
    1,
  );
});

test("scans active non-mobile roots and supplied build artifacts while ignoring mobile", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "workjet-webrtc-only-"));
  const webRoot = path.join(repoRoot, "apps/web/src");
  const mobileRoot = path.join(repoRoot, "apps/mobile/src");
  const artifactRoot = path.join(repoRoot, "release/web");
  const packagedDependencyRoot = path.join(artifactRoot, "node_modules/legacy-runtime");
  await Promise.all([
    mkdir(webRoot, { recursive: true }),
    mkdir(mobileRoot, { recursive: true }),
    mkdir(packagedDependencyRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(webRoot, "clean.ts"), 'export const protocol = "ctox.workjet.device.v1";'),
    writeFile(path.join(mobileRoot, "legacy.ts"), "ManagedRelayClient"),
    writeFile(path.join(artifactRoot, "app.js"), 'fetch("/api/workjet/device-session")'),
    writeFile(path.join(packagedDependencyRoot, "index.js"), "useClerk()"),
  ]);

  const result = await checkWorkjetWebRtcOnlyRelease({
    repoRoot,
    artifactPaths: ["release/web"],
  });

  assert.equal(result.filesScanned, 3);
  assert.deepEqual(
    result.findings.map(({ path: findingPath, markerId }) => [findingPath, markerId]),
    [
      ["release/web/app.js", "device-session-http"],
      ["release/web/node_modules/legacy-runtime/index.js", "clerk-web-session"],
    ],
  );
  assert.ok(ACTIVE_PRODUCT_ROOTS.includes("apps/web/src"));
  assert.ok(!ACTIVE_PRODUCT_ROOTS.some((root) => root.startsWith("apps/mobile")));
});

test("reports a clean scoped tree with no supplied artifacts", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "workjet-webrtc-only-clean-"));
  const sourceRoot = path.join(repoRoot, "product/src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "index.js"), 'export const transport = "rxdb-webrtc";');

  const result = await checkWorkjetWebRtcOnlyRelease({
    repoRoot,
    sourceRoots: ["product/src"],
  });

  assert.deepEqual(result, { filesScanned: 1, findings: [] });
});
