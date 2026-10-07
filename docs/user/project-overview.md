# Project overview

Choose **All projects** to see the projects saved in the current instance.
A project saved locally remains visible while its native registration is pending.
An existing local history linked through this instance's working copy also keeps
its saved overview and archive state while the instance reconnects.
Opening its card shows the project's overview. Choose a conversation from
Supervisor, Parents or Workers to open its history and message composer.
The overview itself has no message composer. Its sidebar shows the same groups,
counts and status dots; empty groups are hidden. A Parent is a specialist with
its own goal. Use **+ Parent** to add one to this project.

A worker running on another connected computer appears in its source project’s
Workers group. Opening that row opens the worker’s real conversation on that
computer. Archived workers leave the overview and sidebar while their history
remains retained.

The overview also shows the project\x27s saved goal, phase, links and Jour fixe.
Yellow status dots mean a session is running; rose dots mean an approval or
answer is waiting for you. Failed sessions have a red error dot, and idle
histories remain gray. The overview and sidebar use the same session state.
Each Parent row shows its latest assistant message, falling back to its current
plan step when no message is available. Equal conversation titles retain their
names and show the harness beside them in both the overview and sidebar.

On **All projects**, choose **Calendar** to see the weekly regular meetings.
The calendar reads each project's saved Jour fixe: weekday, time and timezone.
Times use the timezone written next to the project; they are not silently
converted to your computer's timezone. Choose **Projects** to return to the cards.

Projects without a regular meeting appear below the week. Select a project
from either section to open its overview. To add or change its meeting, open
that project's configuration and save its Jour fixe. Viewing the calendar does
not create appointments or change a project's schedule.

Choose **Archive project** to hide its card from All projects. This retains the
project, its conversations and its three saved info fields. Open **Archived
projects**, then choose **Restore project** to return the same project to the
gallery. Archived cards do not load website previews. Archiving requires the
same connected environment as saving an overview.

The list refreshes when the selected instance finishes loading. Choose **Refresh
projects** to request the list again without switching instances. Previously
loaded projects remain available when the connection is interrupted. Saved
projects are usable immediately on reopen while the list refreshes in the
background. If that refresh fails, a notice appears and your saved selection
remains available. An incomplete or unconfirmed backend list keeps the saved projects
and shows the same retry notice; only a list matching the confirmed native count
can replace them.

Choose **Configure overview** on a card, or open **Project settings → Project
overview**. Add an optional website address and configure each of the three
fields separately:

- **Empty** leaves the field unconfigured.
- **Text** shows the label and value you enter.
- **Link** opens the address you enter.
- **Project update age** shows the time since the saved project last changed.
- **Entered metric** shows your number and optional unit. It does not collect or
  estimate a metric automatically.

Choose **Save overview** to store the configuration with the project. Removing
its website address or selecting Empty clears only that value. The website,
labels and values remain available when you return to the same project.

Each card shows its website preview automatically. Projects named after a domain
use that domain until you save an overview. A saved website address takes
precedence; clearing it keeps the preview off. **Hide preview** closes the preview,
and **Show preview** restores it.

Fzul and I-hate-AI use a saved website screenshot, with its capture date,
instead of loading an embedded page. These previews remain visible offline.
Changing the website address to another page uses that page's own preview.

Live previews use an isolated sandbox. If a website blocks embedding or requires
features unavailable in the preview, **Open website** opens it directly.
Viewing a preview does not select or open another project.

Editing requires a connected environment that supports project overviews.
An older environment must be updated first. A failed save keeps your entered
values and reports the failure; it does not claim they were saved.
