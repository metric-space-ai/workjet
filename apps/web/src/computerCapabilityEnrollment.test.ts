import { CommandId, type CtoxWorkjetComputerControlResult } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  enrollOperationalComputer,
  type OperationalComputerEnrollment,
} from "./computerCapabilityEnrollment";

const nas: OperationalComputerEnrollment = {
  computerId: "nas-1",
  displayName: "NAS",
  hostingMode: "self_hosted",
  agentless: true,
  agentCapabilities: [],
  capabilityConfig: [
    {
      kind: "storage",
      endpoint_ref: "endpoint-nas",
      protocol: "ssh",
      root: "/volume1/artifacts",
      quota_gib: null,
      purposes: ["artifacts"],
    },
  ],
  endpoint: {
    ref: "endpoint-nas",
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
  },
};
const assigned = {
  _tag: "completed",
  response: {
    action: "computer.assign",
    computer: {
      id: "nas-1",
      displayName: "NAS",
      hostingMode: "self_hosted",
      status: "assigned",
      capabilities: ["storage"],
      selfHostedColocation: false,
    },
  },
} satisfies CtoxWorkjetComputerControlResult;
const endpoint = {
  _tag: "completed",
  response: {
    action: "computer.endpoint.upsert",
    computerId: "nas-1",
    endpointRef: "endpoint-nas",
    enabled: true,
  },
} satisfies CtoxWorkjetComputerControlResult;
const command = () => CommandId.make("test-command");

describe("operational computer enrollment", () => {
  it("preserves existing operational grants when saving a coding computer without replacement", async () => {
    const control = vi.fn().mockResolvedValue({
      ...assigned,
      response: {
        ...assigned.response,
        computer: { ...assigned.response.computer, hostingMode: "workstation" },
      },
    });
    await enrollOperationalComputer(
      {
        ...nas,
        agentless: false,
        hostingMode: "workstation",
        capabilityConfig: [],
        endpoint: null,
        preserveOperationalCapabilities: true,
      },
      control,
      command,
      () => true,
    );
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]?.[0]).not.toHaveProperty("capabilityConfig");
  });
  it("enrolls an agentless NAS through both native operations with credential references only", async () => {
    const control = vi.fn().mockResolvedValueOnce(assigned).mockResolvedValueOnce(endpoint);
    await expect(
      enrollOperationalComputer(nas, control, command, () => true),
    ).resolves.toMatchObject({ id: "nas-1", capabilities: ["storage"] });
    expect(control).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "computer.assign",
        agentless: true,
        capabilityConfig: nas.capabilityConfig,
        capabilities: [],
      }),
    );
    expect(control).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "computer.endpoint.upsert",
        connection: nas.endpoint?.connection,
      }),
    );
  });
  it("does not configure an endpoint after a failed or mismatched assignment", async () => {
    for (const response of [
      { _tag: "failed", code: "command_failed" },
      {
        _tag: "completed",
        response: {
          ...assigned.response,
          computer: { ...assigned.response.computer, id: "other-computer" },
        },
      },
    ]) {
      const control = vi.fn().mockResolvedValue(response);
      await expect(enrollOperationalComputer(nas, control, command, () => true)).rejects.toThrow();
      expect(control).toHaveBeenCalledTimes(1);
    }
  });
  it("cannot finish after an unconfirmed endpoint even though the computer was registered", async () => {
    const control = vi
      .fn()
      .mockResolvedValueOnce(assigned)
      .mockResolvedValueOnce({ _tag: "failed", code: "command_failed" });
    await expect(enrollOperationalComputer(nas, control, command, () => true)).rejects.toThrow(
      "access endpoint still needs confirmation",
    );
  });
  it("stops the second operation if the selected instance changed during assignment", async () => {
    let current = true;
    const control = vi.fn().mockImplementation(async () => {
      current = false;
      return assigned;
    });
    await expect(enrollOperationalComputer(nas, control, command, () => current)).rejects.toThrow(
      "selected Business OS changed",
    );
    expect(control).toHaveBeenCalledTimes(1);
  });
  it("rejects agentless build and mismatched endpoint declarations before any command", async () => {
    const control = vi.fn();
    for (const enrollment of [
      { ...nas, agentCapabilities: ["codex"] },
      { ...nas, endpoint: null },
      { ...nas, hostingMode: "workstation" as const },
      { ...nas, capabilityConfig: [{ kind: "gpu" as const, model: "GPU", vram_gib: 20 }] },
    ])
      await expect(
        enrollOperationalComputer(enrollment, control, command, () => true),
      ).rejects.toThrow();
    expect(control).not.toHaveBeenCalled();
  });
});
