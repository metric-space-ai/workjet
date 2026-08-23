#!/usr/bin/env node
// Ein .ehpk ohne Browser in den Even Hub laden.
//
// Der Weg ist der, den das Portal selbst geht — aus seinem oeffentlichen
// Code gelesen, nicht geraten:
//   1. POST /api/v1/auth/login            {email, password} -> access_token
//   2. POST /api/v1/apps/listing-draft    (nur falls die App noch fehlt)
//   3. POST /api/v1/versions/draft        multipart "ehpk"  -> draft_id
//   4. POST /api/v1/versions/create       draft_id [+ changelog]
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

/** Die App im Hub anlegen, falls es sie unter dieser Kennung noch nicht gibt. */
async function appAnlegen({ paketId, name, token }) {
  console.log(`App ${paketId} existiert noch nicht — lege sie an …`);
  await api('/api/v1/apps/listing-draft', {
    method: 'POST',
    headers: { [HEADER]: token, 'content-type': 'application/json' },
    body: JSON.stringify({ package_id: paketId }),
  });
  const form = new FormData();
  form.append('name', name);
  await api(`/api/v1/apps/listing-draft/basic-info?package_id=${encodeURIComponent(paketId)}`, {
    method: 'POST', headers: { [HEADER]: token }, body: form,
  });
  console.log('App angelegt.');
}

async function hochladen({ datei, paketId, name, changelog, token }) {
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
    // Fehlt die App, ist das kein Abbruchgrund — anlegen und erneut versuchen.
    console.log(`Erster Versuch abgelehnt (${fehler}).`);
    await appAnlegen({ paketId, name, token });
    ({ daten: entwurf } = await api(pfad, {
      method: 'POST', headers: { [HEADER]: token }, body: form(),
    }));
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

async function main() {
  const argumente = process.argv.slice(2);
  const wert = (praefix, standard) =>
    (argumente.find((a) => a.startsWith(praefix)) || `${praefix}${standard}`).slice(praefix.length);
  const datei = argumente.find((a) => !a.startsWith('--')) || 'decision-hub-0.4.0.ehpk';
  const paketId = wert('--package=', 'ai.metricspace.decisionhub');
  const name = wert('--name=', 'Decision Hub');
  const changelog = wert('--changelog=', '');

  const token = await anmelden();
  console.log('Angemeldet.');

  if (argumente.includes('--check')) {
    const { daten } = await api('/api/v1/auth/self_check', { headers: { [HEADER]: token } });
    console.log('Konto:', JSON.stringify(daten).slice(0, 200));
    return;
  }

  console.log(`Lade ${datei} als ${paketId} …`);
  const version = await hochladen({ datei, paketId, name, changelog, token });
  console.log('Fertig:', JSON.stringify(version).slice(0, 300));
  console.log('Die App erscheint in der Even-App unter den unveröffentlichten Plugins.');
}

main().catch((fehler) => raus(fehler?.stack || String(fehler)));
