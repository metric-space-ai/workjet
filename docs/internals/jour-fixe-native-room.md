# Native Jour fixe room

The project overview and calendar open the selected project's native meeting. A read goes through the existing selected CTOX guest and `project.jour_fixe.meeting.read`; the Shell sends the typed Business OS command over its existing data channel. Workjet does not add an HTTP meeting or file bridge.

The wire schema and regression fixture follow `ctox.workjet.jour_fixe.v1` at CTOX #401/#409. The desktop checks command, project, explicit meeting ID, child meeting IDs, safe integer bounds and displayable dates/timezones before exposing a snapshot. Implicit absence renders an unprepared state; an explicit missing/foreign meeting is an error. The read alone has a bounded 1 MiB metadata ceiling, matching the native meeting ceiling; other project responses keep their existing 256 KiB limit.

Start/end, Owner text and proposed To-do revisions use native receipts. An uncertain action retains the exact command, operation and payload. The room keeps that action pending and its input frozen, and exposes **Retry change**. An acknowledged mutation whose follow-up read failed is not written again. Completion, clearing the draft and displaying the new state occur only after a correlated receipt plus a sufficiently new explicit meeting read. Closing or switching the scope rejects the waiting UI action; a late receipt cannot update another project or instance.

Audio references remain metadata and are not converted to URLs. Native speech transport, authorized file playback, comment writes and To-do confirmation are separate follow-ups; unsupported controls are absent. Native #401/#409 must be merged and installed before this UI can read or mutate a production meeting. The fixtures and unit checks are not installed acceptance.
