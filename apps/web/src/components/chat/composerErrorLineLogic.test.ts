import { describe, expect, it } from "vite-plus/test";
import type { WorkjetWorkerProfile } from "@workjet/contracts";
import {
  COMPOSER_UNREACHABLE_NOTICE_MS,
  classifyComposerError,
  composerErrorLine,
  isComposerPlainLine,
} from "./composerErrorLineLogic";
import { supervisorPresetChoices } from "./NativeSupervisorRouteControls";

const words = (text: string) => text.trim().split(/\s+/).length;

describe("composerErrorLine: Fehler → Zeile", () => {
  it.each([
    "Failed to connect. Reconnecting... Reason: HTTP 401 Unauthorized",
    "Request failed with status 401",
    "CtoxMcpTransportError: authentication-required",
    "Sign in to ctox.dev to reconnect this project's instance.",
    "Bei ctox.dev anmelden, um die Instanz zu verbinden.",
    "OAuth session expired",
  ])("401/abgelaufener Zugang %#: Anmeldung der Instanz abgelaufen · Neu verbinden", (raw) => {
    const line = composerErrorLine(raw, { fallback: "Preset nicht übernommen" });
    expect(line).toEqual({
      kind: "authentication",
      text: "Anmeldung der Instanz abgelaufen",
      action: "reconnect",
      actionLabel: "Neu verbinden",
      details: raw,
    });
  });

  it.each([
    "Failed to connect. Reconnecting... Reason: Relay request failed (503)",
    "HTTP 503 Service Unavailable",
    "502 Bad Gateway",
    "fetch failed: ECONNREFUSED 127.0.0.1:443",
    "Request timed out",
    "CtoxMcpTransportError: connection-unavailable",
    "Instanz nicht erreichbar",
    "Die Instanz hat nicht rechtzeitig geantwortet.",
    "Preset-Verbindung nicht verfügbar",
    "Projektverbindung nicht verfügbar",
  ])("503/nicht erreichbar %#: still, erst nach 2 min eine Zeile", (raw) => {
    expect(classifyComposerError(raw)).toBe("unreachable");
    expect(composerErrorLine(raw, { fallback: "x" })).toBeNull();
    expect(composerErrorLine(raw, { fallback: "x", unreachableForMs: 15_000 })).toBeNull();
    expect(
      composerErrorLine(raw, {
        fallback: "x",
        unreachableForMs: COMPOSER_UNREACHABLE_NOTICE_MS - 1,
      }),
    ).toBeNull();
    const line = composerErrorLine(raw, {
      fallback: "x",
      unreachableForMs: COMPOSER_UNREACHABLE_NOTICE_MS,
    });
    expect(line?.kind).toBe("unreachable");
    expect(line?.text).toBe("Instanz nicht erreichbar");
    expect(line?.action).toBe("retry");
    expect(line?.actionLabel).toBe("Erneut versuchen");
    expect(line?.details).toBe(raw === "Instanz nicht erreichbar" ? null : raw);
  });

  it("englischer Rohtext wird zur deutschen Ersatzzeile, Rohtext nur hinter Details", () => {
    const raw = "The instance configuration changed. Choose again.";
    expect(composerErrorLine(new Error(raw), { fallback: "Preset nicht übernommen" })).toEqual({
      kind: "failed",
      text: "Preset nicht übernommen",
      action: "retry",
      actionLabel: "Erneut versuchen",
      details: raw,
    });
  });

  it("Status-Codes, Fehlerklassen und JSON gelten als Rohtext", () => {
    expect(isComposerPlainLine("Preset fehlgeschlagen 418")).toBe(false);
    expect(isComposerPlainLine("TypeError: x is undefined")).toBe(false);
    expect(isComposerPlainLine('{"code":"guest_failed"}')).toBe(false);
  });

  it("eine eigene deutsche Kurzzeile bleibt stehen, ohne Details", () => {
    const line = composerErrorLine("Mehrere Preset-Verbindungen passen zur Instanz", {
      fallback: "Presets nicht verbunden",
    });
    expect(line?.text).toBe("Mehrere Preset-Verbindungen passen zur Instanz");
    expect(line?.details).toBeNull();
  });

  it("ein deutscher Absatz über 12 Wörter wird gekürzt auf die Ersatzzeile", () => {
    const raw =
      "Die Instanz unterstützt diese Aktion noch nicht und muss erst auf eine neuere Version gebracht werden.";
    const line = composerErrorLine(raw, { fallback: "Aktion nicht unterstützt" });
    expect(line?.text).toBe("Aktion nicht unterstützt");
    expect(line?.details).toBe(raw);
  });

  it("jede sichtbare Zeile hält ≤ 12 Wörter und genau eine Aktion", () => {
    for (const raw of [
      "HTTP 401",
      "HTTP 503",
      "Something completely unexpected happened in the adapter layer of the system",
    ]) {
      const line = composerErrorLine(raw, {
        fallback: "Preset nicht übernommen",
        unreachableForMs: Number.POSITIVE_INFINITY,
      });
      expect(line).not.toBeNull();
      expect(words(line!.text)).toBeLessThanOrEqual(12);
      expect(line!.text).not.toMatch(/\d{3}|failed|error/i);
      expect(["Neu verbinden", "Erneut versuchen"]).toContain(line!.actionLabel);
    }
  });

  it("kein Fehler, keine Zeile", () => {
    expect(composerErrorLine(null, { fallback: "x" })).toBeNull();
    expect(composerErrorLine("   ", { fallback: "x" })).toBeNull();
  });
});

describe("supervisorPresetChoices: zuletzt bekannte Presets", () => {
  const profile = (id: string) => ({ id }) as unknown as WorkjetWorkerProfile;

  it("behält die zuletzt gelesenen Presets, wenn das Neuladen scheitert", () => {
    const lastKnown = new Map<string, readonly WorkjetWorkerProfile[]>();
    const live = [profile("a"), profile("b")];
    expect(
      supervisorPresetChoices({ instanceId: "managed:x", live, cached: [], lastKnown }),
    ).toEqual(live);
    expect(
      supervisorPresetChoices({ instanceId: "managed:x", live: null, cached: [], lastKnown }),
    ).toEqual(live);
  });

  it("ist nur leer, wenn eine Antwort nachweislich keine Presets enthielt", () => {
    const lastKnown = new Map<string, readonly WorkjetWorkerProfile[]>();
    supervisorPresetChoices({
      instanceId: "managed:x",
      live: [profile("a")],
      cached: [],
      lastKnown,
    });
    expect(
      supervisorPresetChoices({ instanceId: "managed:x", live: [], cached: [], lastKnown }),
    ).toEqual([]);
    expect(
      supervisorPresetChoices({ instanceId: "managed:x", live: null, cached: [], lastKnown }),
    ).toEqual([]);
  });

  it("mischt keine Instanzen", () => {
    const lastKnown = new Map<string, readonly WorkjetWorkerProfile[]>();
    supervisorPresetChoices({
      instanceId: "managed:x",
      live: [profile("a")],
      cached: [],
      lastKnown,
    });
    expect(
      supervisorPresetChoices({ instanceId: "managed:y", live: null, cached: [], lastKnown }),
    ).toEqual([]);
  });

  it("der dauerhafte Cache gewinnt vor dem Gedächtnis dieser Sitzung", () => {
    const lastKnown = new Map<string, readonly WorkjetWorkerProfile[]>([
      ["managed:x", [profile("old")]],
    ]);
    const cached = [profile("cached")];
    expect(
      supervisorPresetChoices({ instanceId: "managed:x", live: null, cached, lastKnown }),
    ).toEqual(cached);
  });
});
