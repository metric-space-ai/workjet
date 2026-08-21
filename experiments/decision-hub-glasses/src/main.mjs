// Einstiegspunkt im Handy-WebView: Bridge holen, Plugin starten, Ereignisse
// der Brille durchreichen. Die Entscheidungslogik liegt bewusst nicht hier.

import {
  waitForEvenAppBridge,
  BridgeEvent,
  EvenAppMethod,
} from '@evenrealities/even_hub_sdk';
import { createDecisionHubPlugin } from './plugin.mjs';
import { createSource } from './source.mjs';
import { osEventFrom } from './event-decode.mjs';

const status = (text) => {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
};

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
  const plugin = createDecisionHubPlugin({
    sdk: sdkFromBridge(bridge),
    source: createSource(),
    onError: (error) => {
      console.error('[decision-hub]', error);
      status(`Fehler: ${error.message}`);
    },
  });

  window.addEventListener(BridgeEvent.EvenHubEvent, (event) => {
    const osEvent = osEventFrom(event.detail ?? event);
    if (osEvent !== null) plugin.handleEvent(osEvent);
  });

  await plugin.start();
  status(`Decision Hub aktiv · ${plugin.state.count} offene Entscheidungen`);
  // Neue Vorgänge nachladen; die Instanz entscheidet, was offen ist.
  setInterval(() => plugin.refresh(), 30000);
}

main().catch((error) => {
  console.error('[decision-hub] start failed', error);
  status(`Start fehlgeschlagen: ${error.message}`);
});
