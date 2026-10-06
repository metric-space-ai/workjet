#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Local diagnostic compilation runs under the operator's shared admission gate.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import {
  captureDiagnosticNativeSource,
  parseDiagnosticHostBuildOptions,
  stageDiagnosticProviderGatewayHost,
} from "./lib/provider-gateway-host-diagnostic.ts";

const { arch, outDir } = parseDiagnosticHostBuildOptions(process.argv.slice(2));
if (Effect.runSync(HostProcessPlatform) !== "darwin")
  throw new Error("A diagnostic host requires a Mac.");
const targetDir = process.env.CARGO_TARGET_DIR;
if (!targetDir || !NodePath.isAbsolute(targetDir))
  throw new Error(
    "Set an absolute CARGO_TARGET_DIR on the disposable development volume before compiling.",
  );
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const before = await captureDiagnosticNativeSource(repoRoot);
const build = NodeChildProcess.spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "native/provider-gateway-workjet-host/Cargo.toml",
    "--bin",
    "workjet-provider-gateway-host",
    "--target",
    triple,
    "--jobs",
    "2",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, CARGO_BUILD_JOBS: "2", CMAKE_BUILD_PARALLEL_LEVEL: "2" },
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const manifestPath = await stageDiagnosticProviderGatewayHost({
  repoRoot,
  arch,
  outDir,
  expectedNativeSource: before.nativeSource,
  binaryPath: NodePath.join(targetDir, triple, "release/workjet-provider-gateway-host"),
});
console.log(`Diagnostic host receipt: ${manifestPath}`);
