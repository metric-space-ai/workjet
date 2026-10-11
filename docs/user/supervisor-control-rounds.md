# Supervisor control rounds

Each project supervisor checks its project every 30 minutes by default. Open the project's configuration to change **Supervisor-Takt in Minuten** or switch **An** off. The setting is saved with the project and applies to every connected client.

The overview shows **Letzte Kontrolle** and **Nächste**. The server resumes the cadence after restarting and combines missed checks into one round. A busy supervisor skips the current round; skipped rounds appear in the history and do not accumulate.

A control round includes worker status, saved goals and Kanban changes, open escalations, project pull requests and CI results, recent errors and the time until the next configured regular meeting. Missing sources are identified in the round. The supervisor follows the project's merge and approval rules, addresses blockers and records a short result in its history or Kanban.
