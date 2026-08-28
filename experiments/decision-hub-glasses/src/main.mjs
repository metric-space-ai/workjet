// Einstiegspunkt im Handy-WebView: Bridge holen, Plugin starten, Ereignisse
// der Brille durchreichen. Die Entscheidungslogik liegt bewusst nicht hier.

import { waitForEvenAppBridge, BridgeEvent, EvenAppMethod } from "@evenrealities/even_hub_sdk";
import { createDecisionHubPlugin } from "./plugin.mjs";
import { renderSettings } from "./phone-view.mjs";
import { createSource } from "./source.mjs";
import {
  loadSettings,
  saveSettings,
  activeInstance,
  parseInvite,
  instanceFrom,
  passesFilter,
  isLive,
  RUHEZEITEN,
} from "./settings.mjs";
import { osEventFrom, imuFrom } from "./event-decode.mjs";
import { scanInvite } from "./pairing.mjs";

const $ = (sel) => document.querySelector(sel);

function status(text, state = "warn") {
  const el = $("[data-dh-status]");
  if (el) el.textContent = text;
  const dot = $("[data-dh-dot]");
  if (dot) dot.dataset.state = state;
}

/** Das SDK spricht ueber `callEvenApp`; hier die Aufrufe, die wir nutzen. */
function sdkFromBridge(bridge) {
  return {
    createStartUpPageContainer: (page) =>
      bridge.callEvenApp(EvenAppMethod.CreateStartUpPageContainer, page),
    updateImageRawData: (data) => bridge.callEvenApp(EvenAppMethod.UpdateImageRawData, data),
    rebuildPageContainer: (page) => bridge.callEvenApp(EvenAppMethod.RebuildPageContainer, page),
    textContainerUpgrade: (update) =>
      bridge.callEvenApp(EvenAppMethod.TextContainerUpgrade, update),
    imuControl: (cmd) => bridge.callEvenApp(EvenAppMethod.ImuControl, cmd),
    audioControl: (on, quelle = "glasses") => bridge.audioControl?.(on, quelle),
  };
}

let plugin = null;
let appBridge = null;
let settings = loadSettings();
const health = { lastSync: null, lastError: null };

function renderApp() {
  const root = $("[data-dh-view]");
  if (!root) return;
  const snapshot = plugin?.snapshot?.() || { decisions: [], index: 0, vorgangOf: () => null };
  const current = snapshot.decisions[snapshot.index];
  renderSettings(root, {
    settings,
    decisions: snapshot.decisions.length,
    currentTitle: current ? current.titel || current.id : null,
    status: health,
    onSettings: (patch) => {
      settings = saveSettings({ ...settings, ...patch });
      renderApp();
      plugin?.refresh();
    },
    onConnect: (raw) => connect(raw),
    onScan: () => scanAndConnect(),
    onDisconnect: (id) => {
      settings = saveSettings({
        ...settings,
        instances: settings.instances.filter((i) => i.id !== id),
        activeInstanceId: null,
      });
      status("getrennt", "warn");
      renderApp();
    },
    onTest: () => testConnection(),
    onTestCard: () => plugin?.showTestCard?.(),
  });
}

/** QR abfotografieren und die Einladung daraus uebernehmen. */
async function scanAndConnect() {
  status("Kamera öffnet …", "warn");
  const result = await scanInvite(appBridge);
  if (!result.ok) {
    health.lastError = result.reason;
    status(result.reason, "error");
    renderApp();
    return;
  }
  await connect(
    JSON.stringify({
      base_url: result.invite.baseUrl,
      capability_token: result.invite.token,
      user_id: result.invite.user,
      role: result.invite.role,
    }),
  );
}

/** Einladung annehmen — ohne Passwort, der Token steckt in der Einladung. */
async function connect(raw) {
  const invite = parseInvite(raw);
  if (!invite) {
    health.lastError = "Einladung nicht lesbar";
    status("Einladung nicht lesbar", "error");
    renderApp();
    return;
  }
  const instance = instanceFrom(invite);
  settings = saveSettings({
    ...settings,
    instances: [...settings.instances.filter((i) => i.id !== instance.id), instance],
    activeInstanceId: instance.id,
  });
  status(`verbunden mit ${instance.name}`, "ok");
  renderApp();
  await testConnection();
}

async function testConnection() {
  const instance = activeInstance(settings);
  if (!instance) return;
  try {
    const source = createSource({ endpoint: instance.baseUrl, token: instance.token });
    const data = await source.load();
    health.lastSync = new Date().toLocaleTimeString("de-DE");
    health.lastError = null;
    status(`${(data.decisions || []).length} offene Entscheidungen`, "ok");
  } catch (error) {
    health.lastError = error.message;
    status(`Verbindung fehlgeschlagen: ${error.message}`, "error");
  }
  renderApp();
}

// --- Fernprotokoll ---------------------------------------------------------
// Auf der Brille gibt es keine Konsole. Ohne diese Meldungen ist jeder
// Startfehler unsichtbar und man raet. Geht nur an den Entwicklungsserver,
// von dem die App selbst geladen wurde.
const DEV = Boolean(import.meta.env?.DEV);
function melde(text) {
  if (!DEV) return; // Produktion: keine Diagnose-Aufrufe
  try {
    fetch(`${location.origin}/__log`, { method: "POST", body: String(text) }).catch(() => {});
  } catch {}
}
window.addEventListener("error", (e) => melde(`FEHLER ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) =>
  melde(`ABBRUCH ${e.reason?.message || e.reason}`),
);

async function main() {
  melde("main() gestartet");
  const bridge = await waitForEvenAppBridge();
  appBridge = bridge;
  melde("Bruecke zur Even-App da");
  // Die Instanz liefert die Karten; die Fixture greift nur, solange kein
  // Endpunkt konfiguriert ist (Simulator, Erststart).
  const instance = activeInstance(settings);
  const live = isLive(settings);
  const source = createSource({
    endpoint: instance?.baseUrl || import.meta.env?.VITE_DECISION_HUB_ENDPOINT || null,
    token: instance?.token || import.meta.env?.VITE_DECISION_HUB_TOKEN || null,
    live,
  });
  plugin = createDecisionHubPlugin({
    sdk: sdkFromBridge(bridge),
    source,
    onPaint: () => renderApp(),
    filter: (decision) => passesFilter(decision, settings),
    sections: settings.sections,
    demo: !live,
    ruhezeitMs: (RUHEZEITEN.find((z) => z.id === settings.ruhezeit) || { ms: 45000 }).ms,
    onError: (error) => {
      console.error("[decision-hub]", error?.stack || error?.message || String(error));
      status(`Fehler: ${error?.message || error}`, "error");
    },
  });

  window.addEventListener(BridgeEvent.EvenHubEvent, (event) => {
    const detail = event.detail ?? event;
    const imu = imuFrom(detail);
    if (imu) {
      melde(`IMU x=${imu.x} y=${imu.y} z=${imu.z}`);
      plugin.handleImu(imu);
      return;
    }
    const osEvent = osEventFrom(detail);
    if (osEvent !== null) {
      melde(`Ereignis ${osEvent}`);
      plugin.handleEvent(osEvent);
      return;
    }
    // Unerkanntes Ereignis: genau hier gehen Kopfneigung und Tasten verloren,
    // wenn das Geraet ein anderes Format schickt als erwartet.
    melde(`UNERKANNT ${JSON.stringify(detail).slice(0, 220)}`);
  });

  // Handy-Bedienung: dieselben Aktionen wie im Brillenmenue.

  // Gyroskop einschalten: ohne Meldungen gibt es keine Kopfneigung.
  // iMUReportEn=1, reportFrq in Hz — niedrig, es geht nur um die Lage.
  await bridge
    .callEvenApp(EvenAppMethod.ImuControl, { iMUReportEn: 1, reportFrq: 5 })
    .then((r) => melde(`IMU eingeschaltet = ${JSON.stringify(r)}`))
    .catch((error) => melde(`IMU-Einschalten fehlgeschlagen: ${error?.message || error}`));

  melde("Plugin startet");
  try {
    await plugin.start();
    melde("Plugin laeuft — Anzeige gesendet");
  } catch (fehler) {
    // Die Brille kann fehlen oder schweigen — die Handy-Ansicht muss dennoch
    // da sein, sonst steht der Nutzer vor einem leeren Bildschirm.
    melde(`Plugin-Start fehlgeschlagen: ${fehler.message}`);
    health.lastError = fehler.message;
  }
  renderApp();
  melde("Handy-Ansicht gezeichnet");
  const count = plugin.state.count;
  status(
    count === 1 ? "1 offene Entscheidung" : `${count} offene Entscheidungen`,
    count > 0 ? "ok" : "warn",
  );
  if (source.kind !== "instance") {
    status("Demo-Daten — noch keine CTOX-Instanz verbunden", "warn");
  }
  health.lastSync = new Date().toLocaleTimeString("de-DE");
  renderApp();
  // Neue Vorgänge nachladen; die Instanz entscheidet, was offen ist.
  setInterval(() => plugin.refresh(), Math.max(10, settings.refreshSeconds) * 1000);
}

main().catch((error) => {
  console.error("[decision-hub] start failed", error?.stack || error?.message || String(error));
  status(`Start fehlgeschlagen: ${error.message}`, "error");
});
