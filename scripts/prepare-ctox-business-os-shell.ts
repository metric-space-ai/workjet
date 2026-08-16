#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This explicit bootstrap reports one verified dependency path to the invoking release job.

import * as NodePath from "node:path";

import {
  CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT_ENV,
  prepareCtoxBusinessOsShell,
} from "./lib/ctox-business-os-shell.ts";

function parseDependencyRoot(argv: ReadonlyArray<string>): string | undefined {
  let dependencyRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--dependency-root") {
      throw new Error("Unknown argument. Only --dependency-root is accepted.");
    }
    const value = argv[index + 1];
    if (value === undefined || value === "--dependency-root") {
      throw new Error("--dependency-root requires a path.");
    }
    if (dependencyRoot !== undefined)
      throw new Error("--dependency-root may be provided only once.");
    dependencyRoot = NodePath.resolve(value);
    index += 1;
  }
  return dependencyRoot;
}

if (import.meta.main) {
  try {
    const dependencyRoot = parseDependencyRoot(process.argv.slice(2));
    const result = await prepareCtoxBusinessOsShell(
      dependencyRoot === undefined ? {} : { dependencyRoot },
    );
    process.stdout.write(
      `[ctox-business-os-shell] verified (${result.cache}): ${result.installPath}\n`,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown preparation failure.";
    process.stderr.write(
      `[ctox-business-os-shell] preparation failed: ${message}\nDependency root may be set with --dependency-root or ${CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT_ENV}.\n`,
    );
    process.exitCode = 1;
  }
}
