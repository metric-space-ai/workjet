// Verify the Decision Hub UI on a managed tenant with a real browser and real
// WebRTC — the only evidence that counts for "it works".
//
//   TENANT=welsch.ctox.dev COOKIE_JAR=./welsch.cookiejar node verify-ui.mjs [view]
//
// view: hub (default) | threads | mail
//
// The session cookie must come from a real POST /login (field name is `user`,
// not `username`). A cookie survives a password reset for the WebRTC shell but
// NOT for the HTTP API — a 401 there means the tenant password changed.
import { chromium } from 'playwright';
import fs from 'fs';

const tenant = process.env.TENANT || 'welsch.ctox.dev';
const jarPath = process.env.COOKIE_JAR || 'welsch.cookiejar';
const view = process.argv[2] || 'hub';

const line = fs.readFileSync(jarPath, 'utf8').split('\n').find((l) => l.includes('ctox_business_os_session'));
if (!line) throw new Error(`no ctox_business_os_session cookie in ${jarPath}`);
const p = line.replace('#HttpOnly_', '').split('\t');

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addCookies([{ name: p[5], value: p[6].trim(), domain: p[0], path: p[2], secure: true, httpOnly: true, expires: Number(p[4]) }]);
const page = await ctx.newPage();
const failed = [];
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(`https://${tenant}`, '')}`); });

await page.goto(`https://${tenant}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

// The shell boots through several stages; the app tabs appear last.
let body = '';
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(5000);
  body = await page.evaluate(() => document.body.innerText);
  if (body.includes('App Store') && !/werden vorbereitet|wird gestartet|Synchronisierung wird gestartet/i.test(body)) break;
}

const target = { hub: 'Decision Hub', threads: 'Threads', mail: 'Mail' }[view];
await page.locator(`text=${target}`).first().click({ timeout: 15000 }).catch(() => {});
await page.waitForTimeout(view === 'hub' ? 20000 : 15000);

if (view === 'mail') {
  // The personal-mailbox form lives in the settings panel behind the gear.
  await page.locator('[data-mail-settings]').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(10000);
}

body = await page.evaluate(() => document.body.innerText);
const checks = {
  hub: () => ({ offen: (body.match(/Offen\((\d+)\)/) || [])[1] ?? 'n/a', glasses: /BRILLEN-DISPLAY/.test(body) }),
  threads: () => ({ handeln: (body.match(/Handeln \((\d+)\)/) || [])[1] ?? 'n/a', hasItem: /@example\.org/.test(body) }),
  mail: () => ({ connectForm: /Persönliches Konto verbinden/.test(body) }),
}[view];
console.log('VIEW:', view, JSON.stringify(checks()));
if (failed.length) console.log('HTTP_FAILURES:', [...new Set(failed)].slice(0, 5).join(' | '));
await page.screenshot({ path: process.env.SHOT || `welsch-${view}.png` });
await browser.close();
