# Native supervisor control

The Code supervisor UUID is bound to its selected native project through
`project.supervisor.bind`. Submit, watch and cancel use the same selected
Business OS guest and its existing RxDB/WebRTC command bus. There is no HTTP
business-data fallback or implicit local provider turn.

The contracts mirror the installed native `ctox.workjet.supervisor_turn.v1`
response. Desktop validates the operation, project, supervisor UUID, canonical
thread key and, for watch/cancel, the target execution command before returning
the receipt. Task and attempt facts are native observations. This response
does not expose a run ID or a history/event page; those require the authorized
native run/history projection and must not be synthesized from Code IDs.

`submitWorkjetSupervisorTurn` saves `WorkjetSupervisorJournal` before it calls
the native guest. Its journal port must acknowledge the Code server's durable
thread configuration update (`ctoxSupervisorTurn`), not a localStorage write.
After a lost reply, `resumeWorkjetSupervisorTurn` repeats the saved submission
with the exact command ID, goal and target. Once the canonical native turn is
known, resume only watches that turn. Every watch gets a new observation ID
because command receipts themselves are immutable. Neither path starts an
ordinary Code provider as a transport fallback.

The chat integration must persist the journal through the shared thread-state
command, retain it across UI quit, resume it after reconnect, and display
confirmed native results. It must keep the selected instance/project/thread
bound together and must not issue the same prompt to both native CTOX and a
local provider. Native model/execution configuration must be shown accurately;
a Code composer model selection is not proof of the native executor model.

Installed acceptance remains separate: full UI quit, native completion,
reopen with unchanged task/run/attempt, event backfill and a lost-submit reply
on an isolated tenant. Contract and transport tests do not establish these
product outcomes.
