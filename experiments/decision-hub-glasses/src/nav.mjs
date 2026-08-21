// Navigation der Entscheidungsvorlage.
//
// Ein Scroll = eine Rubrik weiter (KEIN Textscroll). Druck klappt die Rubrik
// auf; dort blaettert ein Scroll seitenweise. Hinter der letzten Rubrik faehrt
// der Fokus in die Entscheidungs-Icons — dort ist der Scroll die Auswahl.
// Doppeldruck geht eine Ebene zurueck.

import { LEVEL } from './layout.mjs';

export const OS_EVENT = { CLICK: 0, SCROLL_TOP: 1, SCROLL_BOTTOM: 2, DOUBLE_CLICK: 3 };

export function initialNav() {
  return { sectionIndex: 0, page: 0, level: LEVEL.RUBRIK, focusIcon: -1 };
}

/**
 * @param {object} nav  { sectionIndex, page, level, focusIcon }
 * @param {number} event OsEventTypeList
 * @param {object} dims  { sections, pages, icons }
 * @returns {{nav:object, action:null|{type:'activate',icon:number}|{type:'collapse'}|{type:'nextCase'}}}
 */
export function navigate(nav, event, dims) {
  const next = { ...nav };
  const lastSection = Math.max(0, dims.sections - 1);

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
      if (next.focusIcon === 0) { next.focusIcon = -1; return { nav: next, action: null }; }
      if (next.level === LEVEL.DETAIL) {
        if (next.page > 0) next.page -= 1;
        else next.level = LEVEL.RUBRIK;
        return { nav: next, action: null };
      }
      if (next.sectionIndex > 0) next.sectionIndex -= 1;
      return { nav: next, action: null };

    case OS_EVENT.CLICK:
      if (next.focusIcon >= 0) return { nav: next, action: { type: 'activate', icon: next.focusIcon } };
      // Druck auf eine Rubrik laedt die vollstaendige Fassung.
      if (next.level === LEVEL.RUBRIK) { next.level = LEVEL.DETAIL; next.page = 0; }
      return { nav: next, action: null };

    case OS_EVENT.DOUBLE_CLICK:
      if (next.focusIcon >= 0) { next.focusIcon = -1; return { nav: next, action: null }; }
      if (next.level === LEVEL.DETAIL) { next.level = LEVEL.RUBRIK; next.page = 0; return { nav: next, action: { type: 'collapse' } }; }
      return { nav: next, action: null };

    default:
      return { nav: next, action: null };
  }
}
