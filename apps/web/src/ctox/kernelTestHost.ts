import type { Kernel } from "./kernel/index";
import { PLATFORM_MANIFEST } from "./kernel/platform-manifest.generated.mjs";
import {
  WORKJET_APP_ID,
  workjetAppManifest,
  workjetForeignOwnerManifests,
} from "./workjetAppManifest";

export const TEST_PLATFORM_VER = "test-platform-1";

/**
 * Explicit fixture Core fact, not a production Shell/version fallback: the Shell row and the
 * real published platform catalog (E61: business_commands is the V4 command document v3), which
 * the real kernel needs before it writes platform collections.
 * With `workjetAppVer` it also publishes the Workjet manifest and its ctox-owned export owner, so
 * the Workjet app API reads exactly what the manifest declares (§16.13).
 */
export async function seedKernelTestShell(
  kernel: Kernel,
  options: { readonly workjetAppVer?: string } = {},
) {
  const appVer = options.workjetAppVer;
  const apps: Record<string, unknown>[] = [
    { id: "shell", active_ver: "test-shell-1" },
    { id: "ctox-platform", active_ver: TEST_PLATFORM_VER },
  ];
  const versions: Record<string, unknown>[] = [
    {
      id: `ctox-platform@${TEST_PLATFORM_VER}`,
      app_id: "ctox-platform",
      app_ver: TEST_PLATFORM_VER,
      manifest: PLATFORM_MANIFEST,
    },
  ];
  if (appVer !== undefined) {
    apps.push({ id: WORKJET_APP_ID, active_ver: appVer }, { id: "ctox", active_ver: appVer });
    versions.push(
      {
        id: `${WORKJET_APP_ID}@${appVer}`,
        app_id: WORKJET_APP_ID,
        app_ver: appVer,
        manifest: workjetAppManifest(appVer),
      },
      // The platform owner is the real catalog above; only the ctox export owner is a fixture.
      ...workjetForeignOwnerManifests(appVer).filter((row) => row.app_id === "ctox"),
    );
  }
  for (const [collection, rows] of [
    ["business_apps", apps],
    ["business_app_versions", versions],
  ] as const)
    await kernel.receivePage({
      epoch: "1",
      collection,
      scope_hash: "local",
      gen: 1,
      cursor_to: String(rows.length),
      complete: true,
      docs: rows.map((data, index) => ({
        id: String(data.id),
        seq: String(index + 1),
        rev: "1",
        data,
      })),
    });
}

/** Test introspection of platform rows (e.g. business_commands), which apps cannot read (§16.13). */
export function platformView(kernel: Kernel) {
  return kernel.appApi("ctox-platform", TEST_PLATFORM_VER);
}
