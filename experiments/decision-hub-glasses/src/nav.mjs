// Navigation der Entscheidungsvorlage.
//
// Ein Scroll = eine Rubrik weiter (KEIN Textscroll). Druck klappt die Rubrik
// auf; dort blaettert ein Scroll seitenweise. Hinter der letzten Rubrik faehrt
// der Fokus in die Entscheidungs-Icons — dort ist der Scroll die Auswahl.
// Doppeldruck geht eine Ebene zurueck.

import { LEVEL } from './layout.mjs';

export const OS_EVENT = { CLICK: 0, SCROLL_TOP: 1, SCROLL_BOTTOM: 2, DOUBLE_CLICK: 3 };

/**
 * Startzustand: die Vorgangsliste. Sie ist ein OS-Listencontainer — die
 * Brille bewegt den Auswahlrahmen selbst (animiert, ohne Funkverkehr) und
 * meldet erst den Klick. Deshalb ignoriert navigate() auf dieser Ebene alle
 * Gesten; die Auswahl kommt als listEvent herein.
 */
export function initialNav() {
  return { sectionIndex: 0, page: 0, level: LEVEL.LISTE, focusIcon: -1, picker: null, pickerIndex: 0 };
}

/** Zustand beim Betreten eines Vorgangs — erste Rubrik, nichts fokussiert. */
export function caseNav() {
  return { sectionIndex: 0, page: 0, level: LEVEL.RUBRIK, focusIcon: -1, picker: null, pickerIndex: 0 };
}

/** Wiedervorlage-Optionen — der Druck auf die Uhr fragt danach. */
export const SNOOZE_OPTIONS = [
  { id: '1h', label: 'in 1 Stunde', minutes: 60 },
  { id: '3h', label: 'in 3 Stunden', minutes: 180 },
  { id: 'abend', label: 'heute Abend', minutes: 8 * 60 },
  { id: 'morgen', label: 'morgen früh', minutes: 20 * 60 },
  { id: 'woche', label: 'nächste Woche', minutes: 7 * 24 * 60 },
];

/**
 * @param {object} nav  { sectionIndex, page, level, focusIcon }
 * @param {number} event OsEventTypeList
 * @param {object} dims  { sections, pages, icons }
 * @returns {{nav:object, action:null|{type:'activate',icon:number}|{type:'collapse'}|{type:'nextCase'}}}
 */
export function navigate(nav, event, dims) {
  const next = { ...nav };
  const lastSection = Math.max(0, dims.sections - 1);

  // Steht eine Auswahl offen (z. B. Wiedervorlage), bedient das Scrollen sie
  // und nichts anderes — sonst verliert man versehentlich die Auswahl.
  if (next.picker) {
    const count = next.picker.options.length;
    if (event === OS_EVENT.SCROLL_BOTTOM) {
      next.pickerIndex = (next.pickerIndex + 1) % count;
      return { nav: next, action: null };
    }
    if (event === OS_EVENT.SCROLL_TOP) {
      next.pickerIndex = (next.pickerIndex - 1 + count) % count;
      return { nav: next, action: null };
    }
    if (event === OS_EVENT.CLICK) {
      const option = next.picker.options[next.pickerIndex];
      return {
        nav: { ...next, picker: null, pickerIndex: 0 },
        action: { type: 'pick', kind: next.picker.kind, option },
      };
    }
    if (event === OS_EVENT.DOUBLE_CLICK) {
      return { nav: { ...next, picker: null, pickerIndex: 0 }, action: null };
    }
    return { nav: next, action: null };
  }

  // Auf der Listenebene gehoeren die Gesten dem OS-Listencontainer; hier
  // kommt hoechstens ein Echo an, das nichts bedeuten darf.
  if (next.level === LEVEL.LISTE) return { nav: next, action: null };

  switch (event) {
    case OS_EVENT.SCROLL_BOTTOM:
      if (next.focusIcon >= 0) {
        if (next.focusIcon < dims.icons - 1) next.focusIcon += 1;
        else return { nav: { ...next, focusIcon: -1, sectionIndex: 0, page: 0, level: LEVEL.RUBRIK }, action: { type: 'nextCase' } };
        return { nav: next, action: null };
      }
      if (next.level === LEVEL.DETAIL) {
        if (next.page < dims.pages - 1) {
          next.page += 1;
          return { nav: next, action: null };
        }
        // Ende der Langfassung: NICHT zurueck in die Kurzfassung, sondern
        // weiter zur naechsten Seite — der Lesefluss bricht sonst ab.
        next.level = LEVEL.RUBRIK;
        next.page = 0;
        if (next.sectionIndex < lastSection) next.sectionIndex += 1;
        else next.focusIcon = 0;
        return { nav: next, action: null };
      }
      if (next.sectionIndex < lastSection) next.sectionIndex += 1;
      else next.focusIcon = 0; // hinter der letzten Rubrik beginnen die Icons
      return { nav: next, action: null };

    case OS_EVENT.SCROLL_TOP:
      if (next.focusIcon > 0) { next.focusIcon -= 1; return { nav: next, action: null }; }
      if (next.focusIcon === 0) {
        // Von den Icons zurueck auf die letzte Seite des Vorgangs.
        next.focusIcon = -1;
        next.sectionIndex = lastSection;
        return { nav: next, action: null };
      }
      if (next.level === LEVEL.DETAIL) {
        if (next.page > 0) next.page -= 1;
        else next.level = LEVEL.RUBRIK;
        return { nav: next, action: null };
      }
      if (next.sectionIndex > 0) {
        next.sectionIndex -= 1;
        return { nav: next, action: null };
      }
      // Vor der ersten Seite geht es zum VORHERIGEN Action Item — spiegelbildlich
      // zum Weg nach unten, der hinter den Icons beim naechsten landet. Ohne das
      // endet der Weg nach oben in einer Sackgasse.
      return {
        nav: { ...next, sectionIndex: 0, page: 0, level: LEVEL.RUBRIK, focusIcon: dims.icons - 1 },
        action: { type: 'prevCase' },
      };

    case OS_EVENT.CLICK:
      if (next.focusIcon >= 0) return { nav: next, action: { type: 'activate', icon: next.focusIcon } };
      // Druck schaltet zwischen Kurz- und Langfassung um. Ein zweiter Druck
      // muss zurueckfuehren, sonst kommt man aus der Langfassung nur durch
      // Weiterscrollen heraus.
      next.level = next.level === LEVEL.RUBRIK ? LEVEL.DETAIL : LEVEL.RUBRIK;
      next.page = 0;
      return { nav: next, action: null };

    case OS_EVENT.DOUBLE_CLICK:
      if (next.focusIcon >= 0) { next.focusIcon = -1; return { nav: next, action: null }; }
      if (next.level === LEVEL.DETAIL) { next.level = LEVEL.RUBRIK; next.page = 0; return { nav: next, action: { type: 'collapse' } }; }
      // Aus dem Vorgang zurueck zur Liste — der Weg nach oben in der
      // Hierarchie ist immer der Doppeldruck.
      return { nav: next, action: { type: 'zurListe' } };

    default:
      return { nav: next, action: null };
  }
}
