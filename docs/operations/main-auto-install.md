# Main installation controller

The user-session controller in scripts/main-auto-install.py selects the exact
current main commit of metric-space-ai/workjet. Only a successful completed push
run of ci.yml for that commit admits a deployment. A queued run, a green PR run,
a green older commit, or an older successful attempt cannot qualify it.

This is a commissioning candidate, **not an enabled update agent**. The current
operator build/install scripts are release-specific. Their generic adapters and
an installed rollback baseline meeting the ten-second startup requirement still
need qualification. The controller refuses deployment until both are present.
The temporary 0.0.97-pre integration build is not treated as a green main build.

## Execution and custody

Each invocation is one check. The launchd template uses a five-minute interval;
the controller never waits for CI or loops for admission. An exclusive lock
prevents overlap. Deferred decisions can be reconsidered by the next invocation.
Accepted, rolled-back and uncertain in-progress operations cannot be repeated
for the same source. A failing effect adapter is latched rather than rebuilding
it every five minutes. Own receipts are atomically replaced with file/directory
fsync and private permissions.

Receipt location: ~/.codex/task-evidence/workjet/auto-install/<full-main-sha>.json.
The receipt records the main CI identity, safe status codes, candidate hashes
and measured startup facts. Raw provider output and credentials are not copied.
The durable state selects the last **measured** green installation; a known slow
release cannot be silently adopted as a rollback baseline.

The controller runs as the actual logged-in user. It refuses a different HOME
or WORKJET_HOME override. It does not launch Workjet with an alternative profile,
read encrypted sessions/catalogs/cookies, access the keychain, log in, click a
window, use CDP, or force-quit the app. Existing configured credentials remain
with the official providers used by gh and the deployment adapters.

## Configuration

Keep config.json private (0600, owned by the logged-in user). Its fields are:

- enabled: false until supervisor review and commissioning are complete;
- userHome: the actual user home;
- evidenceDirectory: the durable private auto-install evidence directory;
- owner: the authorized Main owner ID;
- python and macGate: absolute paths to Python and dev-heavy-run.py;
- installedAsar: /Applications/Workjet.app/Contents/Resources/app.asar;
- calendarSnapshot: a fresh public calendar export;
- projectIds: the complete set of active project IDs covered by that export;
- afterPullRequests: PRs that must be merged into main before it may replace an
  integration install. For 0.0.97-pre these are [608, 626]. Their actual merge
  commits must be ancestors of the selected main head, including squash merges;

- lastGreenReceipt: a controller-shaped receipt from an actually measured green
  installation, with a retained signed rollback zip and verified hashes;
- adapters: prepare, build, install, verify, rollback and notify. Each contains
  absolute interpreter/script paths and the approved script's SHA256.

No secrets belong in this configuration. Adapters receive two positional paths:
a controller context JSON and a result JSON they must publish. No shell command
strings or command-line secrets are used. Result receipts must be terminal and
correlated to the requested full source commit.

## Existing single-writer adapter boundary

The controller does not introduce another app/service installer. Adapters must
retain the existing protected updater's signature, source, checksum, stable Node,
cold recovery, database writer-drain and ordinary Quit checks.

1. prepare: exact-source build and portable Linux-server preparation through the
   gpu3 lane. This finishes before a Mac lease is requested. Return a terminal
   source-correlated receipt; build consumes that receipt from the context.
2. build: Mac-only packaging and Developer ID signing through the Mac gate.
   Return artifact with signedZip, signedZipSha256, asarSha256, buildVersion and
   signatureVerified. Bind app/server archive versions to the main SHA suffix
   without a version PR. Keep current-server byte verification intact.
3. install: normal protected swap and one ordinary restart. No signals to the
   service tree or unrelated CLI workers. Preserve a verified signed rollback
   and private cold database custody before mutation.
4. verify: read only public bundle identity, app/service state and startup trace.
   Return sourceVerified and measured with appStarted, serviceActive,
   normalRestart, prepareGuestCount, firstSuccessfulProjectListMs and
   invariantErrors. Measure project.list completion from the actual restart,
   not its request duration or a later cached call. Include rotated trace files
   and deduplicate spans so rotation cannot erase the first guest or request.
5. rollback: restore the context's lastGreenReceipt through the same protected
   updater, with one ordinary restart; return appStarted/serviceActive/
   normalRestart. The controller verifies restored ASAR bytes before concluding.
6. notify: deliver the safe failure code and source to the existing supervisor
   thread through its supported installed queue path. Never send credentials.

Build, install and rollback acquire the Mac gate under one stable task name.
A gate exit75 means no adapter ran and creates a deferred decision. An uncertain
adapter timeout gets TERM only on its captured controller, allows 450 seconds
for orderly recovery, and never receives KILL or signals a service tree. An
uncertain operation remains latched for operator recovery.

Self-check requires the app and service running, one prepareGuest, zero Invariant
errors and the first successful project.list completing in **less than 10 s**.
Failure restores the last measured green installation and notifies the
supervisor. A malformed verification receipt also triggers recovery. A failed
rollback is recorded as recovery_required and never retried automatically.

## Calendar gate

The export contains complete=true, generatedAt, validUntil, projectIds and
nextMeetings [{projectId, startsAt, endsAt}]. Timestamps require explicit zones.
It must cover a future occurrence for every configured active project, be at
most six hours old and remain valid. Incomplete or stale exports refuse installs.

Installation is forbidden from two hours before a meeting through its supplied
end (or its start if no end is supplied). This predicate is rechecked immediately
before restart after the build, together with exact main identity and green CI.
For Molecularity on 14 October at 13:00 Europe/Berlin, the boundary is 11:00.
No meeting time is generated or guessed by the controller.

## Commissioning

Copy the reviewed script and private config to a durable user-owned directory;
never reference a disposable worktree from launchd. Substitute the three path
placeholders in scripts/launchd/dev.workjet.main-auto-install.plist. The template
sets no HOME or Workjet profile environment. Do not load it during development.

First run the configured controller once manually; it records a real CI/gate
observation even when deployment is deferred. This is not an installed acceptance
claim. Only a complete protected deployment, measured self-check and rollback
qualification permit the supervisor to enable the agent and load its plist.
