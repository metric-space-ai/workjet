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
