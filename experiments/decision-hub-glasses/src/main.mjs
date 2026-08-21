// Einstiegspunkt im Handy-WebView: Bridge holen, Plugin starten, Ereignisse
// der Brille durchreichen. Die Entscheidungslogik liegt bewusst nicht hier.

import {
  waitForEvenAppBridge,
  BridgeEvent,
  EvenAppMethod,
} from '@evenrealities/even_hub_sdk';
import { createDecisionHubPlugin } from './plugin.mjs';
import { tabsLine, bodyText, iconsLine } from './view-to-containers.mjs';
import { createSource } from './source.mjs';
import { osEventFrom, menuItemFrom } from './event-decode.mjs';

const $ = (sel) => document.querySelector(sel);

function status(text, state = 'warn') {
  const el = $('[data-dh-status]');
  if (el) el.textContent = text;
  const dot = $('[data-dh-dot]');
  if (dot) dot.dataset.state = state;
}

function hint(text) {
  const el = $('[data-dh-hint]');
  if (el) el.textContent = text;
}

// Spiegel: exakt die drei Container, die auch die Brille bekommt.
function mirror(view) {
  const tabs = $('[data-dh-tabs]');
  const body = $('[data-dh-body]');
  const icons = $('[data-dh-icons]');
  if (!tabs || !body || !icons) return;
  if (!view) {
    tabs.textContent = '';
    body.textContent = 'Keine offene Entscheidung.';
    icons.textContent = '';
    return;
  }
  tabs.textContent = tabsLine(view.tabs);
  body.textContent = bodyText(view);
  icons.textContent = iconsLine(view);
}

/** Das SDK spricht über `callEvenApp`; hier die drei Aufrufe, die wir nutzen. */
function sdkFromBridge(bridge) {
  return {
    createStartUpPageContainer: (page) =>
      bridge.callEvenApp(EvenAppMethod.CreateStartUpPageContainer, page),
    rebuildPageContainer: (page) =>
      bridge.callEvenApp(EvenAppMethod.RebuildPageContainer, page),
    textContainerUpgrade: (update) =>
      bridge.callEvenApp(EvenAppMethod.TextContainerUpgrade, update),
  };
}

async function main() {
  const bridge = await waitForEvenAppBridge();
  // Die Instanz liefert die Karten; die Fixture greift nur, solange kein
  // Endpunkt konfiguriert ist (Simulator, Erststart).
  const source = createSource({
    endpoint: import.meta.env?.VITE_DECISION_HUB_ENDPOINT || null,
    token: import.meta.env?.VITE_DECISION_HUB_TOKEN || null,
  });
  const plugin = createDecisionHubPlugin({
    sdk: sdkFromBridge(bridge),
    source,
    onPaint: mirror,
    onError: (error) => {
      console.error('[decision-hub]', error);
      status(`Fehler: ${error.message}`, 'error');
    },
  });

  window.addEventListener(BridgeEvent.EvenHubEvent, (event) => {
    const detail = event.detail ?? event;
    const menuItem = menuItemFrom(detail);
    if (menuItem !== null) {
      plugin.handleMenu(menuItem);
      return;
    }
    const osEvent = osEventFrom(detail);
    if (osEvent !== null) plugin.handleEvent(osEvent);
  });

  // Handy-Bedienung: dieselben Aktionen wie im Brillenmenue.
  for (const button of document.querySelectorAll('[data-dh-act]')) {
    button.addEventListener('click', () => plugin.act(button.dataset.dhAct));
  }

  await plugin.start();
  const count = plugin.state.count;
  status(
    count === 1 ? '1 offene Entscheidung' : `${count} offene Entscheidungen`,
    count > 0 ? 'ok' : 'warn',
  );
  hint(
    source.kind === 'instance'
      ? 'Quelle: eigene Instanz'
      : 'Quelle: Demo-Daten — noch keine Instanz konfiguriert',
  );
  // Neue Vorgänge nachladen; die Instanz entscheidet, was offen ist.
  setInterval(() => plugin.refresh(), 30000);
}

main().catch((error) => {
  console.error('[decision-hub] start failed', error);
  status(`Start fehlgeschlagen: ${error.message}`, 'error');
});
