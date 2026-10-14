import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import { test } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { configureNdk } = require("../apps/mobile/plugins/withAndroidNdkRuntime.cjs");

test("pins the runtime before Expo chooses its default and is idempotent", () => {
  const input = 'buildscript {}\napply plugin: "expo-root-project"\n';
  const output = configureNdk(input);
  NodeAssert.ok(output.indexOf("29.0.14206865") < output.indexOf("expo-root-project"));
  NodeAssert.equal(configureNdk(output), output);
});

test("refuses an unknown or duplicate native template", () => {
  NodeAssert.throws(() => configureNdk("buildscript {}"), /expected one/);
  NodeAssert.throws(
    () => configureNdk('apply plugin: "expo-root-project"\n'.repeat(2)),
    /expected one/,
  );
});
