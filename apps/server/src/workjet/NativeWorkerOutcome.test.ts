// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NativeWorkerTerminalReceipt, terminalReceiptFrom } from "./NativeWorkerOutcome.ts";
import { persisted, startup } from "./nativeWorkerOutcomeFixture.ts";
it.effect("maps only the exact stopped terminal native receipt, without paths, models or credentials", () =>
  Effect.gen(function* () {
    const outcome = yield* terminalReceiptFrom(persisted, startup);
    assert.deepEqual(Object.keys(outcome).sort(), ["branch", "computer_id", "environment_id", "execution_stopped", "pull_request", "schema", "worker_thread_id"]);
    assert.equal(outcome.pull_request.state, "merged");
    assert.equal((yield* terminalReceiptFrom({ ...persisted, state: "closed" }, startup)).pull_request.state, "closed");
    for (const altered of [
      { ...persisted, state: "open" as const }, { ...persisted, executionStopped: 0 },
      { ...persisted, worktreePath: "/foreign" }, { ...persisted, branchRef: "foreign" },
      { ...persisted, provider: "gitlab" as const }, { ...persisted, headOid: "invalid" },
      { ...persisted, prUrl: "https://githubXcom/owner/repo/pull/7" },
      { ...persisted, prUrl: "https://github.com/owner/repo/pull/8" },
    ]) assert.equal((yield* terminalReceiptFrom(altered, startup).pipe(Effect.result))._tag, "Failure");
    const foreign = { ...outcome, execution_stopped: false };
    assert.equal(Schema.is(NativeWorkerTerminalReceipt)(foreign), false);
  }));
