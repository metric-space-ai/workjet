# Die fünf offenen Entscheidungen

Stand 2026-08-21. Alles, was ohne eine Entscheidung baubar war, ist gebaut:
23 von 29 Arbeitspaketen, Typecheck über alle fünf Pakete sauber, jeder neue
Wächter mutationsgeprüft. Was bleibt, hängt an diesen fünf Fragen.

Jede ist so aufgeschrieben, dass eine Antwort genügt — Belege im Code stehen
dabei, damit niemand sie nachschlagen muss. Reihenfolge nach Hebelwirkung.

---

## 1. Posten 9 — `workjet_dispatch_worker`: weiterführen oder stilllegen?

**Der Hebel:** Diese eine Antwort schließt drei Kästchen UND entsperrt die
letzte offene Hälfte von Posten 8.

`workjet_dispatch_worker` umgeht die Delegationsmaschinerie. Es hat genau
einen Aufrufer-Pfad und `WorkerDispatch.ts` liest den Worker-Profil-Katalog
überhaupt nicht — null Treffer für Profil, Harness oder Computer.

- **Option A — durchleiten.** Dispatch läuft künftig durch die
  Delegationsmaschinerie. Dort gehört dann auch das Harness-Verfügbarkeitstor
  hin, das ich vorbereitet habe.
- **Option B — stilllegen**, zugunsten von `workjet_delegate_task`, das alle
  fünf Semantiken (Versand, Abbruch, Wiederholung, Zeitlimit, Ergebnis) schon
  hat. Billiger; die Dispatch-Hälfte von Posten 8 entfällt damit ersatzlos.

**Warum ich nicht selbst entscheide:** Bei B wäre jede Zeile, die ich jetzt in
`WorkerDispatch` schreibe, verworfen — und würde die Stilllegung teurer machen.
Bei A gehört das Tor an eine andere Stelle als heute.

---

## 2. Posten 8 — darf die App fremde Installer ausführen?

`workjet.harness.inspect` ist gebaut und misst live, welche Harnesses laufen.
`install`, `update` und `remove` habe ich **nicht** deklariert: Es gibt im
gesamten Repo keinen Harness-Installer. Greppy hat einen, weil es eine
verwaltete, gepinnte Binary ist, die die App selbst lädt — `claude-code`,
`codex-cli` und die übrigen sind Fremd-CLIs, die der Betreiber installiert.

**Frage:** Soll die App Installationsvorgänge für Fremdsoftware auf dem
Rechner des Betreibers ausführen dürfen?

- **Nein** → die drei RPCs entfallen, die Zeile im Plan wird entsprechend
  umformuliert. Kein Code nötig.
- **Ja** → das ist eine Sicherheitsentscheidung mit Folgen (welche Quellen,
  welche Rechte, welche Bestätigung), kein fehlender Handler.

---

## 3. Posten 14 — darf ein Handoff implizit pushen?

`headCommit` ist gebaut und liest lokal. Offen ist der Push.

Ein Handoff bietet einer anderen Maschine Arbeit an. Ob der Branch dort
erreichbar ist, hängt daran, dass jemand pusht. Heute pusht nichts, und
`delivery` (`"pushed"` | `"sync-bundled"`) lässt sich deshalb nicht
wahrheitsgemäß setzen — was zugleich die `branch`-Hälfte von Posten 13
blockiert.

**Frage:** Wer löst den Push aus?

- **Der Betreiber, ausdrücklich** → der Handoff meldet weiterhin nur
  `remoteConfigured` und überlässt die Erreichbarkeit dem Ziel. Nichts zu tun.
- **Der Handoff, implizit** → dann bewegt eine Nachricht Code hinter dem
  Rücken des Betreibers. Das ist die Entscheidung.

---

## 4. Posten 15 — zwei bereits getroffene Entscheidungen umstoßen?

**Hier rate ich ausdrücklich zu „nein".** Der Posten verlangt
Progress-Board-Regeln und Verifikationszustand als Konfigurationsfelder. Beide
haben schon ein dokumentiertes Zuhause:

- Die Board-Regeln laufen als Sektion `## Progress board` durch
  `managedSystemPrompt` (`LegacyWorkjetMapping.ts:224-229`,
  `outcome: "mapped-into-prompt"`), abgesichert durch zwei Tests.
- Der Verifikationszustand wurde ausdrücklich verworfen: _„Observed
  verification state, not configuration. Re-observed by Code, never
  imported."_ (`:408-435`, fünf Quellen).

Ein eigenes Feld gäbe dem Importeur **zwei Ziele für eine Quelle** und würde
beobachteten Zustand als Konfiguration einfrieren, wo er veralten kann.

**Frage:** Ist die Plan-Zeile schon erfüllt (dann haken und die Zuordnung
zitieren), oder sollen die zwei Entscheidungen umgestoßen werden (dann mit
Begründung)?

---

## 5. Posten 21 — Greppy-Oberfläche erweitern oder Abdeckung verlieren?

Die einzige Greppy-Oberfläche des Servers ist
`greppy search --root <cwd> --json … <task>` — ein **Freitext**. Die
E2E-Skripte prüfen dagegen jeden Anbieter einzeln (`--source mock` für eine
netzfreie Prüfung, dann je Anbieter).

Ein Umzielen auf `workjet-web-stack` würde die Abdeckung still von „jeder
Anbieter funktioniert" auf „die Kaskade funktioniert" reduzieren und die
einzige netzfreie Prüfung verlieren. Der Bin selbst ist in Ordnung — ich habe
ihn gebaut und live gefahren, er liefert echte Treffer.

**Frage:**

- **Abdeckung akzeptieren wie sie ist** → Skripte bleiben, der Posten wird
  entsprechend umformuliert.
- **Oberfläche erweitern** → ein Anbieter-Wähler oder ein symbolbasierter
  Einstieg. Das erweitert ein MCP-exponiertes Werkzeug und ist damit
  sicherheitsrelevant.
- Verwandt: die **Greppy-Referenzart** aus Posten 13 hat dieselbe Wurzel — eine
  wiederholbare Referenz müsste den Freitext tragen, den ersten Prosa-Kanal in
  einem Vertrag, der bewusst keinen hat.

---

## Was danach noch übrig ist

Zwei Posten brauchen keine Entscheidung, sondern eine andere Maschine:

- **Posten 1** ist gebaut, wurde hier aber nie bestehen gesehen. In dieser
  Entwicklungsumgebung wird jeder Prozess, der den Server startet, lautlos
  getötet, während ein Prozess ohne Kind minutenlang überlebt — beides
  gemessen. Auf einer normalen Maschine oder in CI ausführen.
- **Posten 16** braucht zwei signierte Pakete für einen echten
  Update-Rollback-Zyklus und hätte hier dasselbe Problem.
