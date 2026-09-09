# Project Crew submission from Workjet

The server client exposes `submitProjectTurn` for a persisted Workjet turn and
an existing private CTOX project chat. Its typed request selects text, an external
harness and a bounded timeout. Native CTOX resolves Crew membership and executor
computer from the chat's current project/profile bindings. No module is invented
for a repository project, and the caller supplies no Crew identity or credential.

The existing native request and turn tables store intent before sending. The
same event id reuses its persisted remote retry key after a lost response or
server restart; changed intent, instance, connection or credentials is rejected.
Project receipts use `ctox.project_crew_request.v1` and must name the requested
private chat before command/task references are recorded. App and module receipts
retain their existing module and command-type checks. Status decoding recognizes
native `business_os.chat.task` in the `ctox` system namespace.

This controller contract is separate from the model-facing Business OS tool
union. No menu option or model permission is added by exposing it. The next
integration must invoke it from an authorized, persisted project turn, discover
and claim the native offer, keep its grant in server transport, deliver context
to the selected harness and return evidence. Those execution/UI paths are not
implemented by this change. The native endpoint depends on CTOX PR89.

The focused test uses the real SQL request ledger and reconstructs the client
after a lost response; its remote transport is a double. It checks stable retries,
changed-intent rejection and foreign-chat receipt rejection. It is not native
CTOX interoperability or UI evidence. Local tests/typecheck have not run while
the shared host gate is closed; CI must validate the stacked PR before merging.

`discoverProjectOffers` reads the durable command reference, verifies the original
connection credentials and queries bounded native offer metadata for the supplied
executor computer. The caller must obtain that computer from its authorized
project context. Responses must match command, computer and requested harness.
An unresolved submission returns `awaiting-command`; an empty offer list does not
claim failure or completion. Discovery returns no grant and starts no executor.
Offer claiming, deadline enforcement at execution, secure grant transport and
harness dispatch remain unimplemented. The focused test rejects other command,
executor and harness identities in discovery responses.

`claimProjectOffer` claims an explicitly selected attempt under the original
connection/credential binding. It validates outer command, attempt, executor,
harness and deadline, and inner Crew command/task/attempt/module identity before
returning context. The session is returned as an Effect `Redacted` value in this
server-only API; no raw claim is emitted as a provider event or model result.
This is not yet a configured harness transport. The controller must consume the
grant only for this attempt, enforce the deadline through execution and report
its result. The decoder regression covers invalid bindings, expired grants and
JSON redaction. Tests remain pending CI.

## Claimed-result reporting

A successful claim now returns a server-side `report` capability bound to its original request identity. Before each report it reloads the durable command/task/harness binding and verifies the original connection credentials. The MCP call uses the claimed signed command session at that same endpoint; no caller-selected token or endpoint is accepted. Exactly one non-empty reply or error candidate is sent, bounded against the native persisted JSON UTF-8 size (256 KiB, including its null companion field). The native receipt must identify the claimed attempt and say review is pending. No local completion is inferred and transport writes are not automatically retried. Native lease checks and identical-result retry handling remain authoritative, including retries after an accepted result's deadline.

The transport-double test now covers actual claim/report dispatch through the client and real request ledger, signed-session use, reply/error candidates, wrong-attempt receipts, blank/oversize candidates and changed credentials. These additions have only been formatted and checked with git diff --check; first execution and typecheck are pending CI. Local heavy verification is denied by shared admission (tmp capacity and load). The actual provider controller and secure harness MCP setup still need to invoke this path; this is not an end-to-end execution claim.
