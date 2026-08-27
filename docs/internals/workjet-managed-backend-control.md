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
- `POST /api/workjet/backend-control/device-bindings/revoke`
- `POST /api/workjet/backend-control/device-invites/create`
- `POST /api/workjet/backend-control/device-invites/revoke`
- `POST /api/workjet/device-invites/redeem`
- `POST /api/workjet/device-session/exchange`
- `POST /api/workjet/device-session/renew`
- `POST /api/workjet/device-session/business-os/computers`

The first endpoint accepts only `businessOsInstanceId` and `workjetInstallationId`. The producer
also requires a short-lived Relay-signed identity assertion for audience `ctox.dev`. Relay binds
that assertion to the same installation, canonical instance, authenticated Relay subject, and DPoP
JWK thumbprint. ctox.dev verifies issuer, audience, signature, expiry, JTI and `cnf.jkt`; it never
accepts a client-asserted Relay user ID and never correlates accounts by email. The assertion is
minted at `POST /api/workjet/device-session/control-assertion` and cannot be reused for another
installation, instance, proof key, session, or audience.

List, create, and revoke require both the connection handle and the same canonical instance ID.
The producer rejects a handle from another instance, Workjet installation, user session, or DPoP
key. Create accepts a TTL but no URL or Environment ID: the producer chooses the trusted compact
reference endpoint. Its response is the existing secret-free `WorkjetDeviceInviteCreateResult`.

The compact reference is redeemed exactly once with a fresh DPoP proof plus the stable Workjet
device ID and proof-key thumbprint. For this contract `deviceId` is the stable identity of the
receiving Workjet installation; it is not a hardware host, Computer, Environment, or backend ID.
The producer verifies the proof signature and JWK thumbprint,
exact `POST` method, exact redemption URL, bounded `iat`, and replay-protected `jti`. It provisions
two grants as one retryable saga:

- one Workjet device session scoped to the canonical `BusinessOsInstanceId`; and
- one minimum-capability CTOX RxDB/WebRTC synchronization invite for the same instance and device.

The result is `WorkjetDeviceInviteV2`. Unlike the legacy V1 envelope it contains no single
`environment` and no list of raw Code-computer credentials. A Business OS instance can own zero or
many Code computers, so selecting a primary or first computer during pairing would be incorrect.

The Workjet bootstrap credential is not a Clerk credential and is not directly usable as a Bearer
token. The client sends it once to the trusted `workjet_session.issuer` at
`POST /api/workjet/device-session/exchange`, again with a fresh proof from the same DPoP key. The
issuer is an HTTPS origin without credentials, path, query, or fragment; plain HTTP is accepted only
for an exact loopback origin. Successful exchange returns a short-lived opaque DPoP access token,
its trusted Relay issuer, the granted Relay scopes, and its expiry. The Relay accepts that token
directly for the same proof key; the paired device does not need a Clerk session and does not perform
the Clerk subject-token exchange.

Exchange also returns a rotating refresh grant bound to that exact device, proof key, installation,
instance edge, and server-side session record. Clients keep it only in platform secure storage.
`POST /api/workjet/device-session/renew` consumes the current refresh grant once and atomically
returns a new DPoP access token plus a replacement refresh grant. Replaying the old grant, changing
the DPoP key/device/instance, using an expired grant, or renewing a revoked edge fails closed. Edge
revocation invalidates the access session and every outstanding refresh generation. This preserves
restart and offline catch-up without requiring another QR and without introducing a long-lived
unbound Bearer token.

The DPoP session reads current server-authoritative computer membership from
`POST /api/workjet/device-session/business-os/computers`. Managed Relay then connects exactly those
Environment IDs. Assignment changes take effect without repeating device pairing, and the pairing
path never receives or chooses a Computer/Environment credential.

## Connection projection

The shared connection runtime projects an assigned Code computer as a `RelayConnectionTarget` with
an additive, opaque `businessOsInstanceId`. That field is an authority scope, not a presentation ID
or a label. For such a target, `ConnectionResolver` reads the exact-instance
`WorkjetManagedDeviceSessionAuthorizationProvider`, verifies the Relay issuer, required scopes and
expiry, refreshes current membership, and calls the platform-owned direct-DPoP connect adapter. A
missing session, a mismatched instance, a stale grant, or a computer absent from membership blocks
the connection. None of those cases may retry through Clerk, a primary Environment, or another
Computer.

Targets without `businessOsInstanceId` retain the classic Clerk-authorized cloud path. This is the
only fallback and exists solely for pre-existing, non-instance-bound cloud connections.

Instance-scoped targets are reconciled as `PlatformConnectionRegistration` values from the
server-authoritative membership snapshot. They are not stored in the user connection catalog. This
prevents an older Workjet version from stripping the additive scope during persistence and later
reinterpreting the same Environment as a classic Clerk-authorized target. Disappearing membership
removes the platform registration and tears down its runtime.

The producer persists only the secret-free device-to-instance edge and the two revocable grant IDs.
If either issuer or durable edge completion fails, the other grant is revoked. Issuers are
idempotent by `devicePairingId`, and partial failures remain retryable without creating parallel
grants. List and revoke operate on exactly that edge.

Unredeemed references are revoked by invite ID. A redeemed edge is revoked separately through
`device-bindings/revoke` with its `devicePairingId` and canonical instance scope. Revocation is a
durable `revoking` to `revoked` transition and succeeds only after both the Workjet device-session
family (access plus every refresh generation) and CTOX synchronization grant acknowledge revoke.
Retries resume the same revocation; they never report success while either capability remains live.

## Activation gate

The contract is published by `@t3tools/contracts` and consumed through the platform port exported
as `@t3tools/client-runtime/state/business-os-managed-backend-control`. It is deliberately not
registered on `EnvironmentHttpApi`. Workjet keeps managed device actions disabled until the
following producers exist:

- ctox.dev control-handle and invite/reference coordination with fail-closed rate limiting, CSRF,
  no-store responses, and service authentication;
- Relay device-session grants, versioned instance membership, direct DPoP session authorization,
  and a revocable device-to-instance edge. The producer belongs in the Cloudflare control-plane
  authority, not in a Workjet Environment server;
- CTOX sync invites bound natively to the same device ID and proof-key thumbprint, rather than only
  copying those values into a Workjet-side payload; and
- a retryable coordinator that rolls either grant back when the other issuer fails.

Desktop and Mobile also need platform adapters for authenticated DPoP/CSRF transport and proof
creation. This contract does not activate the separate Computer Membership API; that requires its
own server-attested inventory and backend-host policy producer. Until all producers are available,
ctox.dev must not mint a QR and clients remain visibly fail-closed.
