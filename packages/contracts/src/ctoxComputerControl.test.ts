import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CtoxWorkjetComputerControlInput, CtoxWorkjetComputerControlResponse } from "./ctox.ts";

const decodeInput = Schema.decodeUnknownSync(CtoxWorkjetComputerControlInput, {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetComputerControlResponse, {
  onExcessProperty: "error",
});
const assign = {
  instanceId: "managed:welsch",
  request: {
    action: "computer.assign",
    commandId: "command-1",
    computerId: "computer-1",
    displayName: "GPU",
    hostingMode: "workstation",
    capabilities: [],
    selfHostedColocation: false,
  },
};
const computer = {
  id: "computer-1",
  displayName: "GPU",
  hostingMode: "workstation",
  status: "assigned",
  capabilities: [],
  selfHostedColocation: false,
};

describe("CTOX computer control boundary", () => {
  it("accepts opaque identities and rejects transport endpoints, unknown authority flags and co-location shortcuts", () => {
    expect(decodeInput(assign)).toEqual(assign);
    for (const fields of [
      { environmentId: "ssh-env" },
      { endpoint: "http://localhost" },
      { serverAttested: true },
      { hostingMode: "managed_backend" },
      { selfHostedColocation: true },
    ]) {
      expect(() => decodeInput({ ...assign, request: { ...assign.request, ...fields } })).toThrow();
    }
  });
  it("bounds command text, capability counts and result sizes", () => {
    expect(() =>
      decodeInput({ ...assign, request: { ...assign.request, computerId: "x".repeat(161) } }),
    ).toThrow();
    expect(() =>
      decodeInput({
        ...assign,
        request: { ...assign.request, capabilities: Array(33).fill("coding") },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({ ...assign, request: { ...assign.request, displayName: "bad\u0000name" } }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        action: "computer.list",
        computers: Array.from({ length: 101 }, (_, i) => ({ ...computer, id: `computer-${i}` })),
      }),
    ).toThrow();
  });
  it("rejects duplicate ids and unassigned records in an assigned inventory", () => {
    expect(() =>
      decodeResponse({ action: "computer.list", computers: [computer, computer] }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        action: "computer.list",
        computers: [{ ...computer, status: "unassigned" }],
      }),
    ).toThrow();
    expect(
      decodeResponse({
        action: "computer.unassign",
        computer: { ...computer, status: "unassigned" },
      }),
    ).toMatchObject({ action: "computer.unassign" });
  });
});

describe("operational computer grants", () => {
  const storage = {
    kind: "storage",
    endpoint_ref: "endpoint-nas",
    protocol: "ssh",
    root: "/volume1/artifacts",
    quota_gib: null,
    purposes: ["artifacts"],
  };
  const endpoint = {
    action: "computer.endpoint.upsert",
    commandId: "endpoint-command",
    computerId: "nas-1",
    endpointRef: "endpoint-nas",
    connection: {
      protocol: "ssh",
      host: "nas.example.test",
      port: 22,
      username: "admin",
      root: "/volume1/artifacts",
      host_key_sha256: "SHA256:example-pin",
      private_key: { scope: "computer-access", name: "nas-key" },
      passphrase: null,
    },
  };
  it("accepts a typed agentless NAS and bounded build/GPU grants", () => {
    expect(
      decodeInput({
        ...assign,
        request: { ...assign.request, agentless: true, capabilityConfig: [storage] },
      }).request.action,
    ).toBe("computer.assign");
    expect(
      decodeInput({
        ...assign,
        request: {
          ...assign.request,
          capabilityConfig: [
            {
              kind: "build",
              ssh_endpoint_ref: "endpoint-build",
              slots: 3,
              jobs: 6,
              lane_root: "/srv/build-lane",
              disk_floor_gib: 60,
              toolchains: ["rust-stable"],
            },
            { kind: "gpu", model: "Test GPU", vram_gib: 20 },
          ],
        },
      }).request.action,
    ).toBe("computer.assign");
    for (const capabilityConfig of [
      [storage, storage],
      [{ ...storage, quota_gib: 0 }],
      [{ ...storage, purposes: [] }],
      [{ kind: "gpu", model: "Test GPU", vram_gib: -1 }],
    ]) {
      expect(() =>
        decodeInput({ ...assign, request: { ...assign.request, capabilityConfig } }),
      ).toThrow();
    }
  });
  it("accepts endpoint references and rejects inline credential values or ownership injection", () => {
    expect(decodeInput({ instanceId: assign.instanceId, request: endpoint }).request.action).toBe(
      "computer.endpoint.upsert",
    );
    for (const request of [
      { ...endpoint, ownerUserId: "foreign" },
      { ...endpoint, connection: { ...endpoint.connection, private_key: "private-key-bytes" } },
      {
        ...endpoint,
        connection: {
          ...endpoint.connection,
          private_key: {
            scope: "computer-access",
            name: "nas-key",
            value: "secret",
          },
        },
      },
      { ...endpoint, connection: { ...endpoint.connection, password: "secret" } },
    ])
      expect(() => decodeInput({ instanceId: assign.instanceId, request })).toThrow();
    expect(
      decodeResponse({
        action: "computer.endpoint.disable",
        endpointRef: "endpoint-nas",
        computerId: "nas-1",
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
  });
});
