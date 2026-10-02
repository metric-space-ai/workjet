# Native HTTP acceptance

`apps/server/src/workjet/ctox/tests/native-http-acceptance.ts` is an explicit
integration runner. It uses the real Workjet native task client, real HTTP MCP
transport and a file-backed Workjet request ledger. Run each phase in a new
Node process: `first`, `resume`, `revoked`, `stop`, then `verify`.

This covers the server client and ledger. The fixture supplies the connection
target; it does not verify the connection registry, desktop controls, provider
execution, WebRTC, installed app or the count of native task rows.

## Prepare an owned fixture

Use the shared resource admission gate for the complete bounded fixture run.
Require the current native producer's source/pin/build receipt and verify its
binary hash before launching an owned snapshot. Do not use an old binary with
a new source label. Keep the native root, private token capture, ledger and
logs under `/Volumes/tmp/dev-artifacts/workjet/pr73-http-acceptance/<run>/`.
Record the owner, captured server PID/process group, log paths and deadline.

Before creating authority or dispatching project commands, initialize the fresh root
with `ctox business-os rxdb init`, using the existing
`CTOX_ROOT` and `CTOX_STATE_ROOT` overrides and the owned native root as its working
directory. The current init parser rejects trailing `--root`; the controller checks
the returned database remains inside the owned root, `user_threads` is registered,
zero records were seeded and no peer starts. Other native calls retain explicit root.
The supplied source-bound
producer must include that public command. It registers canonical schemas without
domain records or an app and rejects skipped collections. Missing or failed bootstrap
ends the fixture; never create tables directly or substitute a prepared database.

For this isolated local operator, persist the exact native user `mcp:local`
as admin with `business-os desktop invite --user mcp:local --role admin`.
Create the isolated project through native `ctox.workjet.project.upsert` with
that actual owner. Set the native MCP policy's allowed actor to `mcp:local`
and workspace to `local`. These are the public channel's no-context defaults;
the stored native role supplies permission. No caller role or internal command
session grants start rights. This does not establish a human production identity.
Start the
public channel with:

```text
<verified-ctox> business-os mcp serve --addr 127.0.0.1:<owned-port> --root <owned-native-root>
```

The root option is last. Load the generated MCP secret through `secret get`
into a private file with mode `0600`. Its JSON `value` is read privately by the
runner. Keep tokens out of command arguments, environment variables, source,
public logs and receipts. The native channel must authorize the actual fixture
owner; do not invent trusted actor context or bypass a rejection.

Create a private fixture JSON with these fields:

- `workjetSource`: the exact clean checkout revision running this script.
- `nativeSource`, `nativeWorkjetPin`, `nativeBinarySha256`: the verified producer
  receipt identities; the external controller verifies the actual binary.
- `directory`, `nativeRoot`: the owned run directory and its isolated native
  source/state root.
- `serverPid`, `endpoint`: the captured server PID and its loopback `/mcp` URL.
- `tokenFile`: the private native secret JSON capture inside the run directory.
- `scope`: `threadId`, `connectionId`, `instanceId` for this fixture.
- `requestId`: one immutable original turn ID.
- `projectTask`: the real fixture `project_id`, `title`, `instruction`.
- `cancelKey`: one stable key for the explicit native Ops cancellation.

The runner rejects a foreign listener, non-isolated root, non-private secret
capture or a dirty/different Workjet checkout. No native server or domain data
is created by importing the runner; it requires explicit fixture/phase args.

## Execute and retain evidence

For each phase, use the current Node runtime with TypeScript stripping:

```text
node apps/server/src/workjet/ctox/tests/native-http-acceptance.ts <private-fixture.json> <phase>
```

A separate readonly SQLite connection checks the committed request before
every HTTP request, including discovery. `first` discards one real accepted
start response before it can enter the Workjet receipt ledger. This is a
controlled transport-boundary fault, not an observed network outage. `resume`
reopens the ledger in a fresh process and requires the same native IDs/key.
Changed intent and instance scope must fail without HTTP calls. The first
phase also verifies the real default actor/workspace and exact allowlists,
HTTP 401 for missing/wrong bearer, and native rejection of foreign actor or
workspace context. Negative probes require the specific native denial; a
network failure is not a permission pass.

Before `revoked`, use the same supported native invite command to change the
stored `mcp:local` role to `user`. This phase reopens the existing ledger without
replaying a write, attempts cancellation with a deliberately false `admin`
claim, and requires the actual management denial and unchanged task state.
Restore the native role to `admin` before `stop`. Positive task/status/stop
requests never invent actor context.

`stop` calls the explicit public native Ops cancellation with the original
command and stable key, repeats it and requires an identical receipt. `verify`
reopens the ledger again, replays the original start and requires the same IDs
and a cancelled status. Closing a Workjet process is never the stop action.
The cancel key comes from the fixture; this does not claim a separate Workjet
cancellation ledger or GUI stop acceptance.

The bounded controller `scripts/native-http-acceptance.py` prepares a fresh
source clone, native authority/project/policy, owned HTTP server and private
secret capture. It verifies a supplied current producer receipt, binary hash,
clean source and an actual own shared lease before creating anything. It awaits
the server's emitted readiness line and runs all five phases in separate Node
processes, downgrading/restoring the real role through native authority. The
complete unit has a 600 second deadline and captured process groups; it removes
private plaintext captures and a clean owned native fixture after terminal cleanup.
Run it through the shared admission gate, supplying explicit source identities
and the native producer receipt:

```text
greppy bash-smart -- /usr/bin/python3 /Users/michaelwelsch/.codex/bin/dev-heavy-run.py --owner 01a0879f-e692-7361-858c-036208dc53f7 --project workjet --task pr73-native-http -- python3 scripts/native-http-acceptance.py --workjet-source <clean-head> --native-source <producer-head> --native-workjet-pin <native-pin> --native-receipt <producer-receipt.json>
```

Preparing this controller does not mean its native bootstrap or HTTP phases
have passed. Do not run it against the old daemon with a new source label.
The first admitted run at Workjet `a969489555` and native `1538a4c2ca` passed
admin invitation but failed project dispatch because `user_threads` was not
initialized. No HTTP phase ran. That failure remains evidence of the fresh-root
gap; the new explicit init requires a new verified native producer receipt.

Retain all five phase receipts, source/binary fences and the captured server
cleanup proof. A failed phase is a finding. Do not weaken the assertion, add
automatic write retries, forge an actor, or claim a pass from a prepared runner.
Stop only the owned captured process tree, await terminal completion, and
remove owned disposable fixture data after durable evidence is preserved.
