import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CapabilityActivation,
  CapabilityAvailability,
  CapabilityContractError,
  CapabilityIncompatibleVersionError,
  CapabilityManifestV1,
  CapabilityUnknownIdError,
  CapabilityVersion,
} from "./capability.ts";

const decodeManifest = Schema.decodeUnknownSync(CapabilityManifestV1);
const encodeManifest = Schema.encodeSync(CapabilityManifestV1);

const manifest = {
  schemaVersion: 1,
  id: "web-stack-browser",
  version: "2.4.0-beta.1+build.7",
  metadata: {
    displayName: "Web Stack Browser",
    description: "Prepares and automates a browser session.",
  },
  promptContribution: {
    instructions: "Use browser automation only when the task requires it.",
  },
  permissionRequirements: [
    "process.spawn",
    "network.search",
    "network.read",
    "browser.automation",
    "filesystem.read",
  ],
  secretRequirements: [
    {
      reference: "web-stack.session",
      optional: true,
    },
  ],
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["title"],
  },
  supportedAdapters: ["t3-mcp", "t3-prompt", "ctox-business-os-mcp", "ctox-business-command"],
} as const;

describe("CapabilityManifestV1", () => {
  it("round-trips a valid wire manifest", () => {
    const decoded = decodeManifest(manifest);

    expect(encodeManifest(decoded)).toEqual(manifest);
  });

  it.each(["greppy", "web-search", "web-stack-browser"] as const)(
    "accepts the %s capability ID",
    (id) => {
      expect(decodeManifest({ ...manifest, id }).id).toBe(id);
    },
  );

  it.each([
    "1",
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3+",
    "1.2.3 trailing",
  ])("rejects the invalid semantic version %s", (version) => {
    expect(() => Schema.decodeUnknownSync(CapabilityVersion)(version)).toThrow();
  });

  it("rejects unknown adapters", () => {
    expect(() =>
      decodeManifest({
        ...manifest,
        supportedAdapters: ["unknown-adapter"],
      }),
    ).toThrow();
  });

  it("rejects unknown permission requirements", () => {
    expect(() =>
      decodeManifest({
        ...manifest,
        permissionRequirements: ["system.unrestricted"],
      }),
    ).toThrow();
  });

  it("supports an explicitly null prompt contribution", () => {
    const decoded = decodeManifest({
      ...manifest,
      promptContribution: null,
    });

    expect(decoded.promptContribution).toBeNull();
  });

  it("strips secret values from decoded and encoded manifests", () => {
    const sentinel = "must-not-survive";
    const decoded = decodeManifest({
      ...manifest,
      secretRequirements: [
        {
          reference: "web-stack.session",
          optional: false,
          value: sentinel,
        },
      ],
    });

    expect(decoded.secretRequirements[0]).not.toHaveProperty("value");
    expect(JSON.stringify(encodeManifest(decoded))).not.toContain(sentinel);
  });
});

describe("capability availability and activation", () => {
  const availability = {
    capabilityId: "web-search",
    status: "incompatible",
    requestedVersion: "2.0.0",
    installedVersion: "1.5.0",
    reason: "The installed major version is incompatible.",
  } as const;

  it("keeps availability structurally separate from activation", () => {
    const decodedAvailability = Schema.decodeUnknownSync(CapabilityAvailability)({
      ...availability,
      enabled: true,
      actorId: "actor-1",
    });
    const decodedActivation = Schema.decodeUnknownSync(CapabilityActivation)({
      capabilityId: "web-search",
      target: {
        kind: "ctox-instance",
        instanceId: "ctox-1",
      },
      enabled: true,
      actorId: "actor-1",
      changedAt: "2026-08-14T00:00:00.000Z",
      status: "available",
      requestedVersion: "2.0.0",
    });

    expect(decodedAvailability).not.toHaveProperty("enabled");
    expect(decodedAvailability).not.toHaveProperty("actorId");
    expect(decodedActivation).not.toHaveProperty("status");
    expect(decodedActivation).not.toHaveProperty("requestedVersion");
  });

  it.each([
    [
      "thread",
      {
        kind: "thread",
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    ],
    [
      "CTOX instance",
      {
        kind: "ctox-instance",
        instanceId: "ctox-1",
      },
    ],
  ] as const)("round-trips the %s activation target", (_name, target) => {
    const activation = {
      capabilityId: "greppy",
      target,
      enabled: false,
      actorId: "actor-1",
      changedAt: "2026-08-14T00:00:00.000Z",
    } as const;
    const decoded = Schema.decodeUnknownSync(CapabilityActivation)(activation);

    expect(Schema.encodeSync(CapabilityActivation)(decoded)).toEqual(activation);
  });
});

describe("capability contract errors", () => {
  it.each([
    new CapabilityUnknownIdError({ capabilityId: "unknown-capability" }),
    new CapabilityIncompatibleVersionError({
      capabilityId: "web-stack-browser",
      requestedVersion: "2.0.0",
      installedVersion: "1.4.3",
    }),
  ])("round-trips $._tag", (error) => {
    const encoded = Schema.encodeSync(CapabilityContractError)(error);
    const decoded = Schema.decodeUnknownSync(CapabilityContractError)(encoded);

    expect(decoded._tag).toBe(error._tag);
    expect(Schema.encodeSync(CapabilityContractError)(decoded)).toEqual(encoded);
  });
});
