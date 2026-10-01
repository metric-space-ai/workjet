# Native HTTP acceptance

`apps/server/src/workjet/ctox/tests/native-http-acceptance.ts` is an explicit
integration runner. It uses the real Workjet native task client, real HTTP MCP
transport and a file-backed Workjet request ledger. Run each phase in a new
Node process: `first`, `resume`, `stop`, then `verify`.

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

Create the isolated owner and project through native APIs. Enable the native
MCP policy for that owner/workspace through its supported CLI. Start the
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
Changed intent and instance scope must fail without HTTP calls.

`stop` calls the explicit public native Ops cancellation with the original
command and stable key, repeats it and requires an identical receipt. `verify`
reopens the ledger again, replays the original start and requires the same IDs
and a cancelled status. Closing a Workjet process is never the stop action.
The cancel key comes from the fixture; this does not claim a separate Workjet
cancellation ledger or GUI stop acceptance.

Retain all four phase receipts, source/binary fences and the captured server
cleanup proof. A failed phase is a finding. Do not weaken the assertion, add
automatic write retries, forge an actor, or claim a pass from a prepared runner.
Stop only the owned captured process tree, await terminal completion, and
remove owned disposable fixture data after durable evidence is preserved.
