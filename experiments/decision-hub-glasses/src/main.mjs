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
} from "./settings.mjs";
import { osEventFrom, menuItemFrom } from "./event-decode.mjs";

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
    updateImageRawData: (data) =>
      bridge.callEvenApp(EvenAppMethod.UpdateImageRawData, data),
    rebuildPageContainer: (page) => bridge.callEvenApp(EvenAppMethod.RebuildPageContainer, page),
    textContainerUpgrade: (update) =>
      bridge.callEvenApp(EvenAppMethod.TextContainerUpgrade, update),
    imuControl: (cmd) => bridge.callEvenApp(EvenAppMethod.ImuControl, cmd),
  };
}

let plugin = null;
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

async function main() {
  const bridge = await waitForEvenAppBridge();
  // Die Instanz liefert die Karten; die Fixture greift nur, solange kein
  // Endpunkt konfiguriert ist (Simulator, Erststart).
  const instance = activeInstance(settings);
  const source = createSource({
    endpoint: instance?.baseUrl || import.meta.env?.VITE_DECISION_HUB_ENDPOINT || null,
    token: instance?.token || import.meta.env?.VITE_DECISION_HUB_TOKEN || null,
  });
  plugin = createDecisionHubPlugin({
    sdk: sdkFromBridge(bridge),
    source,
    onPaint: () => renderApp(),
    filter: (decision) => passesFilter(decision, settings),
    sections: settings.sections,
    onError: (error) => {
      console.error("[decision-hub]", error?.stack || error?.message || String(error));
      status(`Fehler: ${error?.message || error}`, "error");
    },
  });

  window.addEventListener(BridgeEvent.EvenHubEvent, (event) => {
    const detail = event.detail ?? event;
    const imu = imuFrom(detail);
    if (imu) {
      plugin.handleImu(imu);
      return;
    }
    const osEvent = osEventFrom(detail);
    if (osEvent !== null) plugin.handleEvent(osEvent);
  });

  // Handy-Bedienung: dieselben Aktionen wie im Brillenmenue.

  // Gyroskop einschalten: ohne Meldungen gibt es keine Kopfneigung.
  // iMUReportEn=1, reportFrq in Hz — niedrig, es geht nur um die Lage.
  await bridge.callEvenApp(EvenAppMethod.ImuControl, { iMUReportEn: 1, reportFrq: 5 })
    .catch((error) => console.warn('[decision-hub] IMU nicht verfügbar', error?.message || error));

  await plugin.start();
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
