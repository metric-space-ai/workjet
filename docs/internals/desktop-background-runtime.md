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
does not yet supply a pinned standalone Node executable for Desktop,
authenticated attachment, reconnectable telemetry, or native reconciliation.
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
without issuing a credential. This closes a prerequisite identity gap in the
existing discovery path; a public descriptor comparison is **not** authenticated
attachment, proof of the same process generation, or protection against a
replacement between discovery and use. Those checks still belong in the live
authenticated attach exchange, under exclusive profile ownership.
There is no measured completion date yet. A source patch, successful build or
external-server demonstration alone cannot close this outcome.
