// Host-Nutzlast → OsEventTypeList. Bewusst DOM-frei, damit das Wire-Format
// ohne Browser getestet werden kann.
import { evenHubEventFromJson } from "@evenrealities/even_hub_sdk";

/** Menuepunkt-ID, wenn die Brille einen Aktionspunkt gewaehlt hat. */
export function menuItemFrom(detail) {
  const id = detail?.menuItemClickEvent?.itemID ?? detail?.jsonData?.itemID;
  return typeof id === "number" ? id : null;
}

/** IMU-Messwerte, wenn die Brille Bewegungsdaten meldet. */
export function imuFrom(detail) {
  const data = detail?.sysEvent?.imuData || detail?.sysEvent?.IMU_Data || detail?.jsonData?.imuData;
  if (data && typeof data === "object") {
    return { x: Number(data.x) || 0, y: Number(data.y) || 0, z: Number(data.z) || 0 };
  }
  return null;
}

export function osEventFrom(detail) {
  // Der Host liefert die Nutzlast BEREITS geparst. Zwei Faelle:
  //
  //  * textEvent/listEvent tragen den eventType direkt (Scrollen).
  //  * Druck und Doppeldruck kommen als sysEvent. ACHTUNG: Protobuf laesst
  //    Nullwerte weg, deshalb fehlt bei CLICK_EVENT (0) das Feld eventType
  //    voellig — ein sysEvent mit eventSource und ohne eventType IST der
  //    Druck. Am Simulator abgegriffen; das hat mich einen halben Tag
  //    gekostet, weil ich sysEvent als reinen Lebenszyklus abgetan hatte.
  const raw = detail ?? {};

  const direct = raw.textEvent?.eventType ?? raw.listEvent?.eventType;
  if (typeof direct === "number") return direct;

  const sys = raw.sysEvent;
  if (sys) {
    const type = sys.eventType;
    // Vorder-/Hintergrund und Exit sind Lebenszyklus, keine Geste.
    if (type === 4 || type === 5 || type === 6 || type === 7 || type === 8) return null;
    if (typeof type === "number") return type;
    if (sys.eventSource !== undefined) return 0; // CLICK_EVENT
    return null;
  }

  const parsed = evenHubEventFromJson(raw);
  const type = parsed?.textEvent?.eventType ?? parsed?.listEvent?.eventType;
  return typeof type === "number" ? type : null;
}
