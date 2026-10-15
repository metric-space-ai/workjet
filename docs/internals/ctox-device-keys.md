# ctox.dev device recovery

Wire contract: mkh-welsch/ctox-dev `docs/desktop-device-keys.md` at
`7e758a20ad9ed31c4e291f999fd37b9246d44f14`. The adjacent `.source.txt`
interoperability fixture is an unaltered copy of `lib/desktop-device-proof.ts`
from that commit (MIT). The executable fixture strips types and expands
constructor parameter properties; its verification logic is unchanged.

Workjet keeps the P-256 private key in the existing ServerSecretStore, under
`userdata/secrets/ctox-control-device-key.bin`, with directory mode 0700 and
file mode 0600. This credential is independent of Electron safeStorage and the
#414 recovery reset. Copying a file as the same UID is an explicitly accepted
risk; the server restricts the credential to its tenant snapshot and three
desktop operations.

Completed ordinary ctox.dev logins reconcile or enroll the device key. The
server enforces the ten-minute fresh-login window. A duplicate thumbprint
triggers one new pair. Enrollment outcomes are exposed as public status and
bounded notice codes. Explicit logout suspends automatic recovery, including
across restarts, until ordinary login.

Missing or expired account sessions, and a pending #414 recovery, first try a
signed session-package request. Discovery uses the existing tenant normalizer
and registry merge. Managed launch falls back from expired cookie auth to a
signed launch-token request, then uses the existing one-use launch exchange.
Every request obtains a new sixty-second nonce. The signature binds its nonce,
method, configured origin host, pathname, and exact body bytes. Startup recovery
is limited to one attempt plus one retry; there is no new polling loop.

DEVICE_AUTH_REQUIRED preserves the file and marks the record invalid. The next
ordinary login enrolls a new pair. The local expiration follows the server's
thirty-day inactivity and 180-day absolute limits. Only public dates, state and
bounded error codes cross IPC; private material stays in desktop main.

TODO: optional Secure Enclave storage as a later hardening step.

## UI owner handover

UI design and implementation belong to Kimi or Grok. This backend PR contains
no changes under `apps/web/src/components` or `apps/web/src/routes`. The former
Codex-authored presentation is preserved only as a reference on
`ui-handover/device-key-client-20261011`, without a PR. It must not be shipped as
the UI implementation. The UI owner must build and verify the account settings
integration and 1440/420 px evidence separately.

### Public data

`packages/contracts/src/ctoxControlDevice.ts` defines and exports
`CtoxControlDeviceStatus` through `packages/contracts/src/index.ts`:

- `state`: `"active" | "not_configured"`. Use this field for validity; retained
  dates can remain present for an expired or invalid record.
- `createdAt?`, `expiresAt?`: ISO timestamps.
- `lastUsedAt?`: ISO timestamp or `null` for an unused key.
- `notice?`: a bounded backend error code. Enrollment can report
  `DEVICE_KEY_LIMIT_REACHED`, `DEVICE_FRESH_LOGIN_REQUIRED`,
  `DEVICE_AUTH_REQUIRED`, `DEVICE_THUMBPRINT_ALREADY_REGISTERED`,
  `DEVICE_SCOPE_DENIED`, `DEVICE_TENANT_DENIED` or `DEVICE_SERVICE_UNAVAILABLE`.
  Transport/read failures use the service-unavailable status. No upstream
  error text, private key, thumbprint or launch credential belongs in this data.

### Actions

`packages/contracts/src/ipc.ts` defines the optional desktop bridge methods:

- `DesktopCtoxBridge.deviceStatus(): Promise<CtoxControlDeviceStatus>` reads the
  current public metadata. It does not start login, enroll or poll.
- `DesktopCtoxBridge.resetDevice(): Promise<CtoxControlDeviceStatus>` requests
  replacement through the current account session and returns the resulting
  status after completion. The server enforces fresh login. A stale session or
  quota limit becomes `notice`; this operation does not open a login dialog.
- Existing `DesktopCtoxBridge.login()` is the explicit ordinary-login action.
  Successful normal login performs enrollment automatically in desktop main.

Feature-detect the optional bridge methods. The UI owner connects these data
and actions through the existing desktop bridge, handles pending/rejected
promises, and refreshes state after replacement or normal login. No new polling
loop or browser-side key storage is needed.

`apps/desktop/src/preload.ts` exposes the methods. Channel constants in
`apps/desktop/src/ipc/channels.ts` are `desktop:ctox-device-status` and
`desktop:ctox-device-reset`. Handlers in `apps/desktop/src/ipc/methods/ctox.ts`
validate public metadata and call `apps/desktop/src/ctox/CtoxDevAuth.ts`.
The credential owner is `apps/desktop/src/ctox/CtoxControlDeviceClient.ts`,
wired to ServerSecretStore by `apps/desktop/src/ctox/CtoxControlDevice.ts`.

## Backend verification

Run `scripts/check-ctox-device-key-client.sh` through the shared Linux build
lane. It checks formatting, targeted backend lint/tests and Effect-patched
desktop/server/web types. Web typechecking verifies shared contract consumers;
no UI component, browser fixture or presentation test is part of this PR.

After the ctox-dev owner deploys the contract revision, verify with an
acceptance account and tenant in a new isolated desktop profile:

1. Complete ordinary ctox.dev login. Check `deviceStatus()` is active and the
   enrollment email arrived. Record deployed and client revisions.
2. Quit normally. Simulate #414 loss only in that isolated profile with the
   existing wrong-key test path, retaining its device-secret file. Reopen:
   enrolled instances must return without login. Activate a tenant and verify
   the one-use launch exchange reaches the guest.
3. Revoke the acceptance device via ctox.dev `/dashboard/device-keys`. With the
   isolated account session absent, quit/reopen: the existing login-start state
   must return and the local record remain invalid. Ordinary login must enroll
   a distinct new pair.
4. Once the Kimi/Grok implementation lands, verify its settings integration,
   replacement while the session is fresh, and both screenshot widths.
5. Revoke acceptance devices through the normal account UI and remove only the
   isolated profile. Do not access the installed application's protected files,
   alter its Keychain, or deploy from this client task.
