# Regeltermin vorbereiten

Workjet startet vor dem nächsten Regeltermin einen Vorbereitungs-Worker für den Projekt-Supervisor. Standardmäßig beginnt die Vorbereitung 24 Stunden und zwei Stunden vor dem Termin. Die Kontrollrunde prüft die Zeitfenster; ein laufender Supervisor-Turn verschiebt die Prüfung bis zur nächsten freien Kontrollrunde.

In den Projekt-Einstellungen unter **Regeltermin-Vorbereitung** kannst du die Vorbereitung ausschalten, die Zeitpunkte ändern und einen Harness, ein Modell sowie einen konfigurierten Worker wählen. Claude Code mit `grok-4.7` ist der Standard. Modell und Kontoroute kommen aus der Worker-Konfiguration der gebundenen Instanz. Der Supervisor behält seinen eigenen Harness und sein Modell.

Claude Code und Codex unterstützen begrenzte One-Shot-Worktrees. Die anderen Harnesses sind mit einem sichtbaren Grund nicht auswählbar. Ein fehlender Worker oder eine nicht erreichbare Kontoroute wird im Supervisor-Verlauf gemeldet.

Jeder Zeitpunkt hat eine eigene Kennung aus Projekt, Termin und Vorlauf. Wiederholte Kontrollen und Server-Neustarts erzeugen dafür keinen zusätzlichen Worker. Beim Neustart innerhalb eines späteren Fensters wird ein bereits vergangenes früheres Fenster nicht nachgeholt.

Der Brief enthält Ziel, Kanban-Stand, offene Entscheidungen, Budget und gemergte PRs seit dem vorherigen Termin. Nicht verfügbare Quellen werden als solche genannt. Der Worker speichert einen Entwurf mit den freigegebenen Jour-fixe- oder Presentation-Werkzeugen. Fehlen diese, liefert er ein Bericht-Artefakt in seinem PR oder einen vollständigen Rückbericht. Der Supervisor prüft das Ergebnis. Fehlgeschlagene Starts, Worker-Fehler und ein fehlender Rückbericht zum Termin stehen im Verlauf.
