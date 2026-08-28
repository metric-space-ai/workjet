// Firmware-Limit-Pruefungen (references/firmware.md, references/design.md),
// unabhaengig vom SDK-Bridge lauffaehig, damit sie als Unit-Test in Node
// laufen. Ein Verstoss lehnt auf dem echten Geraet die GESAMTE Seite ab --
// diese Pruefungen sind die einzige Verteidigungslinie, weil der Simulator
// grosszuegiger ist als die Firmware.

import { utf8ByteLength } from "@evenrealities/even_hub_sdk";

export const MAX_LIST_ITEMS = 20;
export const MAX_ITEM_NAME_BYTES = 63;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(msg) {
  throw new ValidationError(msg);
}

/**
 * Prueft eine vollstaendige Seitenbeschreibung
 * ({ containerTotalNum, textObject, imageObject, listObject }) gegen alle
 * dokumentierten Firmware-Limits. Wirft ValidationError bei Verstoss.
 */
export function validatePageLayout(layout) {
  const textObject = layout.textObject || [];
  const imageObject = layout.imageObject || [];
  const listObject = layout.listObject || [];

  const realCount = textObject.length + imageObject.length + listObject.length;

  if (realCount < 1 || realCount > 12) {
    fail(`containerTotalNum ausserhalb 1..12: ${realCount}`);
  }
  if (layout.containerTotalNum !== realCount) {
    fail(
      `containerTotalNum (${layout.containerTotalNum}) weicht von der echten Containerzahl (${realCount}) ab`,
    );
  }
  if (textObject.length > 8) {
    fail(`zu viele Text-Container: ${textObject.length} > 8`);
  }
  if (imageObject.length > 4) {
    fail(`zu viele Bild-Container: ${imageObject.length} > 4`);
  }

  for (const img of imageObject) {
    if (img.width < 20 || img.width > 288) {
      fail(`Bildbreite ausserhalb 20..288: ${img.width} (Container ${img.containerID})`);
    }
    if (img.height < 20 || img.height > 144) {
      fail(`Bildhoehe ausserhalb 20..144: ${img.height} (Container ${img.containerID})`);
    }
  }

  // Native Listen-Container: Eintragszahl und Byte-Limit pro Label
  // (evenhub-simulator v0.7.3: max 20 Eintraege, max 63 UTF-8-Byte).
  for (const list of listObject) {
    const ic = list.itemContainer || {};
    const names = ic.itemName || [];
    if (names.length > MAX_LIST_ITEMS) {
      fail(
        `zu viele Listeneintraege: ${names.length} > ${MAX_LIST_ITEMS} (Container ${list.containerID})`,
      );
    }
    if (ic.itemCount !== names.length) {
      fail(
        `itemCount (${ic.itemCount}) weicht von itemName.length (${names.length}) ab (Container ${list.containerID})`,
      );
    }
    for (const name of names) {
      const bytes = utf8ByteLength(name);
      if (bytes > MAX_ITEM_NAME_BYTES) {
        fail(`Listeneintrag ueberschreitet ${MAX_ITEM_NAME_BYTES} Byte: "${name}" (${bytes} Byte)`);
      }
    }
  }

  // Eindeutige containerID ueber alle Container-Arten hinweg.
  const allContainers = [...textObject, ...imageObject, ...listObject];
  const seenIDs = new Map();
  for (const c of allContainers) {
    if (c.containerID === undefined || c.containerID === null) {
      fail("Container ohne containerID");
    }
    if (seenIDs.has(c.containerID)) {
      fail(`doppelte containerID ${c.containerID}`);
    }
    seenIDs.set(c.containerID, true);
  }

  // zOrderIndex: entweder ueberall weggelassen (gueltig, siehe SDK-Doku) oder
  // ueberall gesetzt und eindeutig -- nie gemischt.
  const withZ = allContainers.filter((c) => c.zOrderIndex !== undefined);
  if (withZ.length > 0 && withZ.length !== allContainers.length) {
    fail("zOrderIndex teilweise gesetzt -- muss auf allen Containern oder auf keinem stehen");
  }
  if (withZ.length > 0) {
    const seenZ = new Map();
    for (const c of withZ) {
      if (seenZ.has(c.zOrderIndex)) {
        fail(`doppelter zOrderIndex ${c.zOrderIndex}`);
      }
      seenZ.set(c.zOrderIndex, true);
    }
  }

  // Text-Brightness 0..4, falls gesetzt.
  for (const t of textObject) {
    if (t.textColor !== undefined && (t.textColor < 0 || t.textColor > 4)) {
      fail(`textColor ausserhalb 0..4: ${t.textColor} (Container ${t.containerID})`);
    }
  }

  // isEventCapture darf nie auf einer sichtbaren (nicht-winzigen) TEXT-
  // Flaeche stehen -- sonst OS-Scroll-Bounce auf einer Leseflaeche
  // (rendering.md). Ein `listObject` mit isEventCapture:1 ist dagegen der
  // dokumentierte Normalfall (interaction.md, "The OS list container") und
  // wird hier bewusst nicht eingeschraenkt.
  for (const t of textObject) {
    if (t.isEventCapture === 1 && (t.width > 8 || t.height > 8)) {
      fail(
        `isEventCapture:1 auf einer sichtbaren Textflaeche (${t.width}x${t.height}, Container ${t.containerID}) -- OS-Scroll-Bounce-Risiko`,
      );
    }
  }

  return true;
}
