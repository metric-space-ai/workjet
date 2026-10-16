// @effect-diagnostics nodeBuiltinImport:off - Der Wächter liest Quelldateien direkt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { CommandId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createCommandAttempts, isCommandReceiptUncertain, nextAttemptId } from "./commandAttempt";

const previous = CommandId.make("attempt-1");
const fresh = () => CommandId.make("attempt-2");

describe("command attempt ids (CTOX v4 idempotency key)", () => {
  it("keeps the id while the receipt is lost or unclear", () => {
    for (const outcome of [
      null,
      "lost",
      { _tag: "failed", code: "timeout" },
      { _tag: "failed", code: "not_active" },
      { _tag: "failed", code: "launch_failed" },
      { _tag: "failed", code: "guest_failed", diagnostic: { reason: "request_timeout" } },
      { _tag: "failed", code: "guest_failed", diagnostic: { reason: "peer_unavailable" } },
      { _tag: "failed", code: "guest_failed", preparation: { stage: "attach" } },
    ] as const)
      expect(nextAttemptId(previous, outcome, fresh)).toBe(previous);
  });

  it("takes a new id once the previous attempt has a final answer", () => {
    for (const outcome of [
      { _tag: "completed" },
      { _tag: "failed", code: "unsupported" },
      { _tag: "failed", code: "invalid_input" },
      { _tag: "failed", code: "guest_failed" },
      { _tag: "failed", code: "authentication_required" },
      { _tag: "failed", code: "guest_failed", diagnostic: { reason: "core_outdated" } },
      { _tag: "failed", code: "guest_failed", diagnostic: { reason: "access_denied" } },
      { _tag: "failed", code: "invalid_projection" },
    ] as const)
      expect(nextAttemptId(previous, outcome, fresh)).toBe("attempt-2");
    expect(isCommandReceiptUncertain({ _tag: "completed" })).toBe(false);
  });

  it("starts a first attempt with a fresh id", () => {
    expect(nextAttemptId(null, null, fresh)).toBe("attempt-2");
  });

  it("tracks attempts per key: timeout + retry keeps, final failure + retry renews", () => {
    let counter = 0;
    const make = () => CommandId.make(`id-${++counter}`);
    const attempts = createCommandAttempts();
    const first = attempts.begin("bind", make);
    attempts.settle("bind", first, { _tag: "failed", code: "timeout" });
    expect(attempts.begin("bind", make)).toBe(first);
    attempts.settle("bind", first, { _tag: "failed", code: "unsupported" });
    const third = attempts.begin("bind", make);
    expect(third).not.toBe(first);
    // A late answer for an older id cannot settle the current attempt.
    attempts.settle("bind", first, { _tag: "failed", code: "unsupported" });
    expect(attempts.begin("bind", make)).toBe(third);
    expect(attempts.begin("other", make)).not.toBe(third);
    attempts.clear();
    expect(attempts.begin("bind", make)).not.toBe(third);
  });

  it("session import: the first attempt reuses the registration id, a renewal does not", () => {
    const attempts = createCommandAttempts();
    const registration = CommandId.make("registration-id");
    const fresh = () => (attempts.has("project") ? CommandId.make("renewed") : registration);
    const first = attempts.begin("project", fresh);
    expect(first).toBe(registration);
    attempts.settle("project", first, { _tag: "failed", code: "timeout" });
    expect(attempts.begin("project", fresh)).toBe(registration);
    attempts.settle("project", registration, { _tag: "failed", code: "unsupported" });
    expect(attempts.begin("project", fresh)).toBe("renewed");
  });
});

// Ids built from project/thread/instance identities are stable per scope, so
// CTOX v4 would answer every retry with the first attempt's result forever.
// Such a stable identity belongs in `operationId`, never in `commandId`.
describe("static guard: no scope-derived command ids", () => {
  const root = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
  const scanned = ["web/src", "desktop/src"].map((dir) => NodePath.join(root, dir));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of NodeFS.readdirSync(dir)) {
      const path = NodePath.join(dir, name);
      if (NodeFS.statSync(path).isDirectory()) {
        if (name !== "node_modules") walk(path);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  for (const dir of scanned) walk(dir);
  const scopeIdentity = /project|thread|instance|meeting|workspace|scope|setup:/i;
  const commandIdTemplate = /(?:CommandId\.make\(|\bcommandId:\s*)`([^`]*)`/g;

  const offendersIn = (source: string) =>
    [...source.matchAll(commandIdTemplate)]
      .filter((match) => {
        const template = match[1] ?? "";
        const interpolations = [...template.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? "");
        return (
          interpolations.some((expression) => scopeIdentity.test(expression)) ||
          scopeIdentity.test(template.replace(/\$\{[^}]*\}/g, ""))
        );
      })
      .map((match) => match[0]);

  it("scans the client sources and recognizes the old pattern", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(
      offendersIn(
        "CommandId.make(`supervisor-setup:${bindingProjectId}:${bindingThreadId}`); " +
          "const r = { commandId: `create-${project.id}` };",
      ),
    ).toHaveLength(2);
    expect(
      offendersIn(
        "CommandId.make(`supervisor-setup-${newCommandId()}`); CommandId.make(`${intent.commandId}:bind`);" +
          " const r = { operationId: `init:${projectId}` };",
      ),
    ).toEqual([]);
  });

  it("never builds a commandId from project, thread or instance ids", () => {
    const offenders = files.flatMap((file) =>
      offendersIn(NodeFS.readFileSync(file, "utf8")).map(
        (hit) => `${NodePath.relative(root, file)}: ${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
