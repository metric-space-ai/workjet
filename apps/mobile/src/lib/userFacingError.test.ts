import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  userFacingError,
  userFacingErrorOfKind,
  userFacingErrorText,
  type UserFacingErrorKind,
} from "./userFacingError";

const SRC_ROOT = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const ALL_KINDS: ReadonlyArray<UserFacingErrorKind> = [
  "pairing",
  "auth",
  "unreachable",
  "package",
  "permission",
  "storage",
  "task-required",
  "branch-required",
  "name-required",
  "path-required",
  "unexpected",
];

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("userFacingError", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("keeps every fixed line German, short and paired with exactly one action", () => {
    for (const kind of ALL_KINDS) {
      const mapped = userFacingErrorOfKind(kind);
      expect(mapped.line.split(/\s+/u).length).toBeLessThanOrEqual(12);
      expect(mapped.action.length).toBeGreaterThan(0);
      expect(mapped.action).not.toContain("·");
      expect(mapped.text).toBe(`${mapped.line} · ${mapped.action}`);
      expect(mapped.text.split("·")).toHaveLength(2);
    }
  });

  it("maps the owner's reference cases", () => {
    expect(userFacingErrorText(new Error("pairing payload is invalid"))).toBe(
      "Kopplungscode ungültig · Neu scannen",
    );
    expect(userFacingErrorText(new Error("fetch failed: ECONNREFUSED"))).toBe(
      "Instanz nicht erreichbar · Erneut",
    );
    expect(userFacingErrorText(new Error("HTTP 401 Unauthorized"))).toBe(
      "Anmeldung abgelaufen · Neu verbinden",
    );
    expect(userFacingErrorText(new Error("Something odd happened."))).toBe(
      "Unerwarteter Fehler · Erneut",
    );
    expect(userFacingErrorText(undefined)).toBe("Unerwarteter Fehler · Erneut");
  });

  it("classifies the named internal errors before their English text", () => {
    expect(
      userFacingError(namedError("WorkjetDeviceInviteValidationError", "invite is malformed")).kind,
    ).toBe("pairing");
    expect(
      userFacingError(namedError("BusinessOsShellPackError", "Shell pack signature is invalid."))
        .kind,
    ).toBe("package");
    expect(
      userFacingError(
        namedError("WorkjetDeviceInviteControlUnavailableError", "control port missing"),
      ).kind,
    ).toBe("unreachable");
    expect(userFacingError({ _tag: "CloudDpopError", message: "nonce rejected" }).kind).toBe(
      "auth",
    );
    expect(userFacingError({ _tag: "ProjectThreadTaskRequiredError" }).kind).toBe("task-required");
    expect(userFacingErrorText("Enter a project path.")).toBe("Projektpfad fehlt · Pfad eingeben");
  });

  it("follows the cause chain when the outer error is generic", () => {
    const outer = new Error("Command failed", {
      cause: namedError("BusinessOsInviteValidationError", "bad invite"),
    });
    expect(userFacingError(outer).kind).toBe("pairing");
  });

  it("never returns the raw text and logs it to the diagnostic log instead", () => {
    const raw = "Shell pack signature is invalid.";
    const mapped = userFacingError(new Error(raw), "test-scope");
    expect(mapped.text).not.toContain(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("[user-facing-error] test-scope");
  });

  it("is idempotent for lines that already crossed the boundary", () => {
    for (const kind of ALL_KINDS) {
      const text = userFacingErrorOfKind(kind).text;
      expect(userFacingErrorText(text)).toBe(text);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

// Static guard: raw error text must not reach the UI. Every place that turns
// an error into visible text goes through `userFacingError`. The listed files
// build or classify internal errors and never render; they stay English on
// purpose and are covered by their own tests.
const INTERNAL_ERROR_FILES: ReadonlyMap<string, string> = new Map([
  ["lib/userFacingError.ts", "the boundary itself reads the raw text to classify it"],
  ["lib/openExternalUrl.ts", "logs the error, renders nothing"],
  ["connection/catalog-store.ts", "builds internal persistence errors"],
  ["connection/migration.ts", "builds internal migration errors"],
  ["connection/environment-cache-store.ts", "builds internal cache errors"],
  ["connection/storage.ts", "builds internal storage errors"],
  ["connection/platform.ts", "builds internal platform errors"],
  ["features/agent-awareness/remoteRegistration.ts", "diagnostic log only"],
  ["features/cloud/linkEnvironment.ts", "builds internal cloud link errors"],
  ["features/diffs/nativeReviewDiffSurface.ts", "classifies native view registration"],
  ["state/thread-outbox-model.ts", "classifies transport errors for retry"],
]);

const RAW_ERROR_TEXT =
  /\b(?:error|err|e|cause|cancelError|validationError|failure|reason)\??\.message\b|String\(\s*(?:error|err|e|cause|reason|failure)\s*\)/u;

function productionSources(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const next = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(next);
    if (!/\.(?:ts|tsx)$/u.test(entry.name) || /\.test\.(?:ts|tsx)$/u.test(entry.name)) return [];
    return [next];
  });
}

describe("user-facing error boundary guard", () => {
  it("finds no UI path that renders error.message or String(error) directly", () => {
    const offenders: string[] = [];
    for (const file of productionSources(SRC_ROOT)) {
      const relative = NodePath.relative(SRC_ROOT, file).split(NodePath.sep).join("/");
      if (INTERNAL_ERROR_FILES.has(relative)) continue;
      NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (RAW_ERROR_TEXT.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps internal files from rendering", () => {
    for (const relative of INTERNAL_ERROR_FILES.keys()) {
      expect(relative.endsWith(".ts"), relative).toBe(true);
      const source = NodeFS.readFileSync(NodePath.join(SRC_ROOT, relative), "utf8");
      expect(source, relative).not.toMatch(/Alert\.alert\(|<Text\b|setError\(/u);
    }
  });

  it("routes every Alert that receives a caught error through the boundary", () => {
    const offenders: string[] = [];
    for (const file of productionSources(SRC_ROOT)) {
      const source = NodeFS.readFileSync(file, "utf8");
      for (const match of source.matchAll(/Alert\.alert\(([^;]*?)\);/gsu)) {
        const args = match[1] ?? "";
        if (/\b(?:error|cause|cancelError)\b/u.test(args) && !args.includes("userFacingError")) {
          offenders.push(`${NodePath.relative(SRC_ROOT, file)}: ${args.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
