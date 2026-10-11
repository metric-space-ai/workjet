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
triggers one new pair; quota errors appear inline in Konto · ctox.dev. The
ellipsis menu can enroll a replacement with a fresh session. Explicit logout
suspends automatic recovery, including across restarts, until ordinary login.

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
bounded error codes cross settings IPC; private material stays in the desktop
main process.

TODO: optional Secure Enclave storage as a later hardening step.

## Verification

Run `scripts/check-ctox-device-key-client.sh` through the shared Linux build
lane. It checks formatting, targeted lint/tests, desktop/server/web types and
an isolated browser fixture that renders the actual production settings
components at 1440 and 420 pixels. Its bridge supplies public fixture metadata;
it does not claim a deployed account or full Electron end-to-end acceptance.

After the ctox-dev owner deploys the contract revision:

1. Launch this Workjet revision in a new isolated profile and complete one
   ordinary ctox.dev login with an acceptance account and acceptance tenant.
   Check the active settings row and the enrollment email. Record revisions.
2. Quit normally. Simulate the #414 loss only in that isolated profile, using
   the existing mock/reset test harness. Retain its device-secret file. Reopen:
   the enrolled instances must reappear without a login prompt. Activate one
   tenant and verify the one-use launch exchange reaches the guest.
3. In the acceptance account's device management, revoke this test device.
   Quit/reopen the isolated profile with its account session absent. Confirm
   the existing login-start message appears and the device record is invalid.
4. Complete ordinary login again, check the new active device and enrollment
   email, then use the settings ellipsis to set up another replacement while
   the session is fresh. Capture the row at both widths.
5. Revoke acceptance devices through the normal account UI and remove only the
   isolated profile. Do not access the installed application's credentials or
   protected files, alter its Keychain, or deploy from this client task.
