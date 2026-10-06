# Import conversations into a project

Open **Settings → Harnesses → Import sessions → Browse conversations**.

1. Search by conversation title or source folder. Filter by Codex or Claude Code, and use Previous/Next to reach older conversations.
2. Open a conversation to preview its beginning. Choose **Select page** for the visible page or **Select all matches** for every conversation matching the current search and source filter. Your selection stays selected when you change pages or filters. If the source changes while selecting all, refresh the list and select all again.
3. Choose a destination project, or **New project** and enter a name and folder. The destination belongs to the active CTOX instance and the selected Code computer. If the project has no folder on that computer yet, choose one.
4. Select **Import**. Larger selections run in batches. **Stop after this batch** preserves completed imports and leaves the remaining selection available.

The importer reads source transcripts without changing them. Copied messages keep their transcript order when source timestamps are equal or go backwards; the Workjet copy advances timestamps where necessary. The result is an independent Workjet conversation in the chosen project. Importing the same source into the same project again adds new source messages without duplicating the history. Importing into another project creates a separate copy. New copies appear with their first messages; a failure during that initial save leaves no empty conversation. Longer histories can be retried from their last completed batch.

Conversation titles use the saved Codex thread name or Claude Code custom title when available. Workjet corrects older automatic first-prompt titles on startup, while preserving titles you renamed locally. Completed opening initialization exchanges such as “Nur BEREIT antworten” / “BEREIT” are hidden in the conversation view; their original copied messages remain intact for safe repeat imports.

The imported thread retains the recorded source model identifier. If the transcript contains no model identifier, it is shown as unknown; choose an available model before starting new work.

If either the source history or the imported Workjet conversation has changed incompatibly, the importer leaves that copy untouched and reports the problem. Failed conversations stay selected for retry. Successful imports include links to the resulting conversations.

Codex and Claude Code are supported session sources, including archived Codex conversations. The original source folder can be missing; import into an available destination project still works. Search and paging include older histories even when a source contains more than 5,000 sessions. Large source libraries are browsed and selected across pages. Large transcripts are read in sections. Only user and assistant messages are copied; full tool outputs are omitted. Exceptionally long message text is shortened with a visible marker. Conversations containing only an initialization exchange do not create a chat. A transcript that changes while being read is left unimported and reported for retry.
