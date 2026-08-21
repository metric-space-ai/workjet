// Brillen-Eingaben → Zustandsübergänge des Entscheidungs-Flusses.
//
// Das SDK meldet OsEventTypeList: CLICK_EVENT(0), SCROLL_TOP_EVENT(1),
// SCROLL_BOTTOM_EVENT(2), DOUBLE_CLICK_EVENT(3). Das deckt das vom Owner
// vorgegebene Modell vollständig ab — es ist bewusst dieselbe Logik wie in
// der Desktop-Vorschau: ein durchgehender Fluss aus Text und Icons, an
// dessen Ende das nächste Item beginnt.

import { BODY_LINES, clampScroll } from '../../kundenpipeline-module/core/glasses-renderer.mjs';

export const OS_EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
};

const SCROLL_STEP = 2; // Zeilen je Swipe — gegen Übersensibilität.

/**
 * @param {{scroll:number, focusIcon:number, index:number}} state
 * @param {{lineCount:number, iconCount:number, itemCount:number}} dims
 * @returns {{state:object, action:null|{type:'activate', icon:number}|{type:'back'}}}
 */
export function reduce(state, event, dims) {
  const { lineCount, iconCount, itemCount } = dims;
  const maxScroll = Math.max(0, lineCount - BODY_LINES);
  const next = { ...state };

  switch (event) {
    case OS_EVENT.SCROLL_BOTTOM: {
      if (next.focusIcon < 0) {
        // Im Text: weiterscrollen, am Textende auf das erste Icon wandern.
        const scrolled = clampScroll(next.scroll + SCROLL_STEP, lineCount);
        if (scrolled === next.scroll && next.scroll >= maxScroll) next.focusIcon = 0;
        else next.scroll = scrolled;
      } else if (next.focusIcon < iconCount - 1) {
        next.focusIcon += 1;
      } else {
        // Über das letzte Icon hinaus: nächstes Item.
        next.index = (next.index + 1) % Math.max(1, itemCount);
        next.scroll = 0;
        next.focusIcon = -1;
      }
      return { state: next, action: null };
    }
    case OS_EVENT.SCROLL_TOP: {
      if (next.focusIcon > 0) next.focusIcon -= 1;
      else if (next.focusIcon === 0) next.focusIcon = -1;
      else next.scroll = clampScroll(next.scroll - SCROLL_STEP, lineCount);
      return { state: next, action: null };
    }
    case OS_EVENT.CLICK:
      // Press aktiviert das fokussierte Icon; im Text ist Press wirkungslos.
      return next.focusIcon >= 0
        ? { state: next, action: { type: 'activate', icon: next.focusIcon } }
        : { state: next, action: null };
    case OS_EVENT.DOUBLE_CLICK:
      next.focusIcon = -1;
      return { state: next, action: { type: 'back' } };
    default:
      return { state: next, action: null };
  }
}
