import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "workjet-computer-cas-test-" })),
    ),
  );

it.layer(NodeServices.layer)("computer settings compare-and-swap", (it) => {
  it.effect("rejects a stale computer write without overwriting another settings change", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.start;
      const original = yield* settings.getSettings;
      const changed = {
        ...original.workjet,
        selectedComputerId: "other-computer" as NonNullable<
          typeof original.workjet.selectedComputerId
        >,
      };
      yield* settings.updateSettings({ workjet: changed }, original.workjet);
      const failure = yield* Effect.flip(
        settings.updateSettings({ workjet: original.workjet }, original.workjet),
      );
      assert.strictEqual(failure.operation, "compare-workjet");
      assert.strictEqual(
        (yield* settings.getSettings).workjet.selectedComputerId,
        "other-computer",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
