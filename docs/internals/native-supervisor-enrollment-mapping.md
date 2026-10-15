# Managed native Supervisor enrollment mapping

The source service must resolve the selected registered computer and Business OS
through their existing registries. Its managed runtime supplies the actual
installed CTOX executable and the original native enrollment root explicitly.
A desktop instance ID, remote daemon root, SSH profile, label, or guest credential
cannot supply those paths or the original encrypted account target.

`NativeSupervisorSourceEnrollment` is a private server service. It has no
WebSocket/renderer operation and does not enroll, assign, rotate, or copy an
account. It uses the existing protected `ServerSecretStore` and retains only
the explicit managed locator, registry selection, and non-secret original native
enrollment identity.

The native contract is
[ctox#566](https://github.com/metric-space-ai/ctox/pull/566), initially inspected
at `35a4f92ad`. Integration requires its qualified delivery; this mapping
alone proves neither native transport readiness nor execution readiness.

## Managed consumer sequence

1. Obtain the exact registered computer/environment and ready Business OS
   connection. Supply its presentation instance ID and the separately resolved
   canonical native instance ID. Never derive the latter from the former.
2. On first protected setup, call `prepare(selection, runtime)` with the actual
   managed executable/root. This creates no persisted enrollment and launches
   no process. On restart call `resolve(selection)`; absent/corrupt mappings
   fail with a bounded reason. There is no default executable, root, or account.
3. Call `nativeSupervisorSourceArguments(plan, privateIpcDirectory)` and spawn
   `plan.runtime.ctoxExecutable` directly with that argument vector:
   `sync supervisor-source-selected INSTANCE COMPUTER IPC_DIRECTORY --root ROOT`.
   The managed consumer owns the child and private directory across UI Quit.
4. Read the bounded startup JSON from that retained native child. Verify the
   actual private endpoint and process lifecycle in the transport owner, then
   call `retainStarted(plan, startup)` before publishing/using the connection.
   This checks the native instance/computer, original account target and pin,
   account/actor epochs, Owner, pairing, device, and proof-key thumbprint.
   Missing or changed association fails closed; retire the owned child on
   failure. The native selected serving command resolves and retains one
   existing enrollment in a single process, avoiding a lookup/start substitution.
5. Native peer generation, socket endpoint and current computer/pairing revisions
   are process observations. They are never stored as durable execution authority.
   Every operation still uses the genuine native receiver admission/lease guards.

A mapping is immutable for a computer/environment/connection. An executable,
root, canonical instance, original target, pin or principal change cannot
silently replace it. Concurrent first writers must agree; the store uses
exclusive creation. Computer or connection changes during startup/storage are
checked again before the service returns. A failed publication can leave an
unusable private record, never a ready connection.

Re-enrollment/revocation maintenance and explicit migration of an original
runtime root remain separately owned protected operations. This service offers
no deletion/rotation fallback and does not manufacture their policy.

## Integration boundaries

The locator producer must own the actual native install/root; public settings do
not select an arbitrary executable or filesystem root. A caller must not feed
model output or renderer-supplied startup facts into this private service.

Harness owns child/IPC framing, same-user private endpoint verification,
publication fencing, drain/stop, and the genuine SDK/controller lifetime.
This service returns sanitized non-secret startup facts for that retained child;
it does not return an SDK witness, admitted consumer authority, lease or completed
turn. It does not wire a new producer into the running application.

Source tests cover persistence, current registry selection, malformed paths,
missing configuration, wrong native facts, immutable enrollment and runtime
binding, concurrent first writers, restart, corrupt storage and publication
races. Installed Molecularity/gpu3 and Quit/reopen acceptance remain separate.
