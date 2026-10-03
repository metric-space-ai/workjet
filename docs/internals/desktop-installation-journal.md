# Desktop installation journal

The Desktop main process owns installation attempts on its local machine and
approved SSH targets. Network membership is owned by native CTOX Sync; an
installation receipt does not admit a worker, prove a quorum, or certify a
harness. Mobile enrollment and the native signaling grant are still separate,
unfinished product integration work.

## Durable request and result

An approved preflight ID is also the installation operation ID. Desktop records
the normalized action, components, channel, public target and initial snapshot
before launching a subprocess. Repeating that preflight with the same request
returns its existing result. Changing it is refused. Concurrent identical
requests publish exactly one launch decision.

The journal lives inside the profile's private `stateDir/ctox/provisioning`.
Each record is schema-validated and published as a complete file after syncing
its contents. Initial publication is exclusive; subsequent snapshots use atomic
replacement. Unix directory entries are synced too. Credentials, scripts,
passwords, invites and SSH secrets are excluded. The Desktop provisioning service
holds one journal session for its lifetime; it is not constructed separately for
each IPC call. A foreign session's target can still be running: an unknown result
is not evidence that the installer stopped. The existing volatile operations Map and automatic 24-hour deletion are
removed. The journal is the source of installation status, not a parallel cache.

A new Desktop session projects queued/running records from the former session
as `interrupted/outcome_unknown`. It never resumes their subprocesses or
generates fresh IDs. Completed results remain completed. A failed command is
also uncertain: a remote target can already have changed before disconnection
or a nonzero exit. Checking the target and explicitly approving a new preflight
is required before another attempt.

Unreadable or malformed records remain intact and return a visible journal
error, never `not_found`. A write failure stops status reads and new requests
for that session so an older `running` snapshot cannot masquerade as current.
After restart, the last durable record is recovered as above.

## Product connection

The typed Desktop IPC includes `listProvisioningOperations`, which returns the
50 most recently updated installations with their public target. Computers
settings displays saved installations after mounting and allows inspecting
their events. Unknown outcomes receive a warning and no perpetual running
spinner. Existing installations are not automatically retried when opening
settings, polling fails, or Workjet restarts.

This journal records local installation effects only. It is not the future
distributed enrollment command journal: native admission still requires an
authorized voter, proof of the worker key, a persistent native request ID and
the current quorum-confirmed membership decision.

## Validation and remaining gate

The focused journal suite uses actual files, concurrent requests, a separate
Node process, malformed persisted data and an induced storage failure. It
measures durable creation and listing latency separately from networking,
installation and Business OS command latency.

Full Electron UI evidence, OS recording and independent review are required
before accepting the visible restart story. A real SSH installation followed by
native admission and a real QR/link admission over public signaling remain
unverified. These checks must not be replaced with a rendered component or this
journal suite.
