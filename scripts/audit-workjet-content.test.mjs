import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORBIDDEN_TERMS,
  PRODUCT_TERMS,
  TECHNICAL_CONTEXT_ALLOWLIST,
  auditSourceText,
  auditWorkjetContent,
  isAllowlistedContext,
} from "./audit-workjet-content.mjs";

test("the current Workjet product surfaces pass the vocabulary guard", async () => {
  const result = await auditWorkjetContent(process.cwd());

  assert.deepEqual(result.findings, []);
  assert.ok(result.filesAudited > 0);
  assert.deepEqual(result.forbiddenTerms, FORBIDDEN_TERMS);
  assert.deepEqual(result.productTerms, PRODUCT_TERMS);
});

test("visible JSX, labels, and ARIA copy are rejected outside diagnostics", () => {
  const findings = auditSourceText(
    `<section aria-label="WebRTC"><span>Native</span><button title="Room" aria-valuetext="Binary">Guest</button></section>`,
    "apps/web/src/components/Example.tsx",
  );

  assert.deepEqual(
    findings.map(({ term, kind }) => [term, kind]),
    [
      ["WebRTC", "user-facing-literal"],
      ["Room", "user-facing-literal"],
      ["Binary", "user-facing-literal"],
      ["Native", "jsx-text"],
      ["Guest", "jsx-text"],
    ],
  );
});

test("an explicit diagnostics context is allowed, but the same label elsewhere is not", () => {
  const diagnostics = auditSourceText(
    `<SourceStatusBadge label="Native" /><HealthSource label="Native process monitor" /><DetailRow label="Sidecar" />`,
    "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx",
  );
  const otherSurface = auditSourceText(
    `<SourceStatusBadge label="Native" />`,
    "apps/web/src/components/settings/WorkjetSettings.tsx",
  );

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    otherSurface.map(({ term }) => term),
    ["Native"],
  );
});

test("technical literals require the exact path and context allowlist", () => {
  const allowed = auditSourceText(
    `const descriptor = { healthSummary: { dataPlane: "rxdb-webrtc" } };`,
    "apps/desktop/src/ctox/CtoxManagedDiscovery.ts",
  );
  const wrongPath = auditSourceText(
    `const descriptor = { healthSummary: { dataPlane: "rxdb-webrtc" } };`,
    "apps/desktop/src/ctox/CtoxManagedLaunch.ts",
  );
  const wrongContext = auditSourceText(
    `const label = "rxdb-webrtc";`,
    "apps/desktop/src/ctox/CtoxManagedDiscovery.ts",
  );

  assert.deepEqual(allowed, []);
  assert.deepEqual(
    wrongPath.map(({ term }) => term),
    ["RxDB", "WebRTC"],
  );
  assert.deepEqual(
    wrongContext.map(({ term }) => term),
    ["RxDB", "WebRTC"],
  );
});

test("code symbols and persisted operation reasons are scoped exceptions", () => {
  const guestSymbol = auditSourceText(
    `const preload = "/ctox-guest-preload.cjs";`,
    "apps/desktop/src/ctox/CtoxGuestManager.ts",
  );
  const wrongGuestPath = auditSourceText(
    `const preload = "/ctox-guest-preload.cjs";`,
    "apps/web/src/components/Example.tsx",
  );
  const operationReason = auditSourceText(
    `const operationState = "binary-unavailable";`,
    "apps/web/src/components/settings/WorkjetSettings.tsx",
  );
  const visibleReason = auditSourceText(
    `<p>binary-unavailable</p>`,
    "apps/web/src/components/settings/WorkjetSettings.tsx",
  );

  assert.deepEqual(guestSymbol, []);
  assert.deepEqual(
    wrongGuestPath.map(({ term }) => term),
    ["Guest"],
  );
  assert.deepEqual(operationReason, []);
  assert.deepEqual(
    visibleReason.map(({ term }) => term),
    ["Binary"],
  );
});

test("product vocabulary remains unrestricted while metadata copy is audited", () => {
  const productCopy = auditSourceText(
    `<h1>Workjet</h1><p>Business OS · CTOX Backend · Backend</p>`,
    "apps/web/src/components/Example.tsx",
  );
  const metadataCopy = auditSourceText(
    JSON.stringify({ productName: "Workjet", description: "Powered by WebRTC" }),
    "apps/desktop/package.json",
    { metadata: true },
  );

  assert.deepEqual(productCopy, []);
  assert.deepEqual(
    metadataCopy.map(({ term, kind }) => [term, kind]),
    [["WebRTC", "metadata"]],
  );
});

test("the allowlist is path-scoped and carries a reason for every exception", () => {
  assert.ok(TECHNICAL_CONTEXT_ALLOWLIST.length >= 20);
  for (const entry of TECHNICAL_CONTEXT_ALLOWLIST) {
    assert.match(entry.path, /^(apps\/web|apps\/desktop)\//);
    assert.ok(entry.context instanceof RegExp);
    assert.ok(entry.reason.length > 0);
    assert.equal(entry.context.global, false);
  }
  assert.equal(
    TECHNICAL_CONTEXT_ALLOWLIST.find(
      ({ path }) => path === "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx",
    )?.allowUserFacing,
    true,
  );
  assert.ok(
    TECHNICAL_CONTEXT_ALLOWLIST.filter(
      ({ path }) => path !== "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx",
    ).every(({ allowUserFacing }) => allowUserFacing !== true),
  );
});

test("legacy links and bundle identity are scoped metadata contexts", () => {
  assert.equal(
    isAllowlistedContext("apps/desktop/src/electron/desktopSchemes.ts", "ctox-desktop-dev"),
    true,
  );
  assert.equal(
    isAllowlistedContext(
      "apps/desktop/.electron-runtime/metadata.json",
      "appBundleId=com.t3tools.t3code.dev.workjet",
    ),
    true,
  );
  assert.equal(
    isAllowlistedContext("apps/web/src/components/Example.tsx", "ctox-desktop-dev"),
    false,
  );
  assert.equal(
    isAllowlistedContext("apps/desktop/.electron-runtime/metadata.json", "ctox-desktop-dev", {
      userFacing: true,
    }),
    false,
  );
});
