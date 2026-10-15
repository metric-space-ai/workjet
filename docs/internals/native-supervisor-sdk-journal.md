# Original Supervisor SDK observations

ClaudeAdapterLiveOptions.createNativeSupervisorSdkJournal is a private Node-service construction option, outside settings and RPC. It creates one journal per actual thread/query. A custom createQuery override is rejected when this option is present: test/replaceable query fixtures cannot attest an original SDK process.

The adapter captures the ChildProcess object from its own actual SDK spawn callback, observes the actual system init before handling messages, records its actual sendTurn ID, and extracts parent assistant message.id/model/uuid and result uuid/session_id/subtype/is_error before the canonical result handler clears the current turn. Subagent assistant messages cannot supply the parent's model/message anchor. A changed or missing original SDK init/session fails the observed stream.

Each journal belongs to one original controller turn. Steering the same turn does not append another turn-submitted event; a different turn, duplicate init or post-result parent message fails. Subagent assistant messages are ignored even when their session differs.

The private NativeSupervisorSdkObservation v1 records use monotonic sequence 0 through 511 (512 records, matching the native private journal limit) and these kinds:

- child-spawned: pid
- child-closed: pid, exitCode, signal (the captured child's actual close event, including stdio closure)
- sdk-init: sessionId, initId
- turn-submitted: turnId (application control correlation, not a native SDK UUID)
- parent-assistant: sessionId, turnId, messageId, messageModel, assistantId
- sdk-result: sessionId, turnId, resultId, subtype, isError
- sdk-stream-joined: actual stream consumer/iterator has joined
- sdk-query-close-returned: actual query.close returned successfully

The service-owned sink serializes/persists these bounded metadata observations under its original retained Source/controller. It must never store model/account credentials, prompt/tool bodies or claimed authority in this journal. SDK init's requested model is deliberately absent. The real parent message model/id must join native HTTP observations; result/session/turn, nonempty captured SDK PIDs, child close and consumer/query/event drain must all be validated independently.

createNativeSupervisorSdkSourceJournal maps the private actual callback records to the native sdk_observe envelope under the same retained original Source transport and offer/controller IDs. Null child-close exit code or signal is omitted on the wire, as required by the generated native fixture. Each append has a fresh IPC request correlation and its original observation sequence. The direct native acknowledgement must be sdk_observed for that exact sequence with execution_ready:false and no extra fields. Unavailable, ambiguous IPC or malformed acknowledgements fail without retry, replacement controller or authority claim. This follows the fixture in CTOX PR #570; its native result/model join is a separate obligation.

The failure promise exposes the first actual sink, session or bound violation to the service owner. Such a violation invalidates the session getter and cannot become a successful drain. A child-close callback that reaches the observation limit records failure without throwing into Node event dispatch.

drain requires a caller-owned AbortSignal and awaits every captured actual child close, the stream/query callbacks and the serialized sink. Empty PIDs, a terminated DTO, interrupted sink or missing callbacks cannot stand in for this drain. This is observation plumbing, not service activation or native completion permission. Default adapters have no journal and keep their existing path. Original Source runtime locator, durable sink/holder, SDK-only broker/tool bridge and native result assembler remain integration obligations. No actual model or installed B3/B6/Molecularity pass is claimed.
