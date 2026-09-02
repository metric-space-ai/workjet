import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { terminateProviderProcesses, type ProviderTrackedProcess } from "./ProviderAdapter.ts";

function fakeProcess(input: { readonly stopOn?: "SIGTERM" | "SIGKILL" }) {
  let running = true;
  const signals: Array<string> = [];
  const process: ProviderTrackedProcess = {
    pid: 4242,
    isRunning: Effect.sync(() => running),
    kill: (signal) =>
      Effect.sync(() => {
        signals.push(signal);
        if (input.stopOn === signal) running = false;
      }),
  };
  return { process, signals, stop: () => (running = false) };
}

it.effect("reports cooperative process termination", () =>
  Effect.gen(function* () {
    const fake = fakeProcess({});
    const result = yield* terminateProviderProcesses({
      processes: [fake.process],
      cooperative: Effect.sync(fake.stop),
    });
    assert.deepEqual(result, { terminated: true, method: "cooperative", pids: [4242] });
    assert.deepEqual(fake.signals, []);
  }),
);

it.effect("escalates a hanging process to SIGTERM", () =>
  Effect.gen(function* () {
    const fake = fakeProcess({ stopOn: "SIGTERM" });
    const result = yield* terminateProviderProcesses({
      processes: [fake.process],
      cooperative: Effect.never,
      phaseTimeoutMs: 1,
    });
    assert.deepEqual(result, { terminated: true, method: "sigterm", pids: [4242] });
    assert.deepEqual(fake.signals, ["SIGTERM"]);
  }),
);

it.effect("escalates a SIGTERM-resistant process to SIGKILL", () =>
  Effect.gen(function* () {
    const fake = fakeProcess({ stopOn: "SIGKILL" });
    const result = yield* terminateProviderProcesses({
      processes: [fake.process],
      cooperative: Effect.never,
      phaseTimeoutMs: 1,
    });
    assert.deepEqual(result, { terminated: true, method: "sigkill", pids: [4242] });
    assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
  }),
);
