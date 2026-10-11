import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CtoxWorkjetComputerProjection } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AddComputerInline, type AddComputerInlineProps } from "./AddComputerInline";
import { buildRoleEnrollment, DEFAULT_COMPUTER_ROLES } from "./ComputerCapabilitiesEditor";

const HERE = dirname(fileURLToPath(import.meta.url));

const base: AddComputerInlineProps = {
  open: true,
  onOpenChange: () => undefined,
  segment: "ssh",
  onSegmentChange: () => undefined,
  localAvailable: true,
  desktopAvailable: true,
  sshAliases: [
    { alias: "lan-gpu3", hostname: "192.168.1.30", username: "metricspace", port: 22, source: "ssh-config" },
    { alias: "gpu4", hostname: "100.120.16.93", username: null, port: null, source: "ssh-config" },
  ],
  knownHosts: ["100.87.204.48"],
  sshAliasesLoading: false,
  rolesAvailable: true,
  onAdd: async () => ({ status: "done" }),
};

describe("Rechner hinzufügen (inline)", () => {
  it("is a form on the page, never a dialog, with exactly Local | SSH | Tailscale", () => {
    const markup = renderToStaticMarkup(<AddComputerInline {...base} />);
    expect(markup).toContain('data-slot="inline-panel"');
    expect(markup).not.toContain('role="dialog"');
    const segments = [...markup.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(segments).toEqual(["Local", "SSH", "Tailscale"]);
    expect(markup).not.toContain("Coding computer");
    expect(markup).not.toContain("Build, GPU, or storage computer");
  });

  it("offers saved SSH aliases as clickable choices plus an address field", () => {
    const markup = renderToStaticMarkup(<AddComputerInline {...base} />);
    expect(markup).toContain(">lan-gpu3<");
    expect(markup).toContain(">gpu4<");
    expect(markup).toContain("Adresse");
    expect(markup).toContain('<option value="100.87.204.48">');
  });

  it("has the three role checkboxes and no capability form", () => {
    const markup = renderToStaticMarkup(<AddComputerInline {...base} />);
    for (const role of ["build", "storage", "gpu"]) {
      expect(markup).toContain(`data-computer-role="${role}"`);
    }
    for (const gone of [
      "Concurrent builds",
      "Workers per build",
      "Minimum free disk",
      "Toolchains",
      "VRAM",
      "host-key SHA256",
      "Build and storage directory",
    ]) {
      expect(markup).not.toContain(gone);
    }
  });

  it("disables build and storage for Local and says why only when needed", () => {
    const markup = renderToStaticMarkup(<AddComputerInline {...base} segment="local" />);
    expect(markup).toContain("Dieser Rechner");
    expect(markup).toContain('title="Nur per SSH oder Tailscale"');
  });

  it("shows one status line when no instance is selected", () => {
    const markup = renderToStaticMarkup(
      <AddComputerInline {...base} rolesAvailable={false} rolesStatus="Keine Instanz gewählt" />,
    );
    expect(markup).toContain("Keine Instanz gewählt");
  });

  it("contains none of the removed explanation sentences (Befund 6)", () => {
    const sources = [
      "AddComputerInline.tsx",
      "WorkjetComputersSettings.tsx",
      "ComputerProvisioningSection.tsx",
      "ComputerCapabilitiesEditor.tsx",
      "ConnectionsSettings.tsx",
    ]
      .map((file) => readFileSync(join(HERE, file), "utf8"))
      .join("\n");
    for (const sentence of [
      "Add a computer to the selected Business OS",
      "Install a CTOX backend",
      "never proxied over HTTP",
      "Passwords and SSH passphrases are requested",
      "Use an IP address, hostname, or saved SSH alias",
      "Select a connected Business OS and wait",
      "Choose where you want your coding tasks to run",
      "Advanced setup and repair",
    ]) {
      expect(sources).not.toContain(sentence);
    }
    for (const popup of ["<Dialog", "<AlertDialog", "<Sheet", "<Popover"]) {
      expect(sources).not.toContain(popup);
    }
  });
});

describe("role defaults (erkennen statt fragen)", () => {
  const access = {
    host: "100.120.16.93",
    port: 22,
    username: "metricspace",
    hostKeySha256: "SHA256:abc",
    hostKeyAlgorithm: "ssh-ed25519",
  };

  it("defaults to Build on, Storage off, GPU off", () => {
    expect(DEFAULT_COMPUTER_ROLES).toEqual({ build: true, storage: false, gpu: false });
  });

  it("fills the endpoint from the connection and uses all CPUs for build", () => {
    const enrollment = buildRoleEnrollment({
      computerId: "computer-gpu4",
      displayName: "gpu4",
      roles: { build: true, storage: false, gpu: false },
      agentCapabilities: ["codex-cli"],
      access,
      cpuCount: 24,
    });
    expect(enrollment.capabilityConfig).toHaveLength(1);
    const build = enrollment.capabilityConfig[0];
    expect(build?.kind).toBe("build");
    if (build?.kind === "build") {
      expect(build.jobs).toBe(24);
      expect(build.ssh_endpoint_ref).toBe(enrollment.endpoint?.ref);
    }
    expect(enrollment.endpoint?.connection).toMatchObject({
      protocol: "ssh",
      host: "100.120.16.93",
      port: 22,
      username: "metricspace",
      host_key_sha256: "SHA256:abc",
      host_key_algorithm: "ssh-ed25519",
    });
    expect(enrollment.endpoint?.createNativeKey).toBe(true);
  });

  it("needs no endpoint for a coding-only computer and keeps a saved GPU", () => {
    const native: CtoxWorkjetComputerProjection = {
      id: "computer-gpu3",
      displayName: "gpu3",
      hostingMode: "workstation",
      status: "assigned",
      capabilities: ["gpu"],
      capabilityConfig: [{ kind: "gpu", model: "RTX A4500", vram_gib: 20 }],
      selfHostedColocation: false,
    };
    const enrollment = buildRoleEnrollment({
      computerId: "computer-gpu3",
      displayName: "gpu3",
      roles: { build: false, storage: false, gpu: true },
      agentCapabilities: [],
      access: null,
      native,
    });
    expect(enrollment.endpoint).toBeNull();
    expect(enrollment.capabilityConfig).toEqual([{ kind: "gpu", model: "RTX A4500", vram_gib: 20 }]);
  });

  it("refuses build without SSH access instead of inventing one", () => {
    expect(() =>
      buildRoleEnrollment({
        computerId: "computer-local",
        displayName: "Mac",
        roles: { build: true, storage: false, gpu: false },
        agentCapabilities: [],
        access: null,
      }),
    ).toThrow();
  });
});
