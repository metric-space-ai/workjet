// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  BusinessOsShellChannelPointerV1,
  BusinessOsShellReleaseManifestV2,
  BusinessOsShellUpdateStatus,
} from "./businessOsShell.ts";

const decodeManifest = Schema.decodeUnknownSync(BusinessOsShellReleaseManifestV2);
const baseManifest = {
  type: "ctox.business-os-shell.release.v2",
  version: "1.2.3",
  channel: "stable",
  sourceCommit: "a".repeat(40),
  publishedAt: "2026-08-26T12:00:00Z",
  artifact: {
    url: "https://github.com/metric-space-ai/ctox/release.tar.gz",
    size: 12,
    sha256: "b".repeat(64),
    contentType: "application/gzip",
  },
  compatibility: {
    workjetMinVersion: "0.1.0",
    workjetMaxVersion: null,
    ctoxMinVersion: "0.3.22",
    ctoxMaxVersion: null,
    shellProtocol: "workjet.business-os-shell.v1",
  },
  files: [{ path: "index.html", size: 12, sha256: "c".repeat(64) }],
  provenance: { embeddedManifestSha256: "d".repeat(64), sbomUrl: "https://example.test/sbom" },
  signingKeyId: "shell-current-2026-08",
  signature: "e".repeat(128),
} as const;

describe("Business OS shell contracts", () => {
  it("decodes signed v2 releases and rejects non-HTTPS artifacts", () => {
    expect(decodeManifest(baseManifest).version).toBe("1.2.3");
    expect(() =>
      decodeManifest({
        ...baseManifest,
        artifact: { ...baseManifest.artifact, url: "http://example.test/shell" },
      }),
    ).toThrow();
  });

  it("keeps the channel pointer and update state renderer-safe", () => {
    expect(
      Schema.decodeUnknownSync(BusinessOsShellChannelPointerV1)({
        type: "ctox.business-os-shell.channel.v1",
        channel: "stable",
        version: "1.2.3",
        manifestUrl: "https://example.test/release.json",
        manifestSha256: "f".repeat(64),
        publishedAt: "2026-08-26T12:00:00Z",
        signingKeyId: "shell-current-2026-08",
        signature: "a".repeat(128),
      }).channel,
    ).toBe("stable");
    expect(
      Schema.decodeUnknownSync(BusinessOsShellUpdateStatus)({
        activeVersion: "1.2.3",
        desiredVersion: null,
        latestCompatibleVersion: "1.2.3",
        channel: "stable",
        phase: "current",
        health: "healthy",
        administrable: true,
        recoveryShell: false,
        lastCheckedAt: "2026-08-26T12:00:00Z",
        lastActivatedAt: "2026-08-26T12:00:00Z",
        errorCode: null,
        pause: null,
      }).phase,
    ).toBe("current");
  });
});
