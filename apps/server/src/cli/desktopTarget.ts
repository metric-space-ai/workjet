import { LocalServiceTarget } from "@workjet/shared/localServiceTarget";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { discoverPairTarget, PairTargetIdentityError } from "./pair.ts";

/** Profile-bound local discovery, not proof that a public descriptor is authenticated. */
export const describeDesktopTarget = Effect.fn("cli.desktop.describeTarget")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const canonicalBaseDir = yield* fs.realPath(baseDir);
  const target = yield* discoverPairTarget(canonicalBaseDir, {});
  if (target.state.runtimeInstanceId === undefined) {
    return yield* new PairTargetIdentityError({ statePath: canonicalBaseDir });
  }
  return {
    version: 1,
    baseDir: canonicalBaseDir,
    environmentId: target.descriptor.environmentId,
    runtimeInstanceId: target.state.runtimeInstanceId,
    serverVersion: target.descriptor.serverVersion,
    origin: target.state.origin,
  } satisfies LocalServiceTarget;
});

export const desktopTargetCommand = Command.make("__desktop-target", {
  baseDir: Flag.string("base-dir"),
}).pipe(
  Command.withHidden,
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      const target = yield* describeDesktopTarget(baseDir);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LocalServiceTarget))(target);
      yield* Console.log(encoded);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
