export interface MobileBusinessOsBundleOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly release: Readonly<Record<string, unknown>>;
  readonly catalog: {
    readonly type: string;
    readonly revision: string;
    readonly apps: readonly Readonly<Record<string, unknown>>[];
  };
}
export interface MobileBusinessOsBundleManifest {
  readonly type: "workjet.bundled-business-os-shell.v1";
  readonly upstream: Readonly<Record<string, unknown>>;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly packId: string;
}
export const MOBILE_BUNDLE_TYPE: "workjet.bundled-business-os-shell.v1";
export function writeMobileBusinessOsBundle(
  options: MobileBusinessOsBundleOptions,
): Promise<MobileBusinessOsBundleManifest>;
