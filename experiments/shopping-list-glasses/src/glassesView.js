// Orchestriert die Brillenseite ueber das native OS-`listObject`. Die Brille
// zeichnet und bewegt den Auswahlrahmen selbst (kein Funkverkehr, kein
// App-Repaint pro Scrollschritt); die App hoert nur den finalen Klick als
// `listEvent` und reagiert mit genau einem `rebuildPageContainer` (Abhaken
// ist eine strukturelle Aenderung -- die Itemzahl der Liste aendert sich,
// das geht nicht per `textContainerUpgrade`, siehe rendering.md).

import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";
import { buildGlassesPage } from "./glassesLayout.js";
import { validatePageLayout } from "./validate.js";

/**
 * @param {object} deps
 * @param {() => {items: any[]}} deps.getState
 * @param {(id: string, checked: boolean) => void} deps.onToggleChecked
 * @param {(msg: string) => void} [deps.onLog]
 */
export function createGlassesController({ getState, onToggleChecked, onLog }) {
  const log = onLog || (() => {});
  let bridge = null;
  let started = false;
  let indexMap = [];
  let deptPos = 0; // Position in den Abteilungen mit offenen Artikeln
  let deptCount = 0;

  function toContainers(page) {
    return {
      containerTotalNum: page.containerTotalNum,
      textObject: page.textObject.map((t) => new TextContainerProperty(t)),
      imageObject: page.imageObject || [],
      listObject: page.listObject.map(
        (l) =>
          new ListContainerProperty({
            ...l,
            itemContainer: new ListItemContainerProperty(l.itemContainer),
          }),
      ),
    };
  }

  async function bilderSenden(bau) {
    // Nach create/rebuild sind die Bildcontainer leer — immer neu senden
    // (rendering.md: ein Neuaufbau ersetzt die Container).
    for (const b of bau.bitmaps || []) {
      const r = await bridge.updateImageRawData({
        containerID: b.containerID,
        imageData: b.imageData,
      });
      if (r !== 0 && r !== "success") log(`updateImageRawData ${b.containerID} -> ${r}`);
    }
  }

  function uebernehmen(bau) {
    indexMap = bau.indexMap || [];
    deptPos = bau.deptPos || 0;
    deptCount = bau.deptCount || 0;
  }

  async function start() {
    bridge = await waitForEvenAppBridge();
    const bau = buildGlassesPage(getState().items, deptPos);
    validatePageLayout(bau.page);
    uebernehmen(bau);
    const container = new CreateStartUpPageContainer(toContainers(bau.page));
    const result = await bridge.createStartUpPageContainer(container);
    log(`createStartUpPageContainer -> ${result}`);
    started = true;
    await bilderSenden(bau);
    bridge.onEvenHubEvent(handleEvent);
    return result;
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.listEvent) {
      const le = event.listEvent;
      // Protobuf laesst eventType=0 (Klick) weg -- ein listEvent ohne
      // eventType IST der Klick (firmware.md, "The OS list container";
      // derselbe Trick wie beim sysEvent-Klick). Derselbe Zero-Omission-Trick
      // trifft AUCH currentSelectItemIndex: ist das oberste Item (Index 0)
      // ausgewaehlt, fehlt das Feld komplett im JSON (im Simulator
      // beobachtet: nach dem ersten rebuildPageContainer, wo die Auswahl auf
      // das oberste Item zurueckspringt, meldet der Klick nur noch
      // {containerID, containerName} -- ohne currentSelectItemIndex). Ein
      // Decoder, der ein fehlendes Feld als "kein Index" statt "Index 0"
      // liest, verliert jeden Klick auf das oberste (staendig hervorgehobene)
      // Item -- praktisch die Haelfte aller Klicks in dieser App.
      const isClick = le.eventType === undefined;
      if (isClick) {
        const index = typeof le.currentSelectItemIndex === "number" ? le.currentSelectItemIndex : 0;
        onListClick(index);
        return;
      }
      log(`unbehandeltes listEvent: ${JSON.stringify(le)}`);
      return;
    }
    if (event.sysEvent) {
      // Doppeldruck = naechste Abteilung (die Gestengrammatik laesst der
      // OS-Liste Scroll und Klick; der Doppeldruck kommt als sysEvent an).
      if (event.sysEvent.eventType === 3 && deptCount > 1) {
        deptPos = (deptPos + 1) % deptCount;
        rebuild();
        return;
      }
      log(`sysEvent ohne Aktion: ${JSON.stringify(event.sysEvent)}`);
    }
  }

  function onListClick(index) {
    const id = indexMap[index];
    if (!id) return;
    onToggleChecked(id, true);
    rebuild();
  }

  async function rebuild() {
    if (!started) return;
    const bau = buildGlassesPage(getState().items, deptPos);
    validatePageLayout(bau.page);
    uebernehmen(bau);
    const container = new RebuildPageContainer(toContainers(bau.page));
    const result = await bridge.rebuildPageContainer(container);
    log(`rebuildPageContainer -> ${result}`);
    await bilderSenden(bau);
  }

  /** Vom Telefon-UI aufgerufen, wenn sich die Liste extern (dort) aendert. */
  function notifyStateChanged() {
    rebuild();
  }

  return { start, notifyStateChanged, handleEvent };
}
