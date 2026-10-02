# Import conversations into a project

Open **Settings → Harnesses → Import sessions → Browse conversations**.

1. Search by conversation title or source folder. Filter by Codex or Claude Code, and use Previous/Next to reach older conversations.
2. Open a conversation to preview its beginning. Select any conversations you want to bring across; your selection stays selected when you change pages or filters.
3. Choose a destination project, or **New project** and enter a name and folder. The destination belongs to the active CTOX instance and the selected Code computer. If the project has no folder on that computer yet, choose one.
4. Select **Import**. Larger selections run in batches. **Stop after this batch** preserves completed imports and leaves the remaining selection available.

The importer reads source transcripts without changing them. The result is an independent Workjet conversation in the chosen project. Importing the same source into the same project again adds new source messages without duplicating the history. Importing into another project creates a separate copy.

The imported thread retains the recorded source model identifier. If the transcript contains no model identifier, it is shown as unknown; choose an available model before starting new work.

If either the source history or the imported Workjet conversation has changed incompatibly, the importer leaves that copy untouched and reports the problem. Failed conversations stay selected for retry. Successful imports include links to the resulting conversations.

Codex and Claude Code are supported session sources, including archived Codex conversations. The original source folder can be missing; import into an available destination project still works. Source scans are limited to 5,000 files and individual transcripts to 20 MiB.
