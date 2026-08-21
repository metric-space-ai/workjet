// Host-Nutzlast → OsEventTypeList. Bewusst DOM-frei, damit das Wire-Format
// ohne Browser getestet werden kann.
import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk';

export function osEventFrom(detail) {
  // Der Host liefert BEREITS geparst, z. B.
  //   { jsonData: {...}, textEvent: { containerID, containerName, eventType } }
  // (am Simulator abgegriffen). evenHubEventFromJson erwartet die rohe
  // {type, jsonData}-Form — deshalb zuerst direkt lesen, dann ersatzweise.
  const raw = detail ?? {};
  const direct = raw.textEvent?.eventType ?? raw.listEvent?.eventType;
  if (typeof direct === 'number') return direct;
  const parsed = evenHubEventFromJson(raw);
  const type = parsed?.textEvent?.eventType ?? parsed?.listEvent?.eventType;
  return typeof type === 'number' ? type : null;
  // sysEvent (Vorder-/Hintergrund, Exit) ist Lebenszyklus, KEINE Eingabe.
}
