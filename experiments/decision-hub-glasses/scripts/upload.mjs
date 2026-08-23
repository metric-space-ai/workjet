#!/usr/bin/env node
// Ein .ehpk ohne Browser in den Even Hub laden.
//
// Der Weg ist der, den das Portal selbst geht — aus seinem oeffentlichen
// Code gelesen, nicht geraten:
//   1. POST /api/v1/auth/login       {email, password}  -> access_token
//   2. POST /api/v1/versions/draft   multipart "ehpk"   -> draft_id
//   3. POST /api/v1/versions/create  draft_id [+ changelog]
// Der Token geht als Header `X-Even-Authorization` mit, roh, ohne "Bearer".
//
// Zugangsdaten kommen aus der Umgebung und werden nirgends abgelegt:
//   EVENHUB_EMAIL=... EVENHUB_PASSWORD=... node scripts/upload.mjs paket.ehpk
// Alternativ EVENHUB_TOKEN, wenn schon ein Token vorliegt.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const BASIS = process.env.EVENHUB_BASE || 'https://hub.evenrealities.com';
const HEADER = 'X-Even-Authorization';

function raus(nachricht, code = 1) {
  console.error(nachricht);
  process.exit(code);
}

async function json(pfad, optionen = {}) {
  const antwort = await fetch(`${BASIS}${pfad}`, optionen);
  const text = await antwort.text();
  let daten = null;
  try { daten = JSON.parse(text); } catch { /* keine JSON-Antwort */ }
  if (!antwort.ok) raus(`${pfad} -> HTTP ${antwort.status}\n${text.slice(0, 400)}`);
  // Die API antwortet {code, message, data}; code 0 heisst Erfolg.
  if (daten && daten.code !== undefined && daten.code !== 0) {
    raus(`${pfad} -> ${daten.code}: ${daten.message || 'ohne Meldung'}`);
  }
  return daten?.data ?? daten;
}

async function anmelden() {
  if (process.env.EVENHUB_TOKEN) return process.env.EVENHUB_TOKEN;
  const email = process.env.EVENHUB_EMAIL;
  const passwort = process.env.EVENHUB_PASSWORD;
  if (!email || !passwort) {
    raus('EVENHUB_EMAIL und EVENHUB_PASSWORD setzen (oder EVENHUB_TOKEN).');
  }
  const daten = await json('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: passwort }),
  });
  const token = daten?.access_token;
  if (!token) raus('Anmeldung lieferte keinen Token.');
  return token;
}

async function hochladen({ datei, paketId, changelog, token }) {
  const inhalt = await readFile(datei);
  const entwurfForm = new FormData();
  entwurfForm.append('ehpk', new Blob([inhalt]), basename(datei));

  const entwurf = await json(
    `/api/v1/versions/draft?package_id=${encodeURIComponent(paketId)}`,
    { method: 'POST', headers: { [HEADER]: token }, body: entwurfForm },
  );
  const entwurfId = entwurf?.draft_id ?? entwurf?.id;
  if (!entwurfId) {
    raus(`Kein draft_id in der Antwort:\n${JSON.stringify(entwurf).slice(0, 400)}`);
  }
  console.log(`Entwurf angelegt: ${entwurfId}`);
  if (entwurf?.version) console.log(`Version im Paket: ${entwurf.version}`);

  const anlegenForm = new FormData();
  anlegenForm.append('draft_id', String(entwurfId));
  if (changelog) anlegenForm.append('changelog', changelog);
  return json(
    `/api/v1/versions/create?package_id=${encodeURIComponent(paketId)}`,
    { method: 'POST', headers: { [HEADER]: token }, body: anlegenForm },
  );
}

async function main() {
  const argumente = process.argv.slice(2);
  const datei = argumente.find((a) => !a.startsWith('--')) || 'decision-hub-0.4.0.ehpk';
  const paketId = (argumente.find((a) => a.startsWith('--package='))
    || '--package=ai.metricspace.decisionhub').split('=')[1];
  const changelog = (argumente.find((a) => a.startsWith('--changelog=')) || '--changelog=').split('=')[1];

  const token = await anmelden();
  console.log('Angemeldet.');

  if (argumente.includes('--check')) {
    const konto = await json('/api/v1/auth/self_check', { headers: { [HEADER]: token } });
    console.log('Konto:', JSON.stringify(konto).slice(0, 200));
    return;
  }

  console.log(`Lade ${datei} als ${paketId} …`);
  const version = await hochladen({ datei, paketId, changelog, token });
  console.log('Fertig:', JSON.stringify(version).slice(0, 300));
  console.log('Die App erscheint in der Even-App unter den unveröffentlichten Plugins.');
}

main().catch((fehler) => raus(fehler?.stack || String(fehler)));
