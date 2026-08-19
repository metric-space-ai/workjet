// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  addCtoxSshManagedEntry,
  buildCtoxSshDescriptorCommand,
  CTOX_SSH_MANAGED_ID_PATTERN,
  ctoxSshManagedInstanceId,
  CtoxSshExecError,
  discoverCtoxSshManagedInstances,
  isConsistentCtoxSshManagedEntry,
  isCtoxSshManagedInstance,
  removeCtoxSshManagedEntry,
  type CtoxSshExec,
  type CtoxSshExecInput,
  type CtoxSshManagedConfigDocument,
  type CtoxSshManagedConfigEntry,
} from "./CtoxSshManagedSource.ts";

const NOW = 1_800_000_000_000;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function emptyDocument(): CtoxSshManagedConfigDocument {
  return { version: 1, instances: [] };
}

function entry(host: string, overrides: Partial<CtoxSshManagedConfigEntry> = {}) {
  return {
    id: ctoxSshManagedInstanceId(host, overrides.stateRoot),
    host,
    displayName: host,
    ...overrides,
  } as CtoxSshManagedConfigEntry;
}

function descriptorJson(overrides: Record<string, unknown> = {}): string {
  return encodeUnknownJson({
    version: 1,
    instanceId: "remote-1",
    displayName: "Remote Business OS",
    status: "running",
    lastSeenAt: NOW - 1_000,
    ...overrides,
  });
}

/** Records every invocation so command construction can be asserted. */
function fakeExec(responses: Readonly<Record<string, string | "fail">>): {
  readonly exec: CtoxSshExec;
  readonly calls: CtoxSshExecInput[];
} {
  const calls: CtoxSshExecInput[] = [];
  const exec: CtoxSshExec = (input) => {
    calls.push(input);
    const response = responses[input.host];
    return response === undefined || response === "fail"
      ? Effect.fail(new CtoxSshExecError({ reason: "unreachable" }))
      : Effect.succeed({ stdout: response });
  };
  return { exec, calls };
}

describe("CtoxSshManagedSource command construction", () => {
  it("keeps the remote command fixed and never interpolates user data unquoted", () => {
    const withoutRoot = buildCtoxSshDescriptorCommand();
    assert.deepEqual(withoutRoot.slice(0, 2), ["sh", "-c"]);
    assert.include(withoutRoot[2] ?? "", "${CTOX_STATE_ROOT:-$HOME/.local/state/ctox}");
    assert.include(withoutRoot[2] ?? "", "head -c 65536");

    const withRoot = buildCtoxSshDescriptorCommand("/srv/ctox");
    assert.include(withRoot[2] ?? "", "CTOX_ROOT='/srv/ctox'");
    assert.notInclude(withRoot[2] ?? "", "$HOME");
  });

  it("single-quotes a state root so it cannot escape its own argument", () => {
    // The schema rejects quotes long before this point; the quoting is the
    // second, independent guarantee.
    const command = buildCtoxSshDescriptorCommand("/srv/it's");
    assert.include(command[2] ?? "", `CTOX_ROOT='/srv/it'\\''s'`);
  });

  it("derives ids that are stable, opaque, and destination-specific", () => {
    const first = ctoxSshManagedInstanceId("build-box");
    assert.match(first, CTOX_SSH_MANAGED_ID_PATTERN);
    assert.equal(first, ctoxSshManagedInstanceId("build-box"));
    assert.notEqual(first, ctoxSshManagedInstanceId("other-box"));
    assert.notEqual(first, ctoxSshManagedInstanceId("build-box", "/srv/ctox"));
    assert.notInclude(first, "build-box");
  });
});

describe("CtoxSshManagedSource configuration", () => {
  it("adds, replaces in place, and removes entries without storing a secret", () => {
    const added = addCtoxSshManagedEntry(emptyDocument(), {
      host: "build-box",
      displayName: "Build Box",
      stateRoot: "/srv/ctox",
    });
    assert.equal(added._tag, "updated");
    if (added._tag !== "updated") return;
    assert.lengthOf(added.document.instances, 1);
    const serialized = encodeUnknownJson(added.document);
    for (const forbidden of ["secret", "token", "password", "credential", "syncRoom"]) {
      assert.notInclude(serialized.toLowerCase(), forbidden.toLowerCase());
    }

    // Same destination, different label: an update, never a duplicate row.
    const relabelled = addCtoxSshManagedEntry(added.document, {
      host: "build-box",
      displayName: "Build Box II",
      stateRoot: "/srv/ctox",
    });
    assert.equal(relabelled._tag, "updated");
    if (relabelled._tag !== "updated") return;
    assert.lengthOf(relabelled.document.instances, 1);
    assert.equal(relabelled.document.instances[0]?.displayName, "Build Box II");

    const id = relabelled.document.instances[0]?.id ?? "";
    const removed = removeCtoxSshManagedEntry(relabelled.document, id);
    assert.equal(removed._tag, "updated");
    if (removed._tag !== "updated") return;
    assert.lengthOf(removed.document.instances, 0);
  });

  it("defaults the display name to the host and refuses unknown ids", () => {
    const added = addCtoxSshManagedEntry(emptyDocument(), { host: "build-box" });
    assert.equal(added._tag, "updated");
    if (added._tag !== "updated") return;
    assert.equal(added.document.instances[0]?.displayName, "build-box");
    assert.equal(added.document.instances[0]?.stateRoot, undefined);

    assert.equal(removeCtoxSshManagedEntry(added.document, "not-an-ssh-id")._tag, "invalid");
    assert.equal(
      removeCtoxSshManagedEntry(added.document, ctoxSshManagedInstanceId("other"))._tag,
      "not_found",
    );
  });

  it("rejects an entry whose id does not match its own destination", () => {
    const honest = entry("build-box");
    assert.isTrue(isConsistentCtoxSshManagedEntry(honest));
    assert.isFalse(isConsistentCtoxSshManagedEntry({ ...honest, host: "attacker-box" }));
  });

  it("orders entries deterministically regardless of insertion order", () => {
    const forward = ["alpha", "zulu", "mike"].reduce<CtoxSshManagedConfigDocument>(
      (document, host) => {
        const mutation = addCtoxSshManagedEntry(document, { host, displayName: host });
        return mutation._tag === "updated" ? mutation.document : document;
      },
      emptyDocument(),
    );
    const reverse = ["mike", "zulu", "alpha"].reduce<CtoxSshManagedConfigDocument>(
      (document, host) => {
        const mutation = addCtoxSshManagedEntry(document, { host, displayName: host });
        return mutation._tag === "updated" ? mutation.document : document;
      },
      emptyDocument(),
    );
    assert.deepEqual(forward.instances, reverse.instances);
    assert.deepEqual(
      forward.instances.map((instance) => instance.displayName),
      ["alpha", "mike", "zulu"],
    );
  });
});

describe("CtoxSshManagedSource discovery", () => {
  it.effect("reports a running remote daemon as available", () =>
    Effect.gen(function* () {
      const { exec, calls } = fakeExec({ "build-box": descriptorJson() });
      const discovered = yield* discoverCtoxSshManagedInstances(
        [entry("build-box", { displayName: "Build Box" })],
        { exec, nowEpochMs: () => NOW },
      );
      assert.lengthOf(discovered, 1);
      const instance = discovered[0]?.instance;
      assert.equal(instance?.source, "ssh_managed");
      assert.equal(instance?.status, "available");
      assert.equal(instance?.displayName, "Build Box");
      assert.isTrue(instance !== undefined && isCtoxSshManagedInstance(instance));
      // Renderer-safe by construction: no destination, path, or port.
      const serialized = encodeUnknownJson(instance);
      assert.notInclude(serialized, "build-box");
      assert.notInclude(serialized, "remote-1");
      assert.equal(calls[0]?.host, "build-box");
      assert.deepEqual(calls[0]?.argv, buildCtoxSshDescriptorCommand());
    }),
  );

  it.effect("reports an unreachable host as offline instead of failing", () =>
    Effect.gen(function* () {
      const { exec } = fakeExec({ "build-box": "fail" });
      const discovered = yield* discoverCtoxSshManagedInstances([entry("build-box")], {
        exec,
        nowEpochMs: () => NOW,
      });
      assert.lengthOf(discovered, 1);
      assert.equal(discovered[0]?.instance.status, "offline");
      assert.equal(discovered[0]?.runtimeStatus, "stopped");
    }),
  );

  it.effect("treats corrupt, oversized, and secret-bearing descriptors as offline", () =>
    Effect.gen(function* () {
      const cases: readonly string[] = [
        "not json at all",
        encodeUnknownJson({ version: 2, instanceId: "remote-1" }),
        descriptorJson({ capability_token: "leaked-token" }),
        `${"x".repeat(70_000)}`,
        "",
      ];
      for (const stdout of cases) {
        const { exec } = fakeExec({ "build-box": stdout });
        const discovered = yield* discoverCtoxSshManagedInstances([entry("build-box")], {
          exec,
          nowEpochMs: () => NOW,
        });
        assert.equal(discovered[0]?.instance.status, "offline", stdout.slice(0, 24));
      }
    }),
  );

  it.effect("downgrades a stale running claim and honours a stopped one", () =>
    Effect.gen(function* () {
      const stale = fakeExec({ "build-box": descriptorJson({ lastSeenAt: NOW - 600_000 }) });
      const staleResult = yield* discoverCtoxSshManagedInstances([entry("build-box")], {
        exec: stale.exec,
        nowEpochMs: () => NOW,
      });
      assert.equal(staleResult[0]?.runtimeStatus, "unknown");
      assert.equal(staleResult[0]?.instance.status, "offline");

      const stopped = fakeExec({ "build-box": descriptorJson({ status: "stopped" }) });
      const stoppedResult = yield* discoverCtoxSshManagedInstances([entry("build-box")], {
        exec: stopped.exec,
        nowEpochMs: () => NOW,
      });
      assert.equal(stoppedResult[0]?.instance.status, "offline");
    }),
  );

  it.effect("passes the configured state root through to the remote command", () =>
    Effect.gen(function* () {
      const { exec, calls } = fakeExec({ "build-box": descriptorJson() });
      yield* discoverCtoxSshManagedInstances([entry("build-box", { stateRoot: "/srv/ctox" })], {
        exec,
        nowEpochMs: () => NOW,
      });
      assert.include(calls[0]?.argv[2] ?? "", "CTOX_ROOT='/srv/ctox'");
    }),
  );

  it.effect("reads every configured host as offline when no exec is available", () =>
    Effect.gen(function* () {
      const discovered = yield* discoverCtoxSshManagedInstances(
        [entry("build-box"), entry("other-box")],
        { nowEpochMs: () => NOW },
      );
      assert.lengthOf(discovered, 2);
      assert.isTrue(discovered.every((found) => found.instance.status === "offline"));
    }),
  );
});
