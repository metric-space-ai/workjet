import * as fs from "node:fs/promises";
import path from "node:path";
import {
  CTOX_BUSINESS_OS_SHELL_RELEASE,
  prepareCtoxBusinessOsShell,
  resolveCtoxBusinessOsShellDependencyRoot,
} from "./lib/ctox-business-os-shell.ts";
import { BUILT_IN_BUSINESS_OS_MOBILE_CATALOG } from "../apps/mobile/src/features/business-os/launcher/business-os-app-catalog.ts";
import { writeMobileBusinessOsBundle } from "./lib/mobile-business-os-bundle.mjs";

export async function prepareMobileBusinessOsBundle({ projectRoot, platform }) {
  if (platform !== "android" && platform !== "ios") throw new Error("Unsupported mobile platform");
  const repoRoot = path.resolve(projectRoot, "../..");
  const dependencyRoot = resolveCtoxBusinessOsShellDependencyRoot({ repoRoot });
  const source = await prepareCtoxBusinessOsShell({ repoRoot, dependencyRoot });
  const staging = await fs.mkdtemp(path.join(dependencyRoot, "mobile-shell-"));
  const bundleRoot = path.join(staging, "WorkjetBusinessOs.bundle");
  try {
    await writeMobileBusinessOsBundle({
      sourceRoot: source.installPath,
      outputRoot: bundleRoot,
      release: CTOX_BUSINESS_OS_SHELL_RELEASE,
      catalog: BUILT_IN_BUSINESS_OS_MOBILE_CATALOG,
    });
    const moduleRoot = path.join(projectRoot, "modules/t3-native-controls");
    const link =
      platform === "android"
        ? path.join(moduleRoot, "android/src/main/assets/workjet-business-os")
        : path.join(moduleRoot, "ios/Resources/WorkjetBusinessOs.bundle");
    await fs.mkdir(path.dirname(link), { recursive: true });
    const existing = await fs.lstat(link).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing && !existing.isSymbolicLink())
      throw new Error(`Refusing to replace non-generated resources: ${link}`);
    if (existing) await fs.unlink(link);
    await fs.symlink(bundleRoot, link, "dir");
    return bundleRoot;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
