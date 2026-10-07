# Native Supervisor execution pages

Workjet reads the selected CTOX guest's opt-in
`ctox.workjet.supervisor_execution.v1` page through the existing typed
`project.supervisor.turn.watch` control and RxDB/WebRTC bridge. This consumes
CTOX PR398's shared fixture and browser bridge (79c18bb03); it grants no
execution authority and adds no HTTP data path.

The outer request uses `executionPage`. The response adds
`executionContract` and `executionPage` only for that request. Inside the
page, the native fixture's snake_case names are preserved. Legacy watch
receipts retain their original shape.

`readWorkjetSupervisorExecutionPage` reads one page, validates its native
command/task/attempt, event ordering and cursor, then saves the confirmed
turn through the caller's persisted journal port. It never submits a turn.
`nextWorkjetSupervisorExecutionPageRequest` anchors the next bounded
25-event watch to the same actual attempt and last native event. The caller
owns visible rendering and further requests; there is no background loop.

Only native attempt/run/event IDs are shown. The turn's queue attempt counter
and the execution attempt's index are separate facts. A queued turn may have
no attempt. The run ID is optional until the native producer has a durable
record for it; Workjet never substitutes an attempt or command ID.
Raw tool arguments, full outputs and private metadata are rejected.

An older guest that returns only the legacy watch receipt for an opted-in
request yields `unsupported`. Invalid or foreign receipts fail without
persisting their facts. An expired native cursor must be reset explicitly;
the caller can backfill the same saved turn from an empty page request.

Source tests are not installed acceptance. Goals8/9 require the installed
native producer and Shell, the normal Workjet release with the Supervisor
composer, an actual task, full UI Quit/Reopen and an isolated-tenant
lost-submit test. Missing active run identity remains a measurement limit.
