import * as Schema from "effect/Schema";
import type { InstalledPackageIndex } from "./release-notice.ts";

/**
 * Exact published npm manifest metadata for platform packages in the desktop
 * production closure. A fresh Linux install lacks macOS/Windows manifests and
 * vice versa. These reviewed, version-specific records keep NOTICE generation
 * offline and independent of the generator's host. Each source identifies the
 * exact manifest; update these records when the corresponding lockfile version
 * changes. Never infer a different version's license from this table.
 */
export const RELEASE_PLATFORM_LICENSE_METADATA: Readonly<
  Record<
    string,
    {
      readonly license: string;
      readonly repository?: string;
      readonly source: string;
    }
  >
> = {
  "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-darwin-arm64/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-darwin-x64/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source:
      "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-linux-arm64-musl/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-linux-arm64/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-linux-x64-musl/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-linux-x64/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-win32-arm64/0.3.170",
  },
  "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.170": {
    license: "SEE LICENSE IN LICENSE.md",
    source: "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk-win32-x64/0.3.170",
  },
  "@clerk/electron-passkeys-darwin-arm64@0.0.3": {
    license: "MIT",
    repository: "https://github.com/clerk/javascript",
    source: "https://registry.npmjs.org/%40clerk%2Felectron-passkeys-darwin-arm64/0.0.3",
  },
  "@clerk/electron-passkeys-darwin-x64@0.0.3": {
    license: "MIT",
    repository: "https://github.com/clerk/javascript",
    source: "https://registry.npmjs.org/%40clerk%2Felectron-passkeys-darwin-x64/0.0.3",
  },
  "@clerk/electron-passkeys-win32-arm64-msvc@0.0.3": {
    license: "MIT",
    repository: "https://github.com/clerk/javascript",
    source: "https://registry.npmjs.org/%40clerk%2Felectron-passkeys-win32-arm64-msvc/0.0.3",
  },
  "@clerk/electron-passkeys-win32-x64-msvc@0.0.3": {
    license: "MIT",
    repository: "https://github.com/clerk/javascript",
    source: "https://registry.npmjs.org/%40clerk%2Felectron-passkeys-win32-x64-msvc/0.0.3",
  },
  "@ff-labs/fff-bin-darwin-arm64@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-darwin-arm64/0.9.4",
  },
  "@ff-labs/fff-bin-darwin-x64@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-darwin-x64/0.9.4",
  },
  "@ff-labs/fff-bin-linux-arm64-gnu@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-linux-arm64-gnu/0.9.4",
  },
  "@ff-labs/fff-bin-linux-arm64-musl@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-linux-arm64-musl/0.9.4",
  },
  "@ff-labs/fff-bin-linux-x64-gnu@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-linux-x64-gnu/0.9.4",
  },
  "@ff-labs/fff-bin-linux-x64-musl@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-linux-x64-musl/0.9.4",
  },
  "@ff-labs/fff-bin-win32-arm64@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-win32-arm64/0.9.4",
  },
  "@ff-labs/fff-bin-win32-x64@0.9.4": {
    license: "MIT",
    repository: "https://github.com/dmtrKovalenko/fff",
    source: "https://registry.npmjs.org/%40ff-labs%2Ffff-bin-win32-x64/0.9.4",
  },
  "@msgpackr-extract/msgpackr-extract-darwin-arm64@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-darwin-arm64/3.0.4",
  },
  "@msgpackr-extract/msgpackr-extract-darwin-x64@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-darwin-x64/3.0.4",
  },
  "@msgpackr-extract/msgpackr-extract-linux-arm@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-linux-arm/3.0.4",
  },
  "@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-linux-arm64/3.0.4",
  },
  "@msgpackr-extract/msgpackr-extract-linux-x64@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-linux-x64/3.0.4",
  },
  "@msgpackr-extract/msgpackr-extract-win32-x64@3.0.4": {
    license: "MIT",
    repository: "ssh://git@github.com/kriszyp/msgpackr-extract",
    source: "https://registry.npmjs.org/%40msgpackr-extract%2Fmsgpackr-extract-win32-x64/3.0.4",
  },
  "@yuuang/ffi-rs-android-arm64@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-android-arm64/1.3.2",
  },
  "@yuuang/ffi-rs-darwin-arm64@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-darwin-arm64/1.3.2",
  },
  "@yuuang/ffi-rs-darwin-x64@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-darwin-x64/1.3.2",
  },
  "@yuuang/ffi-rs-linux-arm-gnueabihf@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-linux-arm-gnueabihf/1.3.2",
  },
  "@yuuang/ffi-rs-linux-arm64-gnu@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-linux-arm64-gnu/1.3.2",
  },
  "@yuuang/ffi-rs-linux-arm64-musl@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-linux-arm64-musl/1.3.2",
  },
  "@yuuang/ffi-rs-linux-x64-gnu@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-linux-x64-gnu/1.3.2",
  },
  "@yuuang/ffi-rs-linux-x64-musl@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-linux-x64-musl/1.3.2",
  },
  "@yuuang/ffi-rs-win32-arm64-msvc@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-win32-arm64-msvc/1.3.2",
  },
  "@yuuang/ffi-rs-win32-ia32-msvc@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-win32-ia32-msvc/1.3.2",
  },
  "@yuuang/ffi-rs-win32-x64-msvc@1.3.2": {
    license: "MIT",
    source: "https://registry.npmjs.org/%40yuuang%2Fffi-rs-win32-x64-msvc/1.3.2",
  },
};

export class ReleaseNoticePlatformMetadataConflictError extends Schema.TaggedErrorClass<ReleaseNoticePlatformMetadataConflictError>()(
  "ReleaseNoticePlatformMetadataConflictError",
  {
    packageKey: Schema.String,
    expectedLicense: Schema.String,
    installedLicense: Schema.String,
  },
) {
  override get message(): string {
    return `Installed license for ${this.packageKey} differs from its reviewed platform manifest (${this.installedLicense} instead of ${this.expectedLicense}).`;
  }
}

export function applyReleasePlatformMetadata(
  index: InstalledPackageIndex,
  metadata = RELEASE_PLATFORM_LICENSE_METADATA,
): InstalledPackageIndex {
  const merged = new Map(index);
  for (const [key, record] of Object.entries(metadata)) {
    const installed = index.get(key);
    if (installed?.license !== undefined && installed.license !== record.license) {
      throw new ReleaseNoticePlatformMetadataConflictError({
        packageKey: key,
        expectedLicense: record.license,
        installedLicense: installed.license,
      });
    }
    merged.set(key, { license: record.license, repository: record.repository });
  }
  return merged;
}
