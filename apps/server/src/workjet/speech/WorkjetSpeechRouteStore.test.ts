// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { EnvironmentId } from "@workjet/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkjetSpeechRouteStore, WorkjetSpeechRouteStoreLive } from "./WorkjetSpeechRouteStore.ts";

const testLayer = WorkjetSpeechRouteStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("lists both session kinds with null computers before any selection", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetSpeechRouteStore;
    const result = yield* store.list;
    assert.deepStrictEqual(result.routes, [
      { sessionKind: "regeltermin", sttEnvironmentId: null, ttsEnvironmentId: null },
      { sessionKind: "spontan", sttEnvironmentId: null, ttsEnvironmentId: null },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("stores STT and TTS computers per session kind independently", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetSpeechRouteStore;
    yield* store.set({
      sessionKind: "regeltermin",
      sttEnvironmentId: EnvironmentId.make("gpu-3"),
      ttsEnvironmentId: EnvironmentId.make("gpu-4"),
    });
    yield* store.set({
      sessionKind: "spontan",
      sttEnvironmentId: null,
      ttsEnvironmentId: EnvironmentId.make("gpu-3"),
    });
    const result = yield* store.list;
    assert.deepStrictEqual(result.routes, [
      {
        sessionKind: "regeltermin",
        sttEnvironmentId: EnvironmentId.make("gpu-3"),
        ttsEnvironmentId: EnvironmentId.make("gpu-4"),
      },
      {
        sessionKind: "spontan",
        sttEnvironmentId: null,
        ttsEnvironmentId: EnvironmentId.make("gpu-3"),
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replaces an existing selection instead of adding a second row", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetSpeechRouteStore;
    yield* store.set({
      sessionKind: "spontan",
      sttEnvironmentId: EnvironmentId.make("gpu-3"),
      ttsEnvironmentId: null,
    });
    yield* store.set({
      sessionKind: "spontan",
      sttEnvironmentId: EnvironmentId.make("gpu-4"),
      ttsEnvironmentId: null,
    });
    const result = yield* store.list;
    assert.strictEqual(result.routes.length, 2);
    assert.deepStrictEqual(result.routes[1], {
      sessionKind: "spontan",
      sttEnvironmentId: EnvironmentId.make("gpu-4"),
      ttsEnvironmentId: null,
    });
  }).pipe(Effect.provide(testLayer)),
);
