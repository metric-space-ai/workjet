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
