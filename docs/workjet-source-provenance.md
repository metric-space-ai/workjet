# Workjet source provenance inventory

Status date: 2026-08-15

This inventory freezes the source identities and license boundaries used to
prepare Workjet imports. It is not an assertion that every frozen source has
already been imported, packaged, or released. Immutable commits and Git tree
objects are the source identities; downloaded archives and build outputs remain
under ignored `.deps/` or external build storage.

## Runtime ownership invariant

- A Workjet/T3 server environment runs one Greppy daemon against exactly one
  store at `<ServerConfig.stateDir>/greppy`.
- Every Code-mode thread and harness on that server shares the same store.
  Per-thread Greppy settings grant or withhold access; they never select or
  create another store.
- A remote Workjet/T3 server owns its own server-local store.
- CTOX instances remain closed, separate runtimes. Their state is not merged
  into the Workjet/T3 Greppy store.

## Frozen source identities

| Component                | Canonical source                                                     | Frozen revision                                                                                                                              | Source state at inventory                                                                                                                                                      | License boundary                                                                                                                                                                                                                                                                 | Planned Workjet treatment                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workjet / T3 Code        | `git@github.com:pingdotgg/t3code.git` via Workjet remote `upstream`  | commit `6ae44b418a24dc021cf042cbb1e60ebeb47e160f`; tree `7a67bc947abca4ef3af6becd996fb4b29c036489`                                           | Workjet merge-base equals this commit. Workjet changes form the downstream patch stack.                                                                                        | MIT; retain the T3 Tools notice in `LICENSE` (SHA-256 `935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43`).                                                                                                                                                       | Keep T3-derived files MIT and upstream-compatible where practical.                                                                                                  |
| CTOX Business OS Desktop | `/Users/michaelwelsch/Documents/ctox/src/apps/business-os-desktop`   | CTOX commit `34fc7cc0978b6a1774342cb5468e90a6a0304564`; subtree `e2bf769fe90d116f131dbcf81e76151346e7c283`                                   | Selected subtree is clean. The wider CTOX checkout is dirty and must not be used as an implicit source snapshot. Package version `0.3.52`.                                     | No component license field or file exists. First-party files currently inherit CTOX's AGPL policy. Only Metric Space AI-owned or controlled files may receive `MIT OR AGPL-3.0-only`.                                                                                            | Port the desktop connection/session behavior into Workjet; keep Business OS source and release artifacts in CTOX. Review every copied file before adding dual SPDX. |
| CLIProxyAPI Rust port    | `/Users/michaelwelsch/Documents/ctox/src/core/execution/cliproxyapi` | CTOX commit `cf92182afed8f31844cbb234657e992fd769cfdc`; subtree `9c0164ce5ffb6e799f9057700cb06bd56ecbc014`                                   | Selected subtree is clean. Crate `ctox-cliproxyapi` version `0.1.0`.                                                                                                           | Mixed provenance: upstream CLIProxyAPI is MIT; CTOX-authored port changes currently declare AGPL and may be offered as `MIT OR AGPL-3.0-only` where ownership permits. Preserve `LICENSE.upstream` (SHA-256 `87d0eee372775bafa8bf3f3d56dcbc0d9c7e0e06b9904f076d0b0ed70d288773`). | Import history, preserve upstream MIT notices, separate portable gateway code from CTOX product adapters, then publish a pinned package consumed by both products.  |
| CTOX Web Stack           | `/Users/michaelwelsch/Documents/ctox/src/tools/web-stack`            | CTOX commit `ffbe9227257cc28418b3d21a5ec207727fbbe497`; subtree `1ccc86dda8fa091c65bb5573c17e4fa4c1896b84`                                   | Selected subtree is clean. Crate `ctox-web-stack` version `0.1.0`.                                                                                                             | Mixed at file level. CTOX-owned code may be dual-licensed. `humanlike.mjs` and `stealth_init.js` identify MIT-derived ports; Patchright is an Apache-2.0 runtime dependency. Those notices and terms remain independent.                                                         | Import history only after a file-level origin pass; preserve compatibility names temporarily and inject product-specific configuration through adapters.            |
| Greppy                   | `git@github.com:metric-space-ai/greppy.git`                          | commit `de078b47d1df5df7c086e4591162517328f979ec`; source archive SHA-256 `20e54f1339f1ec138665e0bc0371d4557a96ce166ce4620ecc3f0ad4266f01cf` | Source commit is pinned by Workjet. The local checkout contains an unrelated untracked `greppy` symlink and is therefore not a clean release input. Workspace version `0.3.1`. | Apache-2.0; retain `LICENSE` (SHA-256 `887fda41b617fdddcfeca9a77214b6ee7e20b5fc0194a7c69d33d0e63d7ca02b`) plus `THIRD_PARTY.md` and model/kernel terms.                                                                                                                          | Continue using the pinned external binary/source build and one server-owned store; do not vendor a second per-thread or per-harness copy.                           |

The parent CTOX repository was at commit
`6eae0cb92b56a99bb4f6e009ee47bb9e20e93ad7` during this inventory. Its root
`LICENSE` is AGPL-3.0-only (SHA-256
`0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`).
The root npm manifest also declares `ISC`; that conflict must be resolved before
a public CTOX or combined source distribution and must not be used to infer an
ISC license for the frozen subtrees.

## Prepared history-preserving imports

The following local Workjet branches contain only the selected component at
their repository root. They were produced with `git subtree split` from the
exact frozen CTOX commit and an annotated commit-message prefix. They have not
yet been merged into the Workjet product branch or pushed to GitHub.

| Component        | Workjet import branch           | Export tip                                 | Commits retained             | Verified root tree                         |
| ---------------- | ------------------------------- | ------------------------------------------ | ---------------------------- | ------------------------------------------ |
| Provider gateway | `codex/import-provider-gateway` | `9b3b6e1aa860e43fff958691b5aec6c5264145be` | 2                            | `9c0164ce5ffb6e799f9057700cb06bd56ecbc014` |
| Web Stack        | `codex/import-web-stack`        | `fb8a1f3bf411755fc1e1e1ffd90d2efc6cd33843` | 130 (126 non-merge, 4 merge) | `1ccc86dda8fa091c65bb5573c17e4fa4c1896b84` |

For each branch, the exported root tree was compared directly with
`<frozen-ctox-commit>:<source-path>` and matched exactly. The local CTOX clone
has two shallow boundaries, so these branches preserve all component history
that the accepted local source proves; they make no claim about unreachable
history older than those boundaries.

The provider export contains 1,383 tracked source, test, fixture, SDK, example,
and port-ledger files; the Web Stack export contains 131. Neither export tracks
compiled binaries, archives, databases, credential material, dependency
directories, or build output. Names such as `internal/runtime` and `internal/cache` in the
provider export are Rust source modules, not generated runtime state. A bounded
secret-pattern scan found no embedded private key or provider-token material;
the only private-key marker is an expected assertion against generated test
output in `internal/auth/vertex/keyutil.rs`.

The import branches are intentionally source-faithful, not already
product-neutral. The provider crate still uses the `ctox-cliproxyapi` package
name and extensive CTOX port annotations, while the Web Stack still reads
`runtime/ctox.sqlite3` directly in `src/runtime_config.rs`. Those are explicit
post-import adapter/rename tasks; they are not grounds for discarding the
verified source history.

## Accepted CLIProxyAPI upstream pin

The Rust port has a separate, machine-recorded upstream base:

| Field              | Accepted value                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository         | `https://github.com/router-for-me/CLIProxyAPI.git`                                                                                           |
| Commit             | `a88197f845c979132c8978ea223c6af05cc81536`                                                                                                   |
| Commit date        | `2026-08-03`                                                                                                                                 |
| Upstream license   | MIT                                                                                                                                          |
| Promotion evidence | 111/111 reviews, 10/10 gates, 617/617 production mirrors, and 442/442 test mirrors recorded complete                                         |
| Umbrella receipt   | `runtime/cliproxyapi-strict-receipts/a88197f845c979132c8978ea223c6af05cc81536/20260804T2120Z-post-promotion-r4/strict-umbrella-receipt.json` |
| Receipt SHA-256    | `2b41678383a56af9331136dea4ba2d75b0eee33d58aba3ac5bf4be6517c5aa1d`                                                                           |

Canonical evidence remains in CTOX's `upstream-lock.json`, `UPSTREAM.md`,
`project-state.json`, `strict-credit-audit.json`, and `LICENSE.upstream`. The
receipt digest is the immutable verification identity.

## Greppy executable and model pins

Workjet's executable/source pin lives in
`packages/workjet-capabilities/src/greppyRuntime.ts`. The same manifest pins all
model inputs used by the managed installation:

| Repository                            | File                            | Revision                                   | SHA-256                                                            |
| ------------------------------------- | ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `metricspace/greppy-qwen35-mtp-q4km`  | `Qwen3.5-0.8B-MTP-Q4_K_M.gguf`  | `080231e8daee32cc185dd6070e2ca8095c6746bd` | `b36838d6969d415e08e7f91ab4aa069dcc260ec0801ea1d00bb5dab234181200` |
| `metricspace/greppy-qwen35-mtp-q4km`  | `tokenizer.json`                | `e889ca56d5e2ad36b51df8bf96ad124fea09ac83` | `5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42` |
| `metricspace/embeddinggemma-300m-q4k` | `embeddinggemma-300M-Q4_K.gguf` | `2c85ca142040bc24de9cbdebd7efae2e4ee656dd` | `53f7d1c0d5c84a81e46f3bea8e0f17c94f459ffbaa8b06f7f52f1f09e58996f2` |
| `metricspace/embeddinggemma-300m-q4k` | `tokenizer.json`                | `2c85ca142040bc24de9cbdebd7efae2e4ee656dd` | `6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e` |

These are dependency pins, not authorization to redistribute assets under
Greppy's Apache-2.0 software license. Packaging must also honor each asset's
recorded third-party terms.

## Import and release rules

1. Import only from the exact commits and subtree objects recorded above. A
   dirty parent checkout is never an accepted source identity.
2. Preserve history where practical and record the Workjet destination and
   resulting commit after each import.
3. Apply `SPDX-License-Identifier: MIT OR AGPL-3.0-only` only to files for
   which Metric Space AI owns or controls the necessary rights.
4. Preserve upstream file headers, component license texts, attribution, and
   third-party notices. Dual licensing CTOX-owned work does not relicense
   upstream-derived code.
5. Keep downloaded archives, model weights, generated shells, build outputs,
   caches, databases, tokens, and runtime state out of Git.
6. Generate the release NOTICE/source-offer inventory from the final imported
   file set and packaged dependency set, not from this planning inventory.
7. Do not remove the standalone CTOX Desktop until Workjet passes the explicit
   parity, signed-artifact, WebRTC-authority, and rollback gates in the master
   plan.

## Open provenance gaps

- Record an immutable release URL and checksum for the versioned Business OS
  shell after CTOX publishes the first artifact consumed by Workjet.
- Record file-level upstream commits/checksums for the Web Stack's derived
  browser-preparation assets before import.
- Reconcile CTOX's root npm `ISC` declaration with its AGPL root license and
  NOTICE.
- Reconcile Greppy's `0.3.1` manifest with README/CITATION release text that
  still refers to `0.2.1` before publishing a new Greppy release.
- Add resulting Workjet import commit IDs and release-package checksums as each
  component lands.
