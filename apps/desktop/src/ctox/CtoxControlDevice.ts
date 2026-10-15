import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";
import { makeWithDirectory } from "../../../server/src/auth/ServerSecretStore.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { DEVICE_SECRET_NAME, makeControlDeviceClient } from "./CtoxControlDeviceClient.ts";

export class CtoxControlDevice extends Context.Service<
  CtoxControlDevice,
  ReturnType<typeof makeControlDeviceClient>
>()("@workjet/desktop/ctox/CtoxControlDevice") {}
export const layer = Layer.effect(
  CtoxControlDevice,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const store = yield* makeWithDirectory(environment.path.join(environment.stateDir, "secrets"));
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    return makeControlDeviceClient({
      baseUrl: "https://ctox.dev",
      read: async () => Option.getOrUndefined(await run(store.get(DEVICE_SECRET_NAME))),
      write: (bytes) => run(store.set(DEVICE_SECRET_NAME, bytes)),
      fetch: (url, init) => Electron.net.fetch(url, init),
    });
  }),
);
