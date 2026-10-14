import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { configureNdk } = require("../apps/mobile/plugins/withAndroidNdkRuntime.cjs");

test("pins the runtime before Expo chooses its default and is idempotent", () => {
  const input = 'buildscript {}\napply plugin: "expo-root-project"\n';
  const output = configureNdk(input);
  assert.ok(output.indexOf("29.0.14206865") < output.indexOf("expo-root-project"));
  assert.equal(configureNdk(output), output);
});

test("refuses an unknown or duplicate native template", () => {
  assert.throws(() => configureNdk("buildscript {}"), /expected one/);
  assert.throws(
    () => configureNdk('apply plugin: "expo-root-project"\n'.repeat(2)),
    /expected one/,
  );
});
