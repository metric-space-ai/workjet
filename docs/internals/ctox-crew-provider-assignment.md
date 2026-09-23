# Crew reservation provider assignment

The native request ledger reserves a Crew attempt before its remote claim.
Reservation input contains the native attempt, command, task, executor and member
IDs. Migration 63 adds a nullable provider instance/thread pair; existing
reservations remain unassigned and retain their original reservation timestamp.

`bindCrewStartProvider` accepts the request identity, the complete native
reservation identity and the selected provider instance/thread. It checks the
request's connection, instance, command and task, then compares every native
reservation ID in the atomic update. Only an unassigned row or an exact replay
can succeed. A missing reservation is never created by this operation. Changing
either half of an existing provider pair fails without replacing it.

Reads reject partial or malformed pairs as reference conflicts. SQL failures
remain store-unavailable errors. Reconstructing the service reads the same
assignment from SQLite; replaying a reservation does not grant a new start.

The assignment records a selection. It does not establish provider session
ownership, authorize recovery, start a harness, or prove native completion.
Those require the execution controller and native admission/review evidence.
