# Calendar

In the desktop host, account calendars use the selected instance's authenticated
Business OS guest through `project.calendar.accounts.read` and
`project.calendar.events.read`. The shell sends the typed read over the
`communication_accounts` WebRTC lane; the native peer derives the actor from its
capability and keeps canonical owner/shared-mailbox authorization before and
after provider I/O. No extra external MCP registration or credential is created.
Replies are correlated to the command, account and date range, and changing the
instance or leaving the calendar fences late replies. Other hosts retain their
explicitly registered MCP calendar connection.


Workjet's calendar provides Day, Week, Month and Year views, a mini month,
calendar visibility controls and an All projects/per-project selector.

Project regular meetings are expanded from each project's jourFixe rule in
its configured timezone. The rule currently has no duration, so their one-hour
height is a display convention. Native sessions are read through the existing
authenticated session-control bridge. Only recorded createdAtMs is a session
start; missing starts are reported and never inferred from an update time.
Sessions with unknown project IDs are omitted.

## Connected account calendars

The Workjet server calls business_os.calendar_accounts and
business_os.calendar_events through the authenticated CTOX MCP connection for
the selected instance. It resolves the connection on every call and never takes
an endpoint, token or actor from renderer input.

CTOX reads the registered mailbox configuration and enforces native module,
collection and record policy. Only the authenticated user's own or explicitly
shared accounts are returned. Verified managed identity aliases use the same
canonical owner. Ownerless and foreign mailboxes remain inaccessible, including
to administrators. Revocation is checked again before returning provider data.

The current provider read path uses EWS CalendarView or Microsoft Graph
calendarView, including recurring occurrences. Account credentials remain in
CTOX's secret store. Queries cover at most 400 days and return at most 100
occurrences per account. Incomplete provider pages and bounded response
truncation are shown as Partial sync rather than a complete calendar.

The calendar reads one account at a time, refreshes while visible every five
minutes and provides a manual Sync accounts action. Switching instance or
leaving the view fences late responses. Failed reads are shown explicitly.
All-day events have their own lane; overnight events retain exclusive end dates
and open the original occurrence's read-only detail. Provider project IDs are
mapped only to projects in the selected instance.

## Contracts and remaining work

The event fixture is ctox.workjet.calendar.v1 in CTOX's RxDB fixtures. CTOX
generates native/browser validators, and Workjet keeps the matching fixture and
validates server receipts with Effect Schema. The existing local event
create/update/delete shapes are a wire contract, not implemented calendar
editing tools.

This delivery does not add new account sign-in flows, Google/iCloud/CalDAV
connectors, local event editing or two-way provider writes. Unsupported account
providers are labelled. Those capabilities require separate provider and
persistence work; there is no fallback to another mailbox or instance.
