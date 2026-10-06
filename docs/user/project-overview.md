# Project overview

Choose **All projects** to see the projects saved in the current instance.
A project saved locally remains visible while its native registration is pending.
Opening its card returns to its existing supervisor conversation.

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

Previews use an isolated sandbox. If a website blocks embedding or requires
features unavailable in the preview, **Open website** opens it directly.
Viewing a preview does not select or open another project.

Editing requires a connected environment that supports project overviews.
An older environment must be updated first. A failed save keeps your entered
values and reports the failure; it does not claim they were saved.
