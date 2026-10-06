# Import conversations into a project

Open **Settings → Harnesses → Import sessions → Browse conversations**.

1. Search by conversation title or source folder. Filter by Codex or Claude Code, and use Previous/Next to reach older conversations.
2. Open a conversation to preview its beginning. Choose **Select page** for the visible page or **Select all matches** for every conversation matching the current search and source filter. Your selection stays selected when you change pages or filters. If the source changes while selecting all, refresh the list and select all again.
3. Choose a destination project, or **New project** and enter a name and folder. The destination belongs to the active CTOX instance and the selected Code computer. If the project has no folder on that computer yet, choose one.
4. Select **Import**. Larger selections run in batches. **Stop after this batch** preserves completed imports and leaves the remaining selection available.

The importer reads source transcripts without changing them. Copied messages keep their transcript order when source timestamps are equal or go backwards; the Workjet copy advances timestamps where necessary. The result is an independent Workjet conversation in the chosen project. Importing the same source into the same project again adds new source messages without duplicating the history. Importing into another project creates a separate copy. New copies appear with their first messages; a failure during that initial save leaves no empty conversation. Longer histories can be retried from their last completed batch.

The imported thread retains the recorded source model identifier. If the transcript contains no model identifier, it is shown as unknown; choose an available model before starting new work.

If either the source history or the imported Workjet conversation has changed incompatibly, the importer leaves that copy untouched and reports the problem. Failed conversations stay selected for retry. Successful imports include links to the resulting conversations.

Codex and Claude Code are supported session sources, including archived Codex conversations. The original source folder can be missing; import into an available destination project still works. Large source libraries are browsed and selected across pages. Individual transcripts are limited to 20 MiB. A transcript that changes while being read is left unimported and reported for retry.
