import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import {
  parseSshServerBuildArguments,
  sshServerBuildArguments,
} from "./ssh-server-build-arguments.ts";

it("keeps normal server packaging on the published pin and propagates explicit diagnostic input", () => {
  const manifest = NodePath.resolve("fixture/diagnostic-package.manifest.json");
  NodeAssert.deepEqual(parseSshServerBuildArguments([]), {});
  NodeAssert.deepEqual(parseSshServerBuildArguments(sshServerBuildArguments("archives")), {
    output: "archives",
  });
  NodeAssert.deepEqual(
    parseSshServerBuildArguments(sshServerBuildArguments("archives", manifest)),
    { output: "archives", diagnosticProviderGatewayHost: manifest },
  );
});
it("refuses missing, relative, duplicated and unknown diagnostic inputs", () => {
  for (const args of [
    ["archives", "--diagnostic-provider-gateway-host"],
    ["archives", "--diagnostic-provider-gateway-host", "relative.json"],
    ["archives", "--unknown", NodePath.resolve("manifest")],
    ["--diagnostic-provider-gateway-host", NodePath.resolve("manifest")],
    [
      "archives",
      "--diagnostic-provider-gateway-host",
      NodePath.resolve("manifest"),
      "--diagnostic-provider-gateway-host",
      NodePath.resolve("another"),
    ],
  ])
    NodeAssert.throws(() => parseSshServerBuildArguments(args), /Expected/);
});
