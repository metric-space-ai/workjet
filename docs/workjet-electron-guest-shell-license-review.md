# Electron guest-shell packaging and network-use review

Status date: 2026-08-20. Scope: the CTOX Business OS guest shell as it is packaged
into and executed by the Workjet desktop artifact.

**This is an engineering fact record, not legal advice.** It states what the code
does and which obligations plausibly attach so that counsel can rule on the open
questions. Nothing here is a legal opinion, and nothing here grants or waives any
right. The items in "Remaining for legal sign-off" must be closed before the first
public binary.

## 1. What ships and where it comes from

- `scripts/lib/ctox-business-os-shell.ts` pins one CTOX release archive
  (`business-os-shell-v0.1.0-rc.12`) by URL, byte length, SHA-256 of both the
  manifest and the archive, and an embedded-manifest digest. Redirects are limited
  to `github.com` and `release-assets.githubusercontent.com`.
- `scripts/prepare-ctox-business-os-shell.ts` verifies and expands that archive at
  build time into a local install path. The download happens on the build host, not
  on the user's machine.
- `scripts/build-desktop-artifact.ts` copies the verified install into the packaged
  application as the `ctox-business-os-shell` extra resource
  (`createDesktopExtraResources`). **The shell's files are therefore redistributed
  inside every desktop binary**, unpacked in `Resources/ctox-business-os-shell`.
- The same script now also stages the three license notices (`stageLegalNotices`)
  into `Resources/legal/`: `LICENSE`, `LICENSE_POLICY.md`, and `NOTICE.md`. The
  build fails closed if any of the three is missing, so no binary can ship without
  the T3 MIT notice and the generated release NOTICE.

## 2. How the guest shell is loaded and what it may reach

- `apps/desktop/src/ctox/CtoxBusinessOsShell.ts` starts a Node HTTP server bound to
  `127.0.0.1` on an ephemeral port and serves the packaged shell directory under the
  `/business-os` path prefix. Nothing outside the canonical resource root is served.
- The launch URL is `http://127.0.0.1:<port>/business-os/?ctox_config=<base64url>`.
  The configuration blob is passed in the query string of a loopback URL and is
  filtered out of logs and telemetry by `SENSITIVE_QUERY_PARAMETERS` in
  `CtoxGuestManager.ts`.
- `apps/desktop/src/ctox/CtoxGuestManager.ts` renders the shell in an Electron
  `WebContentsView` with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, in a dedicated session. It installs a
  `setWindowOpenHandler` and a `will-navigate` guard, and constrains requests to an
  explicit allow list: four `/api/business-os/...` control paths, the enumerated
  static asset paths and prefixes, and the data resource types (`xhr`, `fetch`,
  `websocket`).
- The shell talks to a CTOX instance the user selects: a local daemon, a managed
  launch, or an SSH-reached remote host (`CtoxLocalDaemonLaunch.ts`,
  `CtoxManagedLaunch.ts`, `CtoxSshManagedLaunch.ts`). The CTOX instance is separate
  software with its own runtime and its own license; Workjet does not redistribute
  the CTOX daemon.

## 3. Which obligations attach to the shipped binary

- **T3-derived application code (MIT).** The obligation is notice retention only.
  It is satisfied by the repository-root `LICENSE` plus the packaged
  `Resources/legal/LICENSE`, and it is asserted by
  `scripts/build-desktop-artifact.test.ts` and
  `scripts/generate-release-notice.test.ts`.
- **Metric Space AI components (`MIT OR AGPL-3.0-only`).** Workjet releases select
  the MIT option (`LICENSE_POLICY.md`). Under the MIT option, AGPL section 13
  network-interaction obligations do not attach to the shipped binary, because the
  recipient's chosen license is MIT. The selection is only valid for files whose
  copyright Metric Space AI owns or controls.
- **The packaged Business OS shell.** This is the one component where the analysis
  is not closed. `docs/workjet-source-provenance.md` records that the Business OS
  Desktop source carries no component license field or file and that its first-party
  files "currently inherit CTOX's AGPL policy". The shell archive is built from a
  CTOX release, and Workjet redistributes its build output. Two things must be true
  before the first public binary: (a) the exact files in the shipped archive are
  Metric Space AI-owned or controlled, so the MIT option can be selected for them;
  or (b) they are distributed under AGPL-3.0-only, in which case the corresponding
  source offer in `NOTICE.md` section 7 is the operative obligation and the release
  must publish complete corresponding source for that archive revision.
- **AGPL section 13 and the loopback server.** The shell is served over HTTP from
  `127.0.0.1` to the same user on the same machine. That is a local transport
  detail, not interaction with a _remote_ user over a network, so section 13's
  "remote network interaction" trigger does not appear to be met by the loopback
  server itself. This is stated as an engineering reading of what the code does, not
  as a legal conclusion. The trigger would need re-examination if a future build
  binds the shell server to a non-loopback interface, proxies it through Tailscale
  or the SSH transport, or serves it to a second user.
- **Greppy (Apache-2.0).** No Greppy source is vendored and no Greppy binary is
  packaged. Workjet pins the upstream source archive
  (`packages/workjet-capabilities/src/greppyRuntime.ts`) and, on explicit user
  opt-in, downloads and builds it into the server state directory on the user's
  machine. This artifact therefore performs no Apache-2.0 redistribution; the
  notices inside the upstream archive govern the resulting local build. The pinned
  model weights are separate assets with their own terms and are not covered by
  Greppy's Apache-2.0 software license.
- **Third-party npm dependencies.** Their notices are enumerated in `NOTICE.md`
  section 4, regenerated deterministically by
  `scripts/generate-release-notice.ts`.

## 4. Remaining for legal sign-off

1. Confirm the ownership of every file in the pinned Business OS shell archive and
   record the chosen license option for the shipped copy. Until that is recorded,
   `NOTICE.md` deliberately says "AGPL-3.0-only unless the dual option applies".
2. Confirm that the standing three-year source offer in `NOTICE.md` section 7 is the
   form Metric Space AI wants to publish, and name the contact channel for requests.
3. Resolve `@react-grab/cli`, the one packaged dependency with no license declared
   in its manifest (`NOTICE.md` section 6).
4. Confirm that `SEE LICENSE IN LICENSE.md` packages excluded from the artifact by
   `DESKTOP_FILE_EXCLUSIONS` really are absent from every built target, so the
   notice's exclusion claim in section 5 holds for all platforms.
5. Reconcile the two open provenance conflicts already tracked in
   `docs/workjet-source-provenance.md`: CTOX's root npm `ISC` declaration versus its
   AGPL root license, and Greppy's `0.3.1` manifest versus its `0.2.1` release text.
6. Decide whether the desktop package manifests should carry an explicit `license`
   field. `apps/desktop/package.json` declares none today, so the packaged
   `app.asar` `package.json` carries no license expression even though
   `Resources/legal/LICENSE` is present.
