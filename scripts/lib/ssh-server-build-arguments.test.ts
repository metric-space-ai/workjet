import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  parseSshServerBuildArguments,
  sshServerBuildArguments,
} from "./ssh-server-build-arguments.ts";

it.effect(
  "keeps normal server packaging on the published pin and propagates explicit diagnostic input",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const manifest = path.resolve("fixture/diagnostic-package.manifest.json");
      assert.deepEqual(parseSshServerBuildArguments([]), {});
      assert.deepEqual(parseSshServerBuildArguments(sshServerBuildArguments("archives")), {
        output: "archives",
      });
      assert.deepEqual(
        parseSshServerBuildArguments(sshServerBuildArguments("archives", manifest)),
        { output: "archives", diagnosticProviderGatewayHost: manifest },
      );
    }).pipe(Effect.provide(NodePath.layer)),
);
it.effect("refuses missing, relative, duplicated and unknown diagnostic inputs", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const args of [
      ["archives", "--diagnostic-provider-gateway-host"],
      ["archives", "--diagnostic-provider-gateway-host", "relative.json"],
      ["archives", "--unknown", path.resolve("manifest")],
      ["--diagnostic-provider-gateway-host", path.resolve("manifest")],
      [
        "archives",
        "--diagnostic-provider-gateway-host",
        path.resolve("manifest"),
        "--diagnostic-provider-gateway-host",
        path.resolve("another"),
      ],
    ])
      assert.throws(() => parseSshServerBuildArguments(args), /Expected/);
  }).pipe(Effect.provide(NodePath.layer)),
);
