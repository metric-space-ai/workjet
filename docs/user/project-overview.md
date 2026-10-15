# Project overview

Choose **All projects** to see the projects saved in the current instance.
A project saved locally remains visible while its native registration is pending.
An existing local history linked through this instance's working copy also keeps
its saved overview and archive state while the instance reconnects.
Opening its card shows the project's overview. It begins with the saved project
summary and four metrics: the configured project KPI, merged PRs since the last
Jour fixe, open tasks and the five-year value. Missing values or comparisons are
explained in sentences rather than shown as empty numbers.

**Needs you** shows pending questions and answer choices. Permissions link to
the conversation where you can inspect the action and decide. Connection
problems appear separately from project decisions.

The goals table uses the confirmed Jour fixe to-do list when one is available.
Otherwise it shows the persistent workers' saved goals, with an owner and status
for each row. Results list evidenced merged PRs. History lists recorded project
events in sentences. The next and previous Jour fixe, recorded owner decisions
and project links appear beside these sections.

**Diagnostics** starts collapsed. Open it to inspect saved and actual execution
information, computers, instructions and raw session data. A saved model is not
presented as proof of the instance's actual execution route.

The overview has no message composer. Choose a conversation from Supervisor,
Persistent Workers or One-Shot Workers in the sidebar to open its history and
composer. Status words show running, waiting, asking you or disrupted. Only
active one-shots appear with the team; inactive and completed one-shots remain
accessible in the archive. This does not delete their history.

A worker running on another connected computer appears in its source project.
Opening its row opens its real conversation on that computer. Use **Add
persistent worker** to save another worker and its goal.

Choose System, German or English under **Settings → General → Project
language** for the overview and its project navigation. Saved project names,
goals and questions retain their authored text.

If no CTOX instance is connected, **All projects** explains that nothing can load yet and offers **Connect an instance**. It no longer shows an empty page.

On **All projects**, choose **Calendar** to open a calendar with **Day**, **Week**,
**Month** and **Year** views. Use the arrows and **Today** to move through time,
and select a date in the mini calendar to jump to it.

Each project's saved Jour fixe appears as a repeating meeting in the **Project
meetings** calendar. A meeting is shown at its time on your computer's timezone;
hover or focus it to see the timezone the project uses. Clear the checkbox next to
**Project meetings** to hide these meetings from the calendar.

Projects without a regular meeting are listed beside the calendar. Select a project
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
