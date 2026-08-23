#!/usr/bin/env node
// Ein .ehpk ohne Browser in den Even Hub laden.
//
// Der Weg ist der, den das Portal selbst geht — aus seinem oeffentlichen
// Code gelesen, nicht geraten:
//   1. POST /api/v1/auth/login       {email, password} -> access_token
//   2. POST /api/v1/versions/draft   multipart "ehpk"  -> draft_id
//   3. POST /api/v1/versions/create  draft_id [+ changelog]
// Gibt es die App noch nicht, antwortet Schritt 2 mit "data not found".
// Dann laeuft stattdessen der Weg fuer eine NEUE App:
//   2a. POST /api/v1/apps/draft      multipart "ehpk"  -> draft_id + manifest
//   2b. POST /api/v1/apps/create     draft_id, name, tagline
// Der Token geht als Header `X-Even-Authorization` mit, roh, ohne "Bearer".
//
// Aufruf ohne Geheimnisse in der Befehlszeile:
//   node scripts/upload.mjs decision-hub-0.4.0.ehpk
// Das Passwort wird verdeckt abgefragt und nirgends abgelegt. Fuer den
// unbeaufsichtigten Lauf gehen auch EVENHUB_EMAIL/EVENHUB_PASSWORD oder
// EVENHUB_TOKEN aus der Umgebung.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const BASIS = process.env.EVENHUB_BASE || 'https://hub.evenrealities.com';
const HEADER = 'X-Even-Authorization';

function raus(nachricht, code = 1) {
  console.error(nachricht);
  process.exit(code);
}

/** Eingabe abfragen; `verdeckt` unterdrueckt die Anzeige der Zeichen. */
function frage(text, verdeckt = false) {
  return new Promise((fertig) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (verdeckt) {
      // Nichts zurueckschreiben: das Passwort darf weder auf dem Schirm
      // noch in der Shell-Historie landen.
      rl._writeToOutput = (s) => { if (s.includes(text)) stdout.write(text); };
    }
    rl.question(text, (antwort) => { rl.close(); if (verdeckt) stdout.write('\n'); fertig(antwort.trim()); });
  });
}

async function api(pfad, optionen = {}, weichFehlschlag = false) {
  const antwort = await fetch(`${BASIS}${pfad}`, optionen);
  const text = await antwort.text();
  let daten = null;
  try { daten = JSON.parse(text); } catch { /* keine JSON-Antwort */ }
  const fehler = !antwort.ok
    ? `HTTP ${antwort.status}: ${text.slice(0, 300)}`
    : (daten && daten.code !== undefined && daten.code !== 0
      ? `${daten.code}: ${daten.message || 'ohne Meldung'}`
      : null);
  if (fehler) {
    if (weichFehlschlag) return { fehler, daten };
    raus(`${pfad} -> ${fehler}`);
  }
  return { daten: daten?.data ?? daten, fehler: null };
}

async function anmelden() {
  if (process.env.EVENHUB_TOKEN) return process.env.EVENHUB_TOKEN;
  const email = process.env.EVENHUB_EMAIL || await frage('E-Mail: ');
  const passwort = process.env.EVENHUB_PASSWORD || await frage('Passwort (verdeckt): ', true);
  if (!email || !passwort) raus('Ohne E-Mail und Passwort geht es nicht.');
  const { daten } = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: passwort }),
  });
  if (!daten?.access_token) raus('Anmeldung lieferte keinen Token.');
  return daten.access_token;
}

/**
 * Eine neue App anlegen. Das laeuft NICHT ueber apps/listing-draft (das ist
 * ein GET und holt nur einen bestehenden Entwurf), sondern ueber apps/draft
 * mit dem Paket — der Server liest das Manifest selbst — und apps/create.
 */
async function appAnlegen({ datei, inhalt, name, tagline, token }) {
  console.log('App existiert noch nicht — lege sie aus dem Paket an …');
  const entwurfForm = new FormData();
  entwurfForm.append('ehpk', new Blob([inhalt]), basename(datei));
  const { daten: entwurf } = await api('/api/v1/apps/draft', {
    method: 'POST', headers: { [HEADER]: token }, body: entwurfForm,
  });
  if (!entwurf?.draft_id) raus('apps/draft lieferte keine draft_id.');
  console.log(`Manifest gelesen: ${entwurf.manifest?.name} ${entwurf.manifest?.version}`);

  const anlegen = new FormData();
  anlegen.append('draft_id', entwurf.draft_id);
  anlegen.append('name', entwurf.manifest?.name || name);
  anlegen.append('tagline', tagline);
  const { daten: app } = await api('/api/v1/apps/create', {
    method: 'POST', headers: { [HEADER]: token }, body: anlegen,
  });
  console.log(`App angelegt: ${app?.package_id} (id ${app?.id})`);
  // apps/create legt die erste Version gleich mit an — fertig.
  return app;
}

async function hochladen({ datei, paketId, name, tagline, changelog, token }) {
  const inhalt = await readFile(datei);
  const form = () => {
    const f = new FormData();
    f.append('ehpk', new Blob([inhalt]), basename(datei));
    return f;
  };
  const pfad = `/api/v1/versions/draft?package_id=${encodeURIComponent(paketId)}`;

  let { daten: entwurf, fehler } = await api(pfad, {
    method: 'POST', headers: { [HEADER]: token }, body: form(),
  }, true);

  if (fehler) {
    // "data not found" heisst: die App gibt es noch nicht. Dann ist der
    // Anlege-Weg der richtige, und er bringt die erste Version gleich mit.
    console.log(`Als bestehende App abgelehnt (${fehler}).`);
    return appAnlegen({ datei, inhalt, name, tagline, token });
  }

  const entwurfId = entwurf?.draft_id ?? entwurf?.id;
  if (!entwurfId) raus(`Kein draft_id in der Antwort:\n${JSON.stringify(entwurf).slice(0, 400)}`);
  console.log(`Entwurf angelegt: ${entwurfId}${entwurf?.version ? ` (Version ${entwurf.version})` : ''}`);

  const anlegen = new FormData();
  anlegen.append('draft_id', String(entwurfId));
  if (changelog) anlegen.append('changelog', changelog);
  const { daten } = await api(`/api/v1/versions/create?package_id=${encodeURIComponent(paketId)}`, {
    method: 'POST', headers: { [HEADER]: token }, body: anlegen,
  });
  return daten;
}

/**
 * Hochladen allein reicht NICHT: eine Version, die keinem Kanal zugewiesen
 * ist, erreicht kein Geraet — beide Kanaele stehen nach dem Anlegen auf
 * `version: null`. Erst die Zuweisung macht die App auf der Brille sichtbar,
 * und beim Beta-Kanal muss das eigene Konto als Tester eingetragen sein.
 */
async function veroeffentlichen({ paketId, version, kanal, emails, token }) {
  const kopf = { [HEADER]: token, 'content-type': 'application/json' };
  const ziel = `?package_id=${encodeURIComponent(paketId)}`;
  // Das Feld heisst version_name, nicht version — mit `version` antwortet
  // der Server mit HTTP 500 statt einer Meldung.
  await api(`/api/v1/apps/branch-version${ziel}`, {
    method: 'POST', headers: kopf,
    body: JSON.stringify({ branch_name: kanal, version_name: version }),
  });
  console.log(`Version ${version} im Kanal "${kanal}" veröffentlicht.`);

  if (kanal === 'beta' && emails.length) {
    await api(`/api/v1/apps/add-branch-users${ziel}`, {
      method: 'POST', headers: kopf,
      body: JSON.stringify({ branch_name: 'beta', emails }),
    });
    console.log(`Tester freigeschaltet: ${emails.join(', ')}`);
  }
}

async function main() {
  const argumente = process.argv.slice(2);
  const wert = (praefix, standard) =>
    (argumente.find((a) => a.startsWith(praefix)) || `${praefix}${standard}`).slice(praefix.length);
  const datei = argumente.find((a) => !a.startsWith('--')) || 'decision-hub-0.4.0.ehpk';
  const paketId = wert('--package=', 'ai.metricspace.decisionhub');
  const name = wert('--name=', 'Decision Hub');
  const tagline = wert('--tagline=', 'Entscheidungen im Blickfeld');
  const changelog = wert('--changelog=', '');

  const token = await anmelden();
  console.log('Angemeldet.');

  if (argumente.includes('--check')) {
    const { daten } = await api('/api/v1/auth/self_check', { headers: { [HEADER]: token } });
    console.log('Konto:', JSON.stringify(daten).slice(0, 200));
    return;
  }

  console.log(`Lade ${datei} als ${paketId} …`);
  const version = await hochladen({ datei, paketId, name, tagline, changelog, token });
  const nummer = version?.version || version?.versions?.[0]?.version;
  console.log(`Hochgeladen: Version ${nummer}`);

  // Standard: KEIN Kanal. Der Entwickler-Hub auf dem Handy zeigt genau die
  // unveroeffentlichten (privaten) Versionen — sobald eine einem Kanal
  // zugewiesen ist, verschwindet sie dort. Zum Testen auf dem eigenen Geraet
  // ist "privat" also richtig; --branch=beta erst fuer fremde Tester.
  const kanal = wert('--branch=', 'none');
  const emails = wert('--testers=', '').split(',').map((e) => e.trim()).filter(Boolean);
  if (kanal !== 'none') {
    await veroeffentlichen({ paketId, version: nummer, kanal, emails, token });
  }
  console.log(kanal === 'none'
    ? 'Fertig. Die Version bleibt privat und erscheint im Entwickler-Hub der Even-App.'
    : 'Fertig. Die App erscheint auf dem Gerät der eingetragenen Tester.');
}

main().catch((fehler) => raus(fehler?.stack || String(fehler)));
