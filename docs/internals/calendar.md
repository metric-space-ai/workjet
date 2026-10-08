# Calendar

The All projects calendar draws three kinds of time: project regular meetings
(Jour fixe), events the user creates, and events synced from connected accounts.
This page records what exists today and the plan for the rest.

## Stage 1: the view

- `apps/web/src/calendar/calendarDates.ts` holds the date model. Calendar dates are
  `YYYY-MM-DD` keys and day arithmetic runs in UTC. Instants are converted only
  when a zone is involved (`instantOf`, `zonedReading`).
- `apps/web/src/components/ProjectCalendar.tsx` renders Day, Week, Month and Year
  views, a mini month, a calendar list and the unscheduled-project list.
- Project meetings are derived, not stored. `weeklyOccurrences` expands a
  project's `jourFixe` rule (weekday, time, timezone) into instants for the
  visible range and places each occurrence on the viewer's timezone. Each meeting
  is drawn as one hour, because the rule has no duration.
- Nothing is persisted in this stage. The view keeps only its own state: the
  anchor date, the view and the hidden calendars.

## Where data lives: ctox

Jour fixe already travels through CTOX: the wire contract is
`ctox.workjet.jour_fixe.v1` (`packages/contracts/src/workjetJourFixeOwner.ts`,
`src/core/business_os/workjet_jour_fixe_contract.generated.rs`). Calendar data
follows the same route, server-side in CTOX and projected into RxDB, so that
the browser never becomes the store for events or account credentials.

Planned collections, to be added to the contract fixtures before code:

- `calendar_accounts`: provider (`google`, `icloud`, `caldav`), display name,
  sync state. Credentials stay in the CTOX secret store and never reach RxDB.
- `calendar_sources`: one row per remote calendar, with a visibility flag.
- `calendar_events`: local and synced events, with instants, all-day flag,
  recurrence rule, the source and the remote identity used for sync.

## Later stages

1. Creating, editing and deleting events. Each change is a command with a
   receipt, and the reverse action (delete, restore) is part of the same change.
2. Account connections. Google uses OAuth; iCloud and other servers use CalDAV
   with an app-specific password. The user enters credentials in the app. The
   flow is designed so credentials never pass through a chat or a log.
3. Two-way sync. Remote changes and local edits are reconciled through the
   stored remote identity and an etag or sync token per calendar.
