# Instance connection diagnostics and automatic project recovery — 2026-10-10

Owner: Michael. Composer owner: `01a1227e-c0ad-7950-9446-ef5dc0797e90`.
Source base: `64a1d82a9b002695fce350b3698540a6cbe1ac40`.
PR: https://github.com/metric-space-ai/workjet/pull/373. The supervisor merges.

## Finding and repair

The installed 0.0.75 report showed the same instance guest failure beneath both xAI and Claude, next to healthy local gateway accounts. Preparation errors were collapsed into `guest_failed`; the Effect warning did not preserve its stage in the desktop trace. The gallery retained cached projects but required manual refresh after a registry outage.

Instance accounts now share one quiet connection status, reconnect action and expandable explanation. Instance and local-computer account sections are separate. Connection failures retain their typed preparation diagnosis rather than becoming provider/model failures. German and English explanations follow the client language. The local gateway health and account controls are unchanged.

Preparation failures produce an explicit `ctox.guest.preparation.failed` span in `desktop.trace.ndjson`, including instance ID, fixed stage/reason and numeric Electron/HTTP facts. Arbitrary exception messages, URLs, tokens and strings are excluded. An additive contract carries those same classifications to clients. Existing failure codes remain compatible.

The project registry keeps its last successful list and timestamp, retries with capped delays of 1, 2, 5, 10, 30 and 60 seconds, and refreshes on matching guest readiness, network reconnection, focus and existing change events. A successful query resets the retry delay; a 60-second background query also picks up changes from other clients. One query and one timer are owned per selected instance and are canceled on scope change/unmount. The gallery shows a quiet reason and last-update time instead of refresh buttons.

## Measurements and limits

The read-only inspection during implementation found the installed app already at 0.0.76, signed with TeamIdentifier `2HS27B8739`. Its trace contains failed `CtoxInstanceRegistry.decryptSecret` operations and successful Effect spans for `CtoxGuestManager.prepareGuest` (which can return a failed result). Preparation spans have no stage attributes. Public paired Welsch discovery still reports its persisted paired descriptor.

This establishes a stored-pairing read failure in the running desktop, but does **not** identify the stage of Michael's reported Welsch provider failure or prove that the two failures share a cause. The new logger is not installed yet. No speculative keychain, credential, identity or guest-routing change is included. The installed test must reproduce the Welsch account read and inspect the new stage/reason; a remaining connection defect needs a follow-up from that measurement.

All runtime inspection was read-only. No daily app restart, production profile edit, provider check, worker turn or remote command was performed. No Mac lease or app child is retained.

## Verification

GPU lane `workjet-instance-diagnostics-auto-refresh`, owner above, two workers and two allowed CPUs. Run `workjet-instance-diagnostics-auto-refresh-20261010T141040Z` passed 92 desktop tests, 82 web tests and full `vp check`. Full type checking caught two new test-only typing/import errors; both were corrected before final verification.

Coverage includes durable trace emission without an enclosing trace span, rejection of secret-bearing diagnostic fields, preparation-stage propagation, one instance status beside a healthy local account, localized details, typed provider errors, capped retry/cancellation and registry failure-to-recovery without a click. Web and Electron share the provider/gallery UI; contract additions are optional for existing clients. Mobile has no equivalent provider/gallery UI change in this PR.

Final-head checks and their canonical receipt are recorded in the owner's durable evidence directory. Installed acceptance and the actual Welsch preparation cause remain open; unit tests do not establish them.
