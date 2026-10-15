# Supervisor control rounds

Each project supervisor checks its project every 30 minutes by default. Open the project's configuration to change **Supervisor-Takt in Minuten** or switch **An** off. The setting is saved with the project and applies to every connected client.

The overview shows **Letzte Kontrolle** and **Nächste**. The first control is spread randomly across the configured interval and its time is saved. The server resumes the cadence after restarting and combines missed checks into one round. A busy supervisor skips the current round; skipped rounds appear in the history and do not accumulate.

A control round includes worker status, saved goals and Kanban changes, open escalations, project pull requests and CI results, recent errors and the time until the next configured regular meeting. Archived one-shot workers remain visible for 24 hours. Missing sources are identified in the round; an unset budget appears as **Budget nicht konfiguriert**. The supervisor follows the project's merge and approval rules, addresses blockers and records a short result in its history.
