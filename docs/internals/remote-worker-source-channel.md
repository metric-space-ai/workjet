# Worker source connection

A remote worker uses a dedicated source Node service listener, not the desktop
client environment relay or a source operator pairing token. The source service
owns the listener and registered SSH reverse forward for the whole worker lease.
Closing Electron does not own or release either resource.

`openManagedWorkerSourceConnection` accepts an immutable source/target/request
identity and digest. Its resolver must recheck the saved SSH profile, native
computer assignment and target environment identity. The registered target
reserves the remote loopback port and verifies the capability route over that
forward before the connection is returned. Only the resulting worker route is
delivered to that target; the source listener port is never a public endpoint.

The route allows `admit`, `bindModel`, and `infer` for that one worker identity.
Before every bind or inference, the listener invokes current admission. Handlers
must validate the complete native receipt and payload and honor the abort signal.
No Owner MCP bearer, provider credential or general Workjet session is delivered.

Revoke, expiry, service shutdown and SSH loss invalidate the capability and abort
in-flight calls. Source restart fails closed. The connection emits
`WorkerSourceReconnectRequired`; recovery must resolve the registered target and
current native authority again. It does not retry inference automatically, since
an acknowledgement may be lost after the upstream operation commits. Native
admission and receipt operations retain their original immutable request identity
when the owner reconciles that lost acknowledgement.

Verification is scoped to `RemoteWorkerSourceChannel.test.ts`,
`packages/ssh/src/localForward.test.ts`, and `packages/ssh/src/reverseForward.test.ts`.
Installed UI-quit acceptance belongs to the integrated worker chain owner.
