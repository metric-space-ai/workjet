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
  if (data && typeof data === 'object') {
    return { x: Number(data.x) || 0, y: Number(data.y) || 0, z: Number(data.z) || 0 };
  }
  return null;
}

export function osEventFrom(detail) {
  // Der Host liefert BEREITS geparst, z. B.
  //   { jsonData: {...}, textEvent: { containerID, containerName, eventType } }
  // (am Simulator abgegriffen). evenHubEventFromJson erwartet die rohe
  // {type, jsonData}-Form — deshalb zuerst direkt lesen, dann ersatzweise.
  const raw = detail ?? {};
  const direct = raw.textEvent?.eventType ?? raw.listEvent?.eventType;
  if (typeof direct === "number") return direct;
  const parsed = evenHubEventFromJson(raw);
  const type = parsed?.textEvent?.eventType ?? parsed?.listEvent?.eventType;
  return typeof type === "number" ? type : null;
  // sysEvent (Vorder-/Hintergrund, Exit) ist Lebenszyklus, KEINE Eingabe.
}
