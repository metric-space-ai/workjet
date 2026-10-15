import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { provisioningMessageDe } from "../../workjetProvisioningMessages";
import { ComputerProvisioningSection, preflightOutcome } from "./ComputerProvisioningSection";

afterEach(() => vi.unstubAllGlobals());

const preflight = {
  preflightId: "preflight-1",
  expiresAt: "2026-10-11T20:00:00.000Z",
  target: {
    _tag: "ssh" as const,
    ssh: { alias: "100.120.16.93", hostname: "100.120.16.93", username: "metricspace", port: 22 },
  },
  platform: "linux" as const,
  architecture: "x64" as const,
  internetAvailable: true,
  administratorCapable: true,
  administratorPasswordRequired: false,
  administratorElevationRequired: false,
  graphicalSession: false,
  ctoxInstalledVersion: null,
  workjetInstalledVersion: null,
  warnings: [],
};

describe("ComputerProvisioningSection", () => {
  it("stays absent in web-only clients", () => {
    vi.stubGlobal("window", { desktopBridge: undefined });
    expect(renderToStaticMarkup(<ComputerProvisioningSection />)).toBe("");
  });

  it("is one compact inline block without captions or settings sections", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        inspectProvisioningHostKey: vi.fn(),
        preflightProvisioningTarget: vi.fn(),
        startProvisioningOperation: vi.fn(),
        getProvisioningOperation: vi.fn(),
      },
    });
    const markup = renderToStaticMarkup(
      <ComputerProvisioningSection
        initialKind="ssh"
        fixedTargetKind
        initialTarget={{ host: "100.120.16.93", username: "metricspace", port: 22 }}
      />,
    );
    // D13: bekanntes Ziel nur lesend, keine erneute Abfrage.
    expect(markup).toContain("metricspace@100.120.16.93");
    expect(markup).not.toContain("<input");
    expect(markup).toContain("Prüfen");
    expect(markup).not.toContain("Provision CTOX and Workjet");
    expect(markup).not.toContain("Install on a computer");
    expect(markup).not.toContain("checksum-verified");
    expect(markup).not.toContain("never proxied over HTTP");
    expect(markup).not.toContain("Passwords and SSH passphrases");
    expect(markup).not.toContain("<section");
  });
});

describe("provisioningMessageDe (D02)", () => {
  it("maps English desktop messages to short German lines and keeps the raw text for Details", () => {
    expect(provisioningMessageDe("Operation queued")).toEqual({
      text: "In der Warteschlange",
      raw: "Operation queued",
    });
    expect(
      provisioningMessageDe("The target cannot reach the official CTOX release channel.").text,
    ).toBe("Rechner erreicht den CTOX-Release-Kanal nicht");
    const unknown = provisioningMessageDe("spawn ENOENT /usr/bin/ssh");
    expect(unknown.text).toBe("Einrichtung fehlgeschlagen");
    expect(unknown.raw).toBe("spawn ENOENT /usr/bin/ssh");
    expect(provisioningMessageDe("Prüfung fehlgeschlagen.")).toEqual({
      text: "Prüfung fehlgeschlagen.",
      raw: null,
    });
  });
});

describe("preflight result (Befund 3: never jump back silently)", () => {
  it("advances to the components step on success", () => {
    const outcome = preflightOutcome({ _tag: "ready", preflight });
    expect(outcome.next).toBe("components");
  });

  it("keeps a non-host-key failure as an error line instead of the fingerprint step", () => {
    for (const code of [
      "preflight_failed",
      "authentication_failed",
      "internet_unavailable",
      "required_tool_unavailable",
    ] as const) {
      const outcome = preflightOutcome({ _tag: "failed", code, message: "kaputt" });
      expect(outcome).toEqual({ next: "error", message: "kaputt" });
    }
  });

  it("returns to the fingerprint only for host-key codes, and always with a message", () => {
    for (const code of ["host_key_confirmation_required", "host_key_changed"] as const) {
      const outcome = preflightOutcome({ _tag: "failed", code, message: "" });
      expect(outcome.next).toBe("fingerprint");
      expect(outcome).toHaveProperty("message", "Prüfung fehlgeschlagen.");
    }
  });
});
