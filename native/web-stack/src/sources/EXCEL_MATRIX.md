# DACH-Prospektrecherche — Quellenmatrix

Diese Datei übersetzt die Quellenmatrix aus
Die Matrix ist aus einem realen CRM-Aktualisierungsworkflow abgeleitet und für
beliebige Mandanten normalisiert.
in eine maschinenlesbare Form. Jede Quelle im CTOX-Webstack-Source-Registry
(`tools/web-stack/src/sources/<id>.rs`) leitet ihre `authoritative_for()`-,
`countries()`- und (für `person-research`) Prioritätsentscheidungen aus
genau diesem Dokument ab.

## Mode/Block-Mapping

| Excel-Block                                       | `ResearchMode`           | Quellen befüllt?                            |
| ------------------------------------------------- | ------------------------ | ------------------------------------------- |
| Sheet `Nach-Recherche` / A. Vorhanden             | `HaveData`               | nein (keine Recherche)                      |
| Sheet `Nach-Recherche` / B. Bestand generell      | `UpdateInventoryGeneral` | nein (leere Spalten → leerer Plan pro Feld) |
| Sheet `Nach-Recherche` / B 1. Änderung Person     | `UpdatePerson`           | nur Person-Felder                           |
| Sheet `Nach-Recherche` / B 2. Änderung Firmierung | `UpdateFirm`             | Firma + Person                              |
| Sheet `Neu-Recherche` / A. Vorhanden              | n/a — Excel-Input        | nein                                        |
| Sheet `Neu-Recherche` / B. Neuer Bestand          | `NewRecord`              | Firma + Person                              |

## Normalisierte Quellen-IDs

Tippfehler aus der Excel (`ww.northdata.de`, `wwww.northdata.de`,
`dnbhoovers.com bundesanzeiger.de` mit fehlendem Komma) sind hier
korrigiert. Discovery-Muster (`Impressum`, `Unternehmensseite`, `Google`)
sind **kein** Source-Modul — die deckt der existierende Web-Stack
(`ctox web search`, `ctox web read`) über die generische Provider-Cascade
und das Bemerkungs-Feld der Excel ("Online recherchieren") ab.

| Excel-Token                    | Source-ID            | Tier | Modul-Datei          |
| ------------------------------ | -------------------- | ---- | -------------------- |
| `www.bundesanzeiger.de`        | `bundesanzeiger.de`  | P    | `bundesanzeiger.rs`  |
| `www.zefix.ch`                 | `zefix.ch`           | P    | `zefix.rs`           |
| `Handelsregister` (impliziert) | `handelsregister.de` | P    | `handelsregister.rs` |
| `www.northdata.de`             | `northdata.de`       | S    | `northdata.rs`       |
| `www.firmenabc.at`             | `firmenabc.at`       | S    | `firmenabc.rs`       |
| `www.companyhouse.de`          | `companyhouse.de`    | S    | `companyhouse.rs`    |
| `app.dnbhoovers.com`           | `dnbhoovers.com`     | C    | `dnbhoovers.rs`      |
| `app.leadfeeder.com`           | `leadfeeder.com`     | C    | `leadfeeder.rs`      |
| `www.linkedin.com`             | `linkedin.com`       | C    | `linkedin.rs`        |
| `www.xing.com`                 | `xing.com`           | C    | `xing.rs`            |
| `Impressum`                    | (generic web-read)   | —    | nicht modul-gestützt |
| `Unternehmensseite`            | (generic web-read)   | —    | nicht modul-gestützt |
| `Google`                       | (generic search)     | —    | nicht modul-gestützt |

## Matrix `(Mode, Country, FieldKey) → Source-Priority`

Reihenfolge spiegelt die Excel-Reihenfolge wider (links → rechts → fallback
auf Discovery-Muster). Quellen sind nach Tier sortiert; bei Gleichstand
gilt die Excel-Ordnung. Discovery-Muster sind kursiv: sie laufen über
`ctox web search` ohne Source-Modul-Pin.

### Mode `UpdatePerson` (B 1 — nur Person-Felder)

#### Deutschland

| FieldKey            | Source-Priorität                                                                    |
| ------------------- | ----------------------------------------------------------------------------------- |
| `person_geschlecht` | `linkedin.com`, `xing.com`, _Unternehmensseite_                                     |
| `person_titel`      | _Impressum_, `companyhouse.de`, _Unternehmensseite_                                 |
| `person_vorname`    | `northdata.de`, _Impressum_, _Unternehmensseite_                                    |
| `person_nachname`   | `northdata.de`, _Impressum_, _Unternehmensseite_                                    |
| `person_funktion`   | `linkedin.com`, `xing.com`, `dnbhoovers.com`                                        |
| `person_position`   | _Impressum_, `northdata.de`, `dnbhoovers.com`, _Unternehmensseite_                  |
| `person_email`      | `leadfeeder.com`                                                                    |
| `person_linkedin`   | `linkedin.com`                                                                      |
| `person_xing`       | `xing.com`                                                                          |
| `person_telefon`    | _(keine Quelle in Excel — best effort via Impressum/Unternehmensseite, sonst leer)_ |

#### Österreich

| FieldKey            | Source-Priorität                                                |
| ------------------- | --------------------------------------------------------------- |
| `person_geschlecht` | `firmenabc.at`, `linkedin.com`, `xing.com`, _Unternehmensseite_ |
| `person_titel`      | `firmenabc.at`, _Impressum_, _Unternehmensseite_                |
| `person_vorname`    | `northdata.de`, _Impressum_, `firmenabc.at`, `northdata.de`     |
| `person_nachname`   | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`                 |
| `person_position`   | _Impressum_, `northdata.de`                                     |
| `person_email`      | `leadfeeder.com`                                                |
| `person_linkedin`   | `linkedin.com`                                                  |
| `person_xing`       | `xing.com`                                                      |
| `person_telefon`    | _(keine Quelle in Excel)_                                       |

#### Schweiz

| FieldKey            | Source-Priorität                                |
| ------------------- | ----------------------------------------------- |
| `person_geschlecht` | `linkedin.com`, `xing.com`, _Unternehmensseite_ |
| `person_titel`      | _Unternehmensseite_, `linkedin.com`, `xing.com` |
| `person_vorname`    | `northdata.de`, _Unternehmensseite_             |
| `person_nachname`   | `northdata.de`, _Unternehmensseite_             |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com` |
| `person_position`   | _Unternehmensseite_, `northdata.de`             |
| `person_email`      | `leadfeeder.com`                                |
| `person_linkedin`   | `linkedin.com`                                  |
| `person_xing`       | `xing.com`                                      |
| `person_telefon`    | _(keine Quelle in Excel)_                       |

### Mode `UpdateFirm` (B 2 — Firma + Person)

#### Deutschland

| FieldKey                                                | Source-Priorität                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `firma_name`                                            | `northdata.de`, _Impressum_                                                              |
| `firma_anschrift`                                       | `northdata.de`, _Impressum_                                                              |
| `firma_plz`                                             | `northdata.de`, _Impressum_                                                              |
| `firma_ort`                                             | `northdata.de`, _Impressum_                                                              |
| `firma_email`                                           | _Impressum_, `leadfeeder.com`, `dnbhoovers.com`                                          |
| `firma_domain`                                          | _Google_, `dnbhoovers.com`, `leadfeeder.com`                                             |
| `firma_telefon`                                         | _Google Maps_, _Impressum_, _Unternehmensseite_                                          |
| `person_geschlecht`                                     | _Unternehmensseite_, `linkedin.com`, `xing.com`                                          |
| `person_titel`                                          | _Impressum_, `companyhouse.de`, _Unternehmensseite_                                      |
| `person_vorname`                                        | _Impressum_, `northdata.de`, _Unternehmensseite_                                         |
| `person_nachname`                                       | _Impressum_, `northdata.de`, _Unternehmensseite_                                         |
| `person_funktion`                                       | _Unternehmensseite_, `linkedin.com`, `xing.com`, `dnbhoovers.com`                        |
| `person_position`                                       | _Impressum_, `northdata.de`, `dnbhoovers.com`, _Unternehmensseite_                       |
| `person_email`                                          | `leadfeeder.com`                                                                         |
| `person_linkedin`                                       | `linkedin.com`                                                                           |
| `person_xing`                                           | `xing.com`                                                                               |
| `wz_code`, `umsatz`, `mitarbeiter`, `crm_record_number` | _(in der Excel-B2-Person-Sektion ohne Quelle — werden nur in B/Neu recherchiert, s. u.)_ |

#### Österreich

| FieldKey            | Source-Priorität                                                |
| ------------------- | --------------------------------------------------------------- |
| `firma_name`        | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_anschrift`   | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_plz`         | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_ort`         | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_email`       | _Impressum_, `leadfeeder.com`, `firmenabc.at`                   |
| `firma_domain`      | `firmenabc.at`, _Google_                                        |
| `person_geschlecht` | `firmenabc.at`, `linkedin.com`, `xing.com`, _Unternehmensseite_ |
| `person_titel`      | `firmenabc.at`, _Impressum_, _Unternehmensseite_                |
| `person_vorname`    | _Impressum_, `firmenabc.at`, `northdata.de`                     |
| `person_nachname`   | _Impressum_, `firmenabc.at`, `northdata.de`                     |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`                 |
| `person_position`   | _Impressum_, `northdata.de`                                     |
| `person_email`      | `leadfeeder.com`                                                |
| `person_linkedin`   | `linkedin.com`                                                  |
| `person_xing`       | `xing.com`                                                      |

#### Schweiz

| FieldKey            | Source-Priorität                                        |
| ------------------- | ------------------------------------------------------- |
| `firma_name`        | `northdata.de`, _Unternehmensseite_, `zefix.ch`         |
| `firma_anschrift`   | `northdata.de`, _Unternehmensseite_, `zefix.ch`         |
| `firma_plz`         | `northdata.de`, _Unternehmensseite_, `zefix.ch`         |
| `firma_ort`         | `northdata.de`, _Unternehmensseite_, `dnbhoovers.com`   |
| `firma_email`       | _Unternehmensseite_, `leadfeeder.com`, `dnbhoovers.com` |
| `firma_domain`      | _Google_, `dnbhoovers.com`, `leadfeeder.com`            |
| `person_geschlecht` | `linkedin.com`, `xing.com`, _Unternehmensseite_         |
| `person_titel`      | _Unternehmensseite_, `linkedin.com`, `xing.com`         |
| `person_vorname`    | _Unternehmensseite_, `northdata.de`                     |
| `person_nachname`   | `northdata.de`, _Unternehmensseite_                     |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`         |
| `person_position`   | _Unternehmensseite_, `northdata.de`                     |
| `person_email`      | `leadfeeder.com`                                        |
| `person_linkedin`   | `linkedin.com`                                          |
| `person_xing`       | `xing.com`                                              |

### Mode `NewRecord` (Neu-Recherche B — Greenfield)

#### Deutschland

| FieldKey            | Source-Priorität                                                   |
| ------------------- | ------------------------------------------------------------------ |
| `firma_name`        | _Impressum_, `northdata.de`, `bundesanzeiger.de`, `dnbhoovers.com` |
| `firma_anschrift`   | _Impressum_, `northdata.de`, `dnbhoovers.com`                      |
| `firma_plz`         | _Impressum_, `northdata.de`, `dnbhoovers.com`                      |
| `firma_ort`         | _Impressum_, `northdata.de`, `dnbhoovers.com`                      |
| `firma_email`       | _Impressum_, `leadfeeder.com`, `dnbhoovers.com`                    |
| `firma_domain`      | _Google_, `dnbhoovers.com`, `leadfeeder.com`                       |
| `wz_code`           | `dnbhoovers.com`, `leadfeeder.com`                                 |
| `umsatz`            | `dnbhoovers.com`, `bundesanzeiger.de`, _Unternehmensseite_         |
| `mitarbeiter`       | `dnbhoovers.com`, `leadfeeder.com`, _Unternehmensseite_            |
| `person_geschlecht` | `linkedin.com`, `xing.com`, _Unternehmensseite_                    |
| `person_titel`      | _Impressum_, `companyhouse.de`, _Unternehmensseite_                |
| `person_vorname`    | _Impressum_, `northdata.de`, _Unternehmensseite_                   |
| `person_nachname`   | _Impressum_, `northdata.de`, _Unternehmensseite_                   |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`, `dnbhoovers.com`  |
| `person_position`   | _Impressum_, `northdata.de`, `dnbhoovers.com`, _Unternehmensseite_ |
| `person_email`      | `leadfeeder.com`                                                   |
| `person_linkedin`   | `linkedin.com`                                                     |
| `person_xing`       | `xing.com`                                                         |

#### Österreich

| FieldKey            | Source-Priorität                                                |
| ------------------- | --------------------------------------------------------------- |
| `firma_name`        | _Impressum_, `firmenabc.at`, `northdata.de`                     |
| `firma_anschrift`   | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_plz`         | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_ort`         | `northdata.de`, _Impressum_, `firmenabc.at`                     |
| `firma_email`       | _Impressum_, `leadfeeder.com`, `firmenabc.at`                   |
| `firma_domain`      | `firmenabc.at`, _Google_                                        |
| `wz_code`           | `dnbhoovers.com`, `leadfeeder.com`                              |
| `umsatz`            | `dnbhoovers.com`, `leadfeeder.com`                              |
| `mitarbeiter`       | `dnbhoovers.com`, `leadfeeder.com`                              |
| `person_geschlecht` | `firmenabc.at`, `linkedin.com`, `xing.com`, _Unternehmensseite_ |
| `person_titel`      | `firmenabc.at`, _Impressum_, _Unternehmensseite_                |
| `person_vorname`    | _Impressum_, `firmenabc.at`, `northdata.de`                     |
| `person_nachname`   | _Impressum_, `firmenabc.at`, `northdata.de`                     |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`                 |
| `person_position`   | _Impressum_, `northdata.de`                                     |
| `person_email`      | `leadfeeder.com`                                                |
| `person_linkedin`   | `linkedin.com`                                                  |
| `person_xing`       | `xing.com`                                                      |

#### Schweiz

| FieldKey            | Source-Priorität                                                  |
| ------------------- | ----------------------------------------------------------------- |
| `firma_name`        | _Unternehmensseite_, `northdata.de`, `zefix.ch`                   |
| `firma_anschrift`   | _Unternehmensseite_, `northdata.de`, `zefix.ch`                   |
| `firma_plz`         | `northdata.de`, _Unternehmensseite_, `zefix.ch`                   |
| `firma_ort`         | `northdata.de`, _Unternehmensseite_, `dnbhoovers.com`, `zefix.ch` |
| `firma_email`       | _Unternehmensseite_, `leadfeeder.com`, `dnbhoovers.com`           |
| `firma_domain`      | _Google_, `dnbhoovers.com`, `leadfeeder.com`                      |
| `wz_code`           | `dnbhoovers.com`, `leadfeeder.com`                                |
| `umsatz`            | `dnbhoovers.com`, _Unternehmensseite_                             |
| `mitarbeiter`       | `dnbhoovers.com`, `leadfeeder.com`, _Unternehmensseite_           |
| `person_geschlecht` | `linkedin.com`, `xing.com`, _Unternehmensseite_                   |
| `person_titel`      | _Unternehmensseite_, `linkedin.com`, `xing.com`                   |
| `person_vorname`    | _Unternehmensseite_, `northdata.de`, `zefix.ch`                   |
| `person_nachname`   | `northdata.de`, `zefix.ch`, _Unternehmensseite_                   |
| `person_funktion`   | _Unternehmensseite_, `linkedin.com`, `xing.com`, `zefix.ch`       |
| `person_position`   | _Unternehmensseite_, `northdata.de`, `zefix.ch`                   |
| `person_email`      | `leadfeeder.com`                                                  |
| `person_linkedin`   | `linkedin.com`                                                    |
| `person_xing`       | `xing.com`                                                        |

### Mode `HaveData` & `UpdateInventoryGeneral`

Beide produzieren **leere Recherche-Pläne**: `HaveData` weil die Stammdaten
schon vorliegen, `UpdateInventoryGeneral` weil die Excel keine Quellen
gefüllt hat. `person-research` skippt diese Modi per Konvention; ein Agent,
der explizit eine Auffrischung möchte, wählt stattdessen `UpdateFirm`
oder `UpdatePerson`.

## Tipp- und Vereinheitlichungs-Notizen

- `ww.northdata.de` und `wwww.northdata.de` aus der Excel → `northdata.de`.
- `dnbhoovers.com bundesanzeiger.de` (fehlendes Komma, DE / Umsatz) →
  `dnbhoovers.com` und `bundesanzeiger.de` als zwei Einträge.
- `www.northdata.de Unternehmensseite` (mehrfach in CH) → zwei Einträge.
- `Person - Position* GF` (DE / B 1, Person) ist als `person_position`
  geführt; das \*-Suffix („nicht zu 100 %") überträgt sich in
  `Confidence::Medium` als Default für diese Felder.
