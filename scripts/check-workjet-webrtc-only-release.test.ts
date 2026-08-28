// @effect-diagnostics nodeBuiltinImport:off -- Tests build isolated raw-byte release fixtures on disk.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  ACTIVE_PRODUCT_ROOTS,
  FORBIDDEN_REFERENCES,
  checkWorkjetWebRtcOnlyRelease,
  isAllowlistedLegacyReference,
  scanLegacyReleaseText,
} from "./check-workjet-webrtc-only-release.ts";

NodeTest.test(
  "detects every forbidden legacy transport and web-session marker family",
  async () => {
    const fixturePath = new URL(
      "./fixtures/workjet-webrtc-only-release/legacy-markers.txt",
      import.meta.url,
    );
    const source = await NodeFSP.readFile(fixturePath, "utf8");

    const markerIds = new Set(
      scanLegacyReleaseText("apps/web/src/legacy.ts", source).map(({ markerId }) => markerId),
    );
    NodeAssert.deepEqual([...markerIds].sort(), FORBIDDEN_REFERENCES.map(({ id }) => id).sort());
    NodeAssert.deepEqual(
      scanLegacyReleaseText(
        "scripts/fixtures/workjet-webrtc-only-release/legacy-markers.txt",
        source,
      ),
      [],
    );
  },
);

NodeTest.test("accepts a CTOX RxDB/WebRTC-only product path", () => {
  const source = [
    'const protocol = "ctox.workjet.device.v1";',
    'const actions = ["invite.create", "invite.revoke", "binding.list", "binding.revoke"];',
    "await activeGuest.requestAuxiliary({ protocol, request_id, action, payload });",
    "projectRxdbStateToHost(activeInstanceId);",
  ].join("\n");

  NodeAssert.deepEqual(scanLegacyReleaseText("apps/desktop/src/ctox/deviceControl.ts", source), []);
});

NodeTest.test("allows only exact fixtures and historical docs, never active product source", () => {
  NodeAssert.equal(
    isAllowlistedLegacyReference(
      "scripts/fixtures/workjet-webrtc-only-release/legacy-markers.txt",
      "managed-relay",
    ),
    true,
  );
  NodeAssert.equal(
    isAllowlistedLegacyReference("docs/internals/t3-connect.md", "t3-relay-origin"),
    true,
  );
  NodeAssert.equal(
    isAllowlistedLegacyReference("docs/internals/t3-connect.md", "device-session-http"),
    false,
  );
  NodeAssert.equal(
    isAllowlistedLegacyReference("apps/web/src/t3-connect.md", "t3-relay-origin"),
    false,
  );
  NodeAssert.equal(
    scanLegacyReleaseText("apps/web/src/legacy.ts", "createManagedRelayClient").length,
    1,
  );
});

NodeTest.test(
  "scans active non-mobile roots and supplied build artifacts while ignoring mobile",
  async () => {
    const repoRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-webrtc-only-"));
    const webRoot = NodePath.join(repoRoot, "apps/web/src");
    const mobileRoot = NodePath.join(repoRoot, "apps/mobile/src");
    const artifactRoot = NodePath.join(repoRoot, "release/web");
    const packagedDependencyRoot = NodePath.join(artifactRoot, "node_modules/legacy-runtime");
    await Promise.all([
      NodeFSP.mkdir(webRoot, { recursive: true }),
      NodeFSP.mkdir(mobileRoot, { recursive: true }),
      NodeFSP.mkdir(packagedDependencyRoot, { recursive: true }),
    ]);
    await Promise.all([
      NodeFSP.writeFile(
        NodePath.join(webRoot, "clean.ts"),
        'export const protocol = "ctox.workjet.device.v1";',
      ),
      NodeFSP.writeFile(NodePath.join(mobileRoot, "legacy.ts"), "ManagedRelayClient"),
      NodeFSP.writeFile(
        NodePath.join(artifactRoot, "app.js"),
        'fetch("/api/workjet/device-session")',
      ),
      NodeFSP.writeFile(NodePath.join(packagedDependencyRoot, "index.js"), "useClerk()"),
    ]);

    const result = await checkWorkjetWebRtcOnlyRelease({
      repoRoot,
      artifactPaths: ["release/web"],
    });

    NodeAssert.equal(result.filesScanned, 3);
    NodeAssert.deepEqual(
      result.findings.map(({ path: findingPath, markerId }) => [findingPath, markerId]),
      [
        ["release/web/app.js", "device-session-http"],
        ["release/web/node_modules/legacy-runtime/index.js", "clerk-web-session"],
      ],
    );
    NodeAssert.ok(ACTIVE_PRODUCT_ROOTS.includes("apps/web/src"));
    NodeAssert.ok(!ACTIVE_PRODUCT_ROOTS.some((root) => root.startsWith("apps/mobile")));
  },
);

NodeTest.test("reports a clean scoped tree with no supplied artifacts", async () => {
  const repoRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "workjet-webrtc-only-clean-"),
  );
  const sourceRoot = NodePath.join(repoRoot, "product/src");
  await NodeFSP.mkdir(sourceRoot, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(sourceRoot, "index.js"),
    'export const transport = "rxdb-webrtc";',
  );

  const result = await checkWorkjetWebRtcOnlyRelease({
    repoRoot,
    sourceRoots: ["product/src"],
  });

  NodeAssert.deepEqual(result, { filesScanned: 1, findings: [] });
});
