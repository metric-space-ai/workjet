# Desktop-independent provider execution

Status: implementation in progress on PR73 (2026-09-26), not a claim of
delivered full-Quit behavior. The macOS service adapter described below is
source-only; Desktop still owns and stops its current backend processes.

## Current ownership

`DesktopApp` stops every member of `DesktopBackendPool` on full application
shutdown. `DesktopBackendManager.stop` closes its process scope, and
`ProviderService` finalizes its owned provider sessions. Closing the last macOS
window is different from quitting the application.

`DesktopBackendConfiguration` currently launches the bundled server with
Electron's executable in Node mode. It supplies a per-process bootstrap token
and telemetry channels through inherited descriptors 3, 4 and 5. The token is
held in a `SynchronizedRef`, not an attachment credential that survives a new
Electron process. Merely omitting `stop()` does not supply a stable process
owner, safe upgrade, durable authentication or a reconnectable telemetry link.

`CtoxAdapter.stopSession` ends only Workjet's observation of native work. CTOX
owns the native intent, run, attempt, approvals, cancellation and result.
External Workjet servers also have their own process owner. Neither case proves
that a Desktop-owned provider survives full Quit. CTOX's bounded pi-sidecar
lifecycle remains a separate contract.

## Required implementation

1. **Move the local server under a service owner.** Extend the existing
   `cloud/bootService` and pinned runtime/launcher protocol instead of adding an
   independent job scheduler. BootService now has a macOS user LaunchAgent
   adapter alongside Linux/systemd; Desktop integration is still missing.
   Windows needs an explicit supported
   service owner before advertising this guarantee there. Use a durable pinned
   runtime, not a mutable application-bundle executable or a temp worktree.
   The service owns provider child processes and logs. Desktop is its client.
2. **Attach to one authenticated server.** Scope service identity and the
   exclusive owner lock to the canonical Workjet home/profile. Reopening must
   authenticate and validate the same environment ID, protocol/source version
   and service generation before attaching. A stale descriptor, port collision
   or uncertain owner must never trigger a second server against the same DB.
   Reuse protected server credentials and existing pairing/secret-store paths;
   do not persist a raw desktop bootstrap token in a world-readable descriptor.
   Replace inherited telemetry pipes with an authenticated reconnectable channel.
3. **Separate detach from stop.** Normal full Quit releases UI observers and
   client resources, while the service stays owned and observable. Explicit
   service stop, update and uninstall remain distinct operations. Native work
   cancellation requires CTOX's acknowledged command, not UI exit. For updates,
   reuse launcher protocol 2's staged version and DB rollback path, and record
   whether the service is intentionally stopping or replacing its child.
   A restored Workjet DB snapshot is not authoritative for native offers,
   approvals, cancellation or terminal/outbox state. Before replaying any
   command, reconcile against the current CTOX intent/run/attempt and terminal
   state, and reject writes from stale service generations/controllers. A
   native task completed during the outage must not be offered or run again.
4. **Reconcile through existing durable authority.** UI attachment reads the
   existing server projection and native run/attempt records. It cannot create a
   new Crew offer or replay a prompt because a view reopened. Pending approvals,
   completion/outbox replay, cancel acknowledgements and controller fencing stay
   tied to the actual attempt. CTOX is the durable authority; Workjet does not
   mint a competing lease or declare native completion from process exit.

No native architecture change is needed to implement the macOS service adapter,
authenticated attachment boundary or detach/stop distinction. Native stale-
controller rejection and approval/cancel/result reconciliation require Crew's
exact command/attempt contract; until that is verified, those guarantees remain
open. Service/host failure is not equivalent to UI disappearance and must have
separate recovery evidence.

## Verification and ownership

Workjet owns implementation on the existing PR73. Crew owns the native control
contract and paired tenant release; DevOps independently reviews the result.

First proof must include the **desktop-originated, now service-owned** provider:
record exact builds, service owner and runtime handle plus durable
intent/run/attempt; start bounded work; normally Quit the isolated app; prove
Electron exited and work progressed through the runtime authority; relaunch the
same isolated profile and see the same run/result with no second launch.
External/native-only rows are additional coverage, not substitutes. Follow with
pending approval, acknowledged cancel, connection loss, stale-controller fence,
terminal replay, then service crash and host restart as distinct rows. Include
launcher rollback to an older Workjet DB while CTOX has a newer terminal or
approval state: restored client records must not replay stale work or decisions.

Do not use the installed UI runner's `restart` action for the survival proof: its
`closeElectronProcessTree` captures descendants and terminates survivors after
closing Electron. That cleanup can kill a correctly independent harness and
confound the result. Use a visible normal Quit and independently owned runtime
observation; clean up only recorded test-owned processes after evidence capture.
Never perform this experiment on the user's protected live app/profile.

## Effort and dependencies

The remaining implementation comprises three separately reviewable blocks:
service installation/upgrade/ownership, authenticated attach and telemetry,
then client detach/reconciliation with focused lifecycle tests. The first two
are Workjet-owned source work and are not blocked by a general native
architecture pause. Full control/recovery acceptance depends on the specific
Crew contract above. Each block needs focused verification; the complete user
journey needs admitted host capacity and an isolated exact-build runtime.
The first source block adds a profile-specific macOS LaunchAgent to BootService:
canonical profile paths determine stable labels, argv and XML values are
escaped independently, the existing pinned runtime/launcher protocol is reused,
and update/uninstall require a successful bounded `launchctl bootout --wait`.
The adapter probes support for `--wait` before installation and fails closed
on an unsupported or uncertain stop. Pending launcher updates survive repair.
CLI status/onboarding explicitly limit its lifetime to the user's login session.

This is a service-manager foundation, **not** desktop/runtime decoupling. It
does not yet provide authenticated Desktop attachment, reconnectable telemetry,
or native reconciliation.
Portable server packaging now stages the existing checksum-pinned Node 24.13.1
distribution, matching the platform/architecture and native-dependency build.
The archive includes its executable, npm, license and runtime provenance receipt;
the build installs dependencies and runs the existing CLI/PTY smoke checks with
that exact bundled executable. This build path is implemented but not executed
on this source head. Service install/update/status now accept an explicit trusted
`--bundle-archive` together with `--bundle-sha256`. Import hashes a private copy,
checks package layout/version/required regular files, validates the staged CLI,
and publishes into the existing pinned runtime layout. A matching content receipt
permits reuse without the original archive; conflicting same-version content or
an incomplete existing bundled version is preserved and rejected. Both npm and
bundled installs hold the same profile-specific `installation` lock, including
self-update from another process. BootService selects the imported Node and
launcher, never a caller's mutable launcher override for a bundled install.
These paths and tests are source-only and unexecuted. The digest is a trusted
release input, not authentication derived from an arbitrary adjacent checksum.
The CLI now exposes hidden `__desktop-target --base-dir` JSON discovery restricted
to a modern userdata profile and literal loopback HTTP origin, without creating
an auth database. Existing `auth session issue --json` accepts paired
`--local-environment-id` and `--local-runtime-instance-id` guards: the saved
profile identity and current descriptor/generation must match before auth store
initialization. Partial guards and explicit dev redirection fail closed; ordinary
offline CLI auth retains its existing behavior. Session revocation accepts the
same guards. Public discovery is still not
authenticated readiness, and the probe-to-issuance interval is not a native fence.
The main-local credential store uses existing Electron safeStorage with a
redacted in-memory token and canonical-profile/environment binding. Atomic
ciphertext replacement and fsync avoid plaintext files; keychain/decode/binding
failures preserve the record instead of resetting it. Linux basic-text protection
is refused and protection can be checked before issuing a session. Session removal requires the expected saved session ID and the caller
must first revoke it on the server. Store tests use a cryptography double; no real
keychain, enrollment or Desktop restart has been exercised.
`DesktopLocalEnvironmentAuth` now calls one main-owned local session service for
packaged macOS/Linux native loopback backends. It discovers the canonical profile
through the bundled CLI, checks the expected origin and server version, opens
one protected store per profile, and enrolls only when no credential exists.
Before issuing, it exclusively creates and fsyncs a non-secret profile-bound
pending receipt. Its attempt ID becomes the session's administrative subject
(`workjet-desktop-enrollment:<id>`), allowing explicit outcome reconciliation.
A lost, truncated or timed-out issuance reply retains that receipt and blocks
another issue, including after Desktop restart. The receipt is cleared only
after the protected credential is saved or its known session is revoked; a
different or malformed receipt is preserved. There is no age-based deletion.
Every reuse obtains a fresh target and verifies its environment, runtime generation
and version over the existing authenticated RPC session before releasing the token
through the existing bearer IPC. Closing that temporary validation connection
does not close the backend. Enrollment is serialized across windows; failed
validation/save attempts revoke the newly issued session, including interrupted
or timed-out saves. Read/OS-protection failures, expired credentials and rejected
existing sessions fail without silently creating replacement access. Explicit
user recovery/re-enrollment and pending-outcome reconciliation UX is still owed
before release. Development, WSL,
Windows and non-loopback bindings retain the process-bootstrap path; its in-memory
cache is now scoped to the active configuration. This integration and its tests
are unexecuted. RPC identity checks do not authenticate a malicious listener merely
because it can echo public identity fields, and are not a native authority fence.
Desktop still needs to select its matching shipped archive and invoke this path;
it currently continues to launch the old Electron-owned backend. No power-loss
durability or host-restart guarantee follows from an install sentinel.
The subsequent ownership block uses separate, retained SQLite lock files under
the canonical profile's `runtime/ownership`: the server holds `runtime` before
building any persistence/reactor layers and through their shutdown; the launcher
holds `launcher` for its lifetime, and takes `runtime` during database snapshot
or restore after its child has stopped. BootService serializes administrative
commands with `administration` and requires `launcher` exclusion before changing
mutable service files. Starting the new launcher occurs after releasing that
mutation lock. Contention fails without PID/mtime-based takeover or file deletion.
These are process-lifetime locks, not CTOX authority leases or native fencing.
They require participating binaries: migration from old unguarded processes
must stop those processes before adopting the new runtime. Filesystems must
support SQLite locking; shared network profile storage is not certified.
The common persistent SQL layer takes shared admission on a separate lock keyed
by the canonical database path, including CLI auth/pairing clients. The launcher
requires exclusive admission while copying/restoring the database and sidecars.
This closes the offline-CLI gap in runtime-only exclusion. In-memory databases
do not need filesystem admission. Dangling database symlinks fail closed rather
than changing lock identity when their target is created. External SQLite tools
and old clients do not participate and require a quiesced maintenance window.
The mechanism uses [SQLite transaction locking](https://www.sqlite.org/lang_transaction.html),
not a heartbeat or timestamp-based lease; actual execution proof is still owed.
No service is installed by this source change. Service adapter tests use a fake
process runner and real isolated files. Ownership tests exercise real SQLite,
profile aliases, independent profiles, failure release, a competing subprocess
and abrupt exit, plus refusal to restore under a manual runtime's ownership.
They are authored but not yet executed and cannot prove full-Quit behavior.
An installed-but-unloaded job currently fails closed during repair/uninstall
rather than interpreting an arbitrary launchctl error as proof of absence.
Status compares installed artifacts; it is not a runtime health assertion.

Next source block: verify profile exclusion and add a durable,
authenticated attach boundary, followed by Desktop's explicit attach/detach
wiring. The actual macOS lifecycle and same-run proof remain dependent on an
isolated exact build, admitted host capacity and the native contract above.

The existing CLI pairing discovery now compares the responding environment ID
with the saved profile ID before opening the pairing store. PID liveness and
a valid public descriptor alone cannot distinguish a reused port/process from
the intended profile. Missing, empty or conflicting identity fails explicitly
without issuing a credential.

Each new `ServerEnvironment` lifetime now creates a fresh `runtimeInstanceId`.
It is constant across descriptor reads and recorded in the runtime-state file
after activation. The durable environment ID stays unchanged across restarts.
Pairing compares both generations before opening its store. Different values,
including one missing value, refuse pairing without minting a grant. Legacy
pairing remains supported when neither the descriptor nor state advertises a
generation. Future durable Desktop attachment must require a generation rather
than taking this legacy path. The new field is optional in the wire schema so
existing web/mobile clients and older server descriptors remain decodable.

The shared connection path now retains a discovered generation through primary
Desktop, saved bearer, SSH and relay preparation. Before `RpcSession.ready`
succeeds or `initialConfig` is published, the configuration returned on the
authenticated WebSocket must match the expected environment and, when present,
the generation prepared for that attempt. A wrong environment blocks the
connection; a changed or missing expected generation requires a fresh attempt.
The supervisor withholds the prepared HTTP connection as well as the RPC session
until readiness, so snapshot/session consumers cannot race the identity check.
No generation is persisted as a pin for later reconnects. Modern bearer
descriptors are reread per attempt rather than reused from the ten-second
legacy cache; cached relay credentials obtain a current descriptor after their
fresh WebSocket ticket. This adds one descriptor request on cached relay
reconnects, without another relay bootstrap or token exchange.

This rejects a different runtime between discovery and the initial RPC response.
It still does not prove a trusted local service owner, native execution fencing,
credential persistence across Desktop Quit or full authenticated Desktop
reattachment. Legacy connections without a prepared generation validate only
the environment ID; the durable Desktop attachment path must require a generation
from trusted profile state. Authored tests cover live HTTP pairing mismatch,
generation stability/renewal, token-cache reconnect preparation, propagation
through all brokers, and WebSocket readiness refusal with scope cleanup. The
runtime-state roundtrip test supplies a literal generation; it is not a running
server descriptor/state integration test. These tests have not yet been executed.
There is no measured completion date yet. A source patch, successful build or
external-server demonstration alone cannot close this outcome.
