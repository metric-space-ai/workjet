import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConfiguration,
  type WorkjetComputer,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  defaultComputerMetadata,
  reconcileComputer,
  computerJobAllowed,
} from "./computerRegistry.ts";
const row = (id: string, environment: string, fingerprint: string): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label: id,
  environmentId: EnvironmentId.make(environment),
  presentationKind: "ssh",
  harnesses: [],
  metadata: {
    ...defaultComputerMetadata({
      _tag: "ssh",
      target: { alias: id, hostname: id, username: null, port: null },
    }),
    hostKeyFingerprint: fingerprint,
  },
});
describe("computer identity and admission", () => {
  it("merges Business OS and SSH rows by fingerprint without losing data", () => {
    const native = row("gpu3", "native-env", "SHA256:same");
    const ssh = row("gpu3-a4500", "ssh-env", "SHA256:same");
    const config = Schema.decodeUnknownSync(WorkjetConfiguration)({
      computers: [native, ssh],
      selectedComputerId: ssh.id,
    });
    const merged = reconcileComputer(config, ssh);
    expect(merged.computers).toHaveLength(1);
    expect(merged.computers[0]?.id).toBe("gpu3-a4500");
    expect(merged.computers[0]?.metadata?.legacyRecords).toContainEqual(native);
    expect(merged.selectedComputerId).toBe("gpu3-a4500");
  });
  it("does not conflate equal names or different physical identities", () => {
    const a = row("first", "env-a", "SHA256:a"),
      b = row("second", "env-b", "SHA256:b");
    const config = Schema.decodeUnknownSync(WorkjetConfiguration)({ computers: [a] });
    expect(reconcileComputer(config, b).computers).toHaveLength(2);
  });
  it("refuses every new job on an inactive computer and preserves that state while merging", () => {
    const inactive = row("inactive", "env-a", "SHA256:a");
    const disabled = { ...inactive, metadata: { ...inactive.metadata!, active: false } };
    const config = Schema.decodeUnknownSync(WorkjetConfiguration)({ computers: [disabled] });
    const merged = reconcileComputer(config, row("alias", "env-b", "SHA256:a")).computers[0]!;
    for (const job of ["worker", "build", "storage"] as const)
      expect(computerJobAllowed(merged, job)).toBe(false);
    expect(computerJobAllowed(row("active", "env-c", "SHA256:c"), "build")).toBe(true);
    expect(computerJobAllowed(row("active", "env-c", "SHA256:c"), "storage")).toBe(false);
  });
});

it("preserves separate computers with cloned SSH keys but conflicting machine IDs", () => {
  const facts = (machine: string) => ({
    checkedAt: "now",
    machineId: machine,
    operatingSystem: "Linux",
    architecture: "x86_64",
    cpuCores: 8,
    ramBytes: 1,
    homeDirectory: "/home/test",
    workDirectory: "/home/test/.workjet/computer-work",
    freeBytes: 1,
    gpus: [],
    toolchains: {},
    codingTools: {},
    warnings: [],
  });
  const first = row("first", "env-a", "SHA256:cloned");
  const second = row("second", "env-b", "SHA256:cloned");
  const a = { ...first, metadata: { ...first.metadata!, facts: facts("machine-a") } };
  const b = { ...second, metadata: { ...second.metadata!, facts: facts("machine-b") } };
  expect(
    reconcileComputer(Schema.decodeUnknownSync(WorkjetConfiguration)({ computers: [a] }), b)
      .computers,
  ).toHaveLength(2);
});
it("merges different aliases by machine ID even when the host key changed", () => {
  const first = row("first", "env-a", "SHA256:first");
  const second = row("second", "env-b", "SHA256:second");
  const facts = {
    checkedAt: "now",
    machineId: "same-machine",
    operatingSystem: "Linux",
    architecture: "x86_64",
    cpuCores: 8,
    ramBytes: 1,
    homeDirectory: "/home/test",
    workDirectory: "/home/test/.workjet/computer-work",
    freeBytes: 1,
    gpus: [],
    toolchains: {},
    codingTools: {},
    warnings: [],
  };
  const a = { ...first, metadata: { ...first.metadata!, facts } };
  const b = { ...second, metadata: { ...second.metadata!, facts } };
  expect(
    reconcileComputer(Schema.decodeUnknownSync(WorkjetConfiguration)({ computers: [a] }), b)
      .computers,
  ).toHaveLength(1);
});
