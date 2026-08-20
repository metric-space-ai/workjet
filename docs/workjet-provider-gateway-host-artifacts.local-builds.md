# Locally verified provider-gateway host builds

Evidence for the artifact contract in
`docs/workjet-provider-gateway-host-artifacts.md`. Everything below was produced
by running the real pipeline — the same `stage` / `collect` / `verify` / `pin`
subcommands the release workflow calls — on one machine. Nothing here is a
published release, and no artifact was fabricated for a target this machine
cannot build.

## Build environment

- macOS 26 (Darwin 25.2.0), Apple Silicon
- `rustc 1.97.0 (2d8144b7 2026-07-07)`, host `aarch64-apple-darwin`
- `x86_64-apple-darwin` added with `rustup target add`
- `CARGO_TARGET_DIR` pointed at an external volume (the system disk is
  chronically short of space on this machine)
- Release profile as committed in
  `native/provider-gateway-workjet-host/Cargo.toml`: `codegen-units = 1`,
  `lto = "thin"`, `strip = true`

Build command, per triple:

```sh
cargo build --locked --release \
  --manifest-path native/provider-gateway-workjet-host/Cargo.toml \
  --bin workjet-provider-gateway-host \
  --target <triple>
```

## What was built and verified

Both Apple targets were built from `native/provider-gateway-workjet-host` 0.1.0
and staged under version `0.1.0` — first at repository commit `34ba5de64`, then
again at `3e6f56571`, with identical results.

| Triple                 | Asset name                                                 | Bytes      | SHA-256                                                            |
| ---------------------- | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `aarch64-apple-darwin` | `workjet-provider-gateway-host-0.1.0-aarch64-apple-darwin` | 17 311 904 | `bebddae69cd3f9e2cc66d377a031f6f16cd4654f2d71e57f73f969c281955ec1` |
| `x86_64-apple-darwin`  | `workjet-provider-gateway-host-0.1.0-x86_64-apple-darwin`  | 18 693 696 | `db8d6ea2e7ef9cbf4b8de0eda9b02ef5ca60a3f4ea6d35173e4ee2e99496b7f9` |

Independent checks on those two files:

- `file` reports `Mach-O 64-bit executable arm64` and
  `Mach-O 64-bit executable x86_64` respectively — the cross-built x64 binary is
  genuinely x86_64, not a relabelled arm64 build.
- `shasum -a 256` reproduces both digests the `stage` subcommand recorded, so
  the digests are not self-attested by the tool that wrote them.
- The arm64 binary executes: run with no configuration it prints its own
  `provider gateway host failed` diagnostic, i.e. it is a working host that
  refused an empty configuration, not an inert file.
- Adding the release profile reduced the arm64 binary from 22 077 216 bytes to
  17 311 904 bytes (-21.6 %).
- Both targets were rebuilt from scratch after `cargo fmt` reformatted
  `src/runtime.rs`, and both reproduced **byte-identical digests**. The two
  digests above are therefore stable across an independent build of the same
  source on the same toolchain, not an artefact of one build directory.

## What was NOT built

`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-pc-windows-msvc`, and `aarch64-pc-windows-msvc` **cannot** be produced on
this machine: they need Linux and Windows link toolchains that are not present,
and cross-linking them from macOS is not part of the contract. No binary,
digest, or manifest entry was invented for them. They are covered only by
`.github/workflows/provider-gateway-host-release.yml`, which builds each on its
own native runner.

## Pipeline exercised end to end

To prove the `collect` → `verify` → `pin` path (which requires all six targets),
the four unbuildable triples were staged from clearly marked **placeholder**
files in a throwaway directory outside the repository. That directory is not a
release and its four placeholder digests appear nowhere in this repository. The
observed behaviour:

| Step                                                  | Result                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collect` with only the two real Apple artifacts      | refused: `Release is missing required targets: x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-pc-windows-msvc, aarch64-pc-windows-msvc.` (exit 1) |
| `collect` with all six staged                         | wrote the manifest and `sha256sums.txt`, copied the four notices (exit 0)                                                                                      |
| `verify`                                              | `verified provider-gateway-host-v0.1.0 (6 artifacts)` (exit 0)                                                                                                 |
| `shasum -a 256 -c …sha256sums.txt`                    | six `OK` lines — the checksum file is valid coreutils format, checked by a tool that did not write it (exit 0)                                                 |
| one byte flipped in the arm64 artifact, then `verify` | refused: `… does not match its manifest entry.` (exit 1); restoring the byte returned it to exit 0                                                             |
| `LICENSE.upstream` removed, then `verify`             | refused: a release cannot be published without its notices (exit 1)                                                                                            |
| `pin`                                                 | wrote a `status: "pinned"` pin recording the manifest digest and all six artifact records (exit 0)                                                             |

That generated pin was then decoded by the desktop resolver
(`apps/desktop/src/providerGateway/ProviderGatewayHostArtifact.ts`), which
independently re-implements the pin schema in Effect Schema. It accepted the
file and resolved the `darwin`/`arm64` entry to the real
`bebddae6…` digest and 17 311 904 bytes — so the producer and the consumer agree
on the contract rather than each agreeing only with itself.

## The pin checked into this repository

`apps/desktop/resources/provider-gateway/host-release.pin.json` remains
`status: "unreleased"`. No `provider-gateway-host-v*` release exists yet, so
there is no honest digest to pin. Replace it with the workflow's
`gateway-host-consumer-pin` artifact once the first release is tagged.
