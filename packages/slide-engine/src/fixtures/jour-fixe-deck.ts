import { parseSlideDocument, type SlideDocument } from "../schema";
import jourFixeDeckJson from "../../fixtures/jour-fixe-deck.json";

/**
 * German Jour fixe deck: title slide, KPI slide (`business.kpi-bars`), trend slide
 * (`business.trend`), bullet slide with speaker notes and a slide with a native canvas.
 * The JSON file is the source; CTOX copies it verbatim as its validator test fixture.
 */
export const jourFixeDeck: SlideDocument = parseSlideDocument(jourFixeDeckJson);
