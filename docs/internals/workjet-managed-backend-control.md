# Managed Business OS backend control

Managed Business OS device administration is a ctox.dev control-plane operation. It is not an
Environment operation and it must never be routed through a Code computer, the primary Workjet
Environment, or computer membership.

## Trust boundary

The producer resolves one short-lived `backendControlConnectionId` for a canonical
`BusinessOsInstanceId`. It binds the opaque handle server-side to all of the following:

- the authenticated Workjet user session;
- the stable Workjet installation identity;
- the DPoP proof key used for the resolve request; and
- the selected Business OS instance authority identity.

The handle contains at least 256 random bits, is valid for at most 600 seconds, is never persisted
by the renderer, and cannot be used after its user session, DPoP key, instance scope, or expiry no
longer matches. Re-resolving returns a new handle; it does not widen the old handle.

Every request requires the authenticated ctox.dev session, a fresh DPoP proof for the exact method
and URL, and the session CSRF token. Every response uses `Cache-Control: no-store`,
`Pragma: no-cache`, and `Referrer-Policy: no-referrer`. Logs, traces, analytics, and error details
must omit handles, DPoP proofs, CSRF values, invite references, redemption codes, and credentials.

## Endpoints

- `POST /api/workjet/backend-control/connections`
- `POST /api/workjet/backend-control/device-bindings/list`
- `POST /api/workjet/backend-control/device-invites/create`
- `POST /api/workjet/backend-control/device-invites/revoke`

The first endpoint accepts only `businessOsInstanceId` and `workjetInstallationId`. The producer
derives the authenticated user/session and DPoP thumbprint; clients cannot assert those authority
facts.

List, create, and revoke require both the connection handle and the same canonical instance ID.
The producer rejects a handle from another instance, Workjet installation, user session, or DPoP
key. Create accepts a TTL but no URL or Environment ID: the producer chooses the trusted compact
reference endpoint. Its response is the existing secret-free `WorkjetDeviceInviteCreateResult`.

## Activation gate

The contract is published by `@t3tools/contracts` and consumed through the platform port exported
as `@t3tools/client-runtime/state/business-os-managed-backend-control`. It is deliberately not
registered on `EnvironmentHttpApi`. Workjet keeps managed device actions disabled until ctox.dev
implements this producer and the Desktop/Mobile platform adapter supplies authenticated DPoP/CSRF
transport for it.
