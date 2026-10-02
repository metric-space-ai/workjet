# Workjet provider-gateway host release artifacts

The `workjet-provider-gateway-host` binary (crate
`native/provider-gateway-workjet-host`) is published as a standalone release so
that CTOX and Workjet packaging can depend on **one pinned build** instead of
each compiling the crate. This document is the artifact contract: what is
published, how it is named, how a consumer pins it, and how the Workjet desktop
chooses between a pinned artifact and a local build.

The contract is implemented once, in
`scripts/lib/provider-gateway-host-artifacts.ts`. The release workflow, the
staging CLI, and the consumer resolver all derive their strings from that module
so the three cannot drift apart. It mirrors the working precedent in this
repository for pinning someone else's build — the CTOX Business OS shell
(`scripts/lib/ctox-business-os-shell.ts` +
`apps/desktop/resources/ctox/business-os-shell.manifest.json`) — so CTOX can
consume the gateway the same way Workjet consumes the shell.

## 1. Targets

Six targets, one artifact each. Every `(os, arch)` pair is unique, so a consumer
picks its artifact from `process.platform` / `process.arch` without ambiguity.

| Rust target triple          | `process.platform` | `process.arch` | Build runner                     |
| --------------------------- | ------------------ | -------------- | -------------------------------- |
| `aarch64-apple-darwin`      | `darwin`           | `arm64`        | `blacksmith-12vcpu-macos-26`     |
| `x86_64-apple-darwin`       | `darwin`           | `x64`          | `blacksmith-12vcpu-macos-26`     |
| `x86_64-unknown-linux-gnu`  | `linux`            | `x64`          | `blacksmith-32vcpu-ubuntu-2404`  |
| `aarch64-unknown-linux-gnu` | `linux`            | `arm64`        | `ubuntu-24.04-arm`               |
| `x86_64-pc-windows-msvc`    | `win32`            | `x64`          | `blacksmith-32vcpu-windows-2025` |
| `aarch64-pc-windows-msvc`   | `win32`            | `arm64`        | `windows-11-arm`                 |

Every triple builds on a runner of its own architecture, except
`x86_64-apple-darwin`, which builds on the arm64 macOS runner — that is already
this repository's practice for the resource monitor in `release.yml`. The two
ARM64 non-Apple triples use GitHub-hosted ARM runners because the repository has
no Blacksmith ARM labels; a hand-rolled MSVC/GCC cross-linking setup would be
considerably more fragile than a native run.

A release is all-or-nothing: `collect` refuses to build a manifest that is
missing any of the six targets, so a partially successful matrix fails the run
instead of publishing a release a consumer would silently fail to resolve on the
missing platform.

## 2. Release identity and assets

**Tag:** `provider-gateway-host-v<version>` — for example
`provider-gateway-host-v0.1.0`. It deliberately does not begin with `v`, so it
can never match the desktop `release.yml` trigger (`v*.*.*`). Cutting a gateway
release never starts a desktop release, and vice versa. The tag's version must
equal the crate version in `native/provider-gateway-workjet-host/Cargo.toml`;
the workflow's preflight fails otherwise.

**Assets** published under that tag:

| Asset                                                                   | Purpose                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workjet-provider-gateway-host-<version>-<triple>` (`.exe` on Windows)  | The raw executable — one per triple. No archive: the host is a single self-contained binary, so a consumer verifies it with one SHA-256 and needs no tar/zip reader. |
| `workjet-provider-gateway-host-<version>.manifest.json`                 | The detached release manifest (schema `workjet.provider-gateway-host.release.v1`) listing every artifact with its file name, URL, byte length, and SHA-256.          |
| `workjet-provider-gateway-host-<version>.sha256sums.txt`                | GNU `sha256sum` binary-mode lines, checkable verbatim with `sha256sum --check`.                                                                                      |
| `LICENSE.MIT`, `LICENSE.AGPL-3.0-only`, `LICENSE.upstream`, `NOTICE.md` | The notices the dual-licensed binary must be distributed with (see §5).                                                                                              |

Download URLs are always
`https://github.com/metric-space-ai/workjet/releases/download/<tag>/<asset>`; the
manifest decoder rejects any other host, so a tampered manifest cannot redirect
a consumer elsewhere.

### Manifest shape

```json
{
  "schema": "workjet.provider-gateway-host.release.v1",
  "component": "workjet-provider-gateway-host",
  "version": "0.1.0",
  "releaseTag": "provider-gateway-host-v0.1.0",
  "sourceCommit": "<40 hex characters>",
  "repository": "metric-space-ai/workjet",
  "license": "MIT OR AGPL-3.0-only",
  "checksumsFileName": "workjet-provider-gateway-host-0.1.0.sha256sums.txt",
  "artifacts": [
    {
      "triple": "aarch64-apple-darwin",
      "os": "darwin",
      "arch": "arm64",
      "fileName": "workjet-provider-gateway-host-0.1.0-aarch64-apple-darwin",
      "url": "https://github.com/metric-space-ai/workjet/releases/download/provider-gateway-host-v0.1.0/workjet-provider-gateway-host-0.1.0-aarch64-apple-darwin",
      "byteLength": 17311904,
      "sha256": "<64 hex characters>"
    }
  ]
}
```

`sourceCommit` is the repository commit the release was built from, exactly as
`business-os-shell.manifest.json` records the CTOX source commit.

## 3. How a consumer pins a release

A consumer commits a pin file (schema `workjet.provider-gateway-host.pin.v1`)
recording the tag, the manifest digest, and every per-target digest. In this
repository the pin lives at
`apps/desktop/resources/provider-gateway/host-release.pin.json`. Generate it
from a collected release directory:

```sh
node scripts/provider-gateway-host-artifacts.ts pin \
  --dir <release dir> \
  --out apps/desktop/resources/provider-gateway/host-release.pin.json
```

The release workflow also emits this file as the `gateway-host-consumer-pin`
build artifact, but never commits it: promoting a release to the pinned
dependency is a reviewed change, not a side effect of tagging.

The pin has two states:

- `"status": "pinned"` — carries `release` with the manifest digest and the six
  artifact records. The consumer verifies the on-disk bytes against
  `byteLength` + `sha256` before running anything.
- `"status": "unreleased"` — a first-class state recording that no gateway
  release exists yet, with a human-readable `unreleasedReason`. It is **not** a
  licence to download something unverified; it makes the resolver report an
  unmet pin. The pin checked in today is in this state, because no
  `provider-gateway-host-v*` release has been published.

CTOX pins the same way: it consumes the manifest and per-target digests from a
release tag and verifies the bytes it downloads. Because the manifest is
self-describing and digest-pinned, a CTOX pin does not need any Workjet code —
only the tag, the manifest digest, and the artifact digest for its platform.

## 4. Which executable the Workjet desktop runs

`apps/desktop/src/providerGateway/ProviderGatewayHostArtifact.ts` makes the
decision. In priority order:

1. **Override.** A non-empty `WORKJET_PROVIDER_GATEWAY_HOST_EXECUTABLE` always
   wins, in packaged and development builds alike. A developer pointing at a
   specific build is never second-guessed. (This is the same variable
   `apps/server/src/providerGateway/ProviderGatewayNodeAdapter.ts` already
   honours.)
2. **Pinned artifact.** When the pin is `pinned` and publishes an artifact for
   this platform, the resolver looks for it at
   - packaged: `<resourcesPath>/provider-gateway-host/<assetName>`
   - development: `<rootDir>/.deps/workjet-provider-gateway-host/<version>/<assetName>`
     (the same `.deps/` tree the CTOX shell uses, keyed by version so two pins
     can coexist), and verifies its size and SHA-256 against the pin.
3. **Local build (development fallback).** If the pin is unmet — unreleased, no
   artifact for this platform, the file is missing, or its digest does not
   match — a development build returns no override and lets the server's
   existing default resolution apply: `<stateDir>/provider-gateway-host`, i.e.
   the binary a developer produced with
   `cargo build --release --manifest-path native/provider-gateway-workjet-host/Cargo.toml`.
   The resolver reports the exact reason it fell back.

A **packaged** build never falls back. Each of the unmet-pin cases above is a
`ProviderGatewayHostArtifactError` naming the exact mismatch (missing file, wrong
size, wrong digest, unsupported platform, or no pinned release). A packaged app
has no Rust toolchain, so a silent fallback would only surface later as a
confusing "the gateway will not start".

Today, with an `unreleased` pin, every development build uses path 1 or 3 and a
packaged build would fail fast — which is correct: nothing has been released to
package.

## 5. Licensing obligations

The binary is `MIT OR AGPL-3.0-only` and statically links
`native/provider-gateway`, which is a Rust port of
[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). The
release therefore carries, alongside the executables,
`native/provider-gateway/LICENSE.MIT`,
`native/provider-gateway/LICENSE.AGPL-3.0-only`,
`native/provider-gateway/LICENSE.upstream` (the retained upstream MIT notice),
and the repository `NOTICE.md`. The `collect` subcommand copies them and
`verify` fails if any is missing, so a release cannot be published without its
notices. `scripts/lib/release-notice.ts` remains the source of truth for what
the notice says about this component.

## 6. Reproducing a release locally

The release workflow runs exactly these subcommands, so the same commands
reproduce a release for whatever targets the local machine can build:

```sh
export CARGO_TARGET_DIR=/some/large/volume/cargo-target

cargo build --locked --release \
  --manifest-path native/provider-gateway-workjet-host/Cargo.toml \
  --bin workjet-provider-gateway-host \
  --target aarch64-apple-darwin

node scripts/provider-gateway-host-artifacts.ts stage \
  --triple aarch64-apple-darwin --version 0.1.0 \
  --binary "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/workjet-provider-gateway-host" \
  --out-dir dist/gateway-host

# …repeat for the other five triples…

node scripts/provider-gateway-host-artifacts.ts collect \
  --version 0.1.0 --source-commit "$(git rev-parse HEAD)" --dir dist/gateway-host
node scripts/provider-gateway-host-artifacts.ts verify --dir dist/gateway-host
```

`collect` refuses to produce a manifest until all six triples are staged, so a
partial local run stops at `incomplete-release` rather than emitting a manifest
that looks complete.

### Locally verified builds

Measured on macOS 26 / Apple Silicon with the release profile added to
`native/provider-gateway-workjet-host/Cargo.toml`
(`codegen-units = 1`, `lto = "thin"`, `strip = true`). See
`docs/workjet-provider-gateway-host-artifacts.local-builds.md` for the exact
digests recorded from those runs. The four non-Apple triples cannot be produced
on this machine — they need Linux and Windows toolchains — and no artifact was
fabricated for them; the workflow covers them on their own runners.
