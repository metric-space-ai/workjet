# Recovering a rejected worker dispatch

A rejected worker start can leave source worth preserving. Workjet returns an
error with recovery locations when it has moved a checkout out of active use.
This is retained recovery data, not a completed cleanup or a durable archive.

The checkout remains beside its original location with a
`.workjet-rejected-<inode>` suffix. Its Git administration data is kept separately
under the repository's `.git/workjet-rejected/` directory. Neither tree's file
contents are deleted. The original branch is removed only if it still points to
the commit captured before the attempted dispatch.

The administration directory contains `workjet-rollback-receipt.json`, recording
original and recovery paths, directory identities, original branch and commit.
The accompanying `workjet-rollback-progress.jsonl` records completed move phases.
An interrupted move can leave the checkout in recovery while the administration
data remains at its original location. Errors include original checkout/admin locations and mark recovery targets as
`candidate` until the helper verifies both moves. Candidate directories may be
missing or belong to another recovery. Inspect the original admin path first;
if its receipt is absent, validate the candidate receipt and paths against the
recorded identities. A timeout can occur after both moves but before acknowledgement. Inspect both
locations in the receipt;
a missing success result must never be treated as completed recovery. A partial
final journal line is not a completed phase.

The recovered checkout's `.git` link still names the old registration. Do not
start another worker against it or treat it as a ready worktree. The owner must
inspect retained changes and transfer useful source to a valid durable checkout,
then commit, push and open/update its PR before disposing of recovery files.
Keep the original commit/ref receipt until that preservation is verified. If a
late editor still holds a file open, close/save it before copying the final data.

On Michael's Mac, `/Volumes/tmp` may be wiped within four days or sooner.
Recovery there needs prompt owner disposition and durable source preservation;
metadata on another disk does not preserve the checkout's contents. Workjet does
not automatically expire or delete these retained files.

This behavior covers rejected dispatches. The separate post-merge cleanup path
still requires quiescent source; its current recursive remover does not exclude
an unrelated writer editing content after the final clean-status check. That
limitation remains owned by the Workjet parent and is not fixed by quarantine on
the rejected-dispatch path.
