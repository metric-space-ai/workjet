# Decision Hub — verification tools

Kept in the repo on purpose: the session scratchpad and `/tmp` are swept by the
OS mid-task. On 2026-08-20 that wiped the SSH key, the cookie jar and every
verification script at once.

| Script | What it proves |
| --- | --- |
| `welsch-guest-key.sh` | Recreates the guest SSH key from the fleet DB and prints a ready `GUEST_SSH`. The key is never stored durably — it is decrypted on demand. |
| `verify-chain.sh` | Inbound mail → Vorgang → Entscheidung → approval thread assigned to the owner. Purges its own `example.org` test data first. |
| `verify-ui.mjs` | The same thing through a real browser and real WebRTC: Decision Hub queue, Threads inbox, mailbox settings. |

## Rules learned the hard way

- **Only `example.*` addresses in tests.** An early E2E sent to a real customer
  address; the queued mail had to be deleted from `stalwart_smtp_queue`.
- **One peer per state root.** A stray interactive `ctox business-os peer start`
  ran for 14 h next to the service and silently starved the projection. Check
  `pgrep -af ctox-real` before diagnosing anything.
- **Be patient with projections.** They run in 25-doc slices and sleep up to
  30 min once idle. `verify-chain.sh` restarts the service to wake them instead
  of waiting.
- **System modules ship in the release,** not in the state dir. Only
  `installed-modules/` lives under state — rsyncing a system module into
  `state/business-os/modules/` has no effect.
- **A 401 on `/api/business-os/*` is auth, not routing.** Managed tenants reach
  the guest only through the ctox-dev proxy allowlist, and a tenant password
  reset invalidates existing sessions (`access_version`).

## Getting a session cookie

```bash
curl -s -c jar https://welsch.ctox.dev/login -o /dev/null
curl -s -b jar -c jar -X POST https://welsch.ctox.dev/login \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'user=<login>' --data-urlencode "password=$PW"
```

The field is `user`, not `username`. Never put the password in the command line
history — pass it through an environment variable.
