/**
 * Wächter „drei Orte“ (Owner-Vorgabe 11.10.2026): Die App hat genau drei
 * Orte – Dev, Ops und Einstellungen – und keine Popups. Erlaubt sind nur
 * reine Auswahlmenüs (Menu, Select), Tooltips und einzeilige Toasts.
 *
 * Dieser Test schlägt fehl, sobald eine neue Seite außerhalb der drei Orte
 * oder ein Dialog, Sheet, Drawer oder Popover mit Inhalt hinzukommt.
 */
// @effect-diagnostics nodeBuiltinImport:off - Der Wächter liest Quelldateien direkt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(dir)) {
    const path = NodePath.join(dir, entry);
    if (NodeFS.statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "fixtures") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|stories)\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Routen der drei Orte plus Anmelde-Oberflächen ohne App-Hülle. */
const ERLAUBTE_ROUTEN = [
  /^__root\.tsx$/,
  /^_chat(\..+)?\.tsx$/, // Dev: Projekte, Chats, PR-Ansicht des Projekts
  /^settings(\..+)?\.tsx$/, // Einstellungen mit allen Unterseiten
  /^pair\.tsx$/, // Browser-Pairing (ohne App-Hülle)
  /^connect(_\..+)?\.tsx$/, // CLI-Anmeldung (ohne App-Hülle)
];

/** Bausteine, die ein Popup mit Inhalt öffnen. */
const POPUP_IMPORT =
  /from\s+["'](?:~|\.{1,2}(?:\/\.\.)*)\/(?:components\/)?ui\/(dialog|alert-dialog|sheet|drawer|popover)["']/;
/** Inline-Befehlslisten (Composer) sind erlaubt, der modale Befehlsdialog nicht. */
const BEFEHLSDIALOG = /\bCommandDialog\b/;
const POPUP_ROLLE = /\srole=["']dialog["']/; // JSX-Attribut, nicht CSS-Selektor

describe("drei Orte: Dev, Ops, Einstellungen", () => {
  it("hat keine Route außerhalb der drei Orte", () => {
    const routes = NodeFS.readdirSync(NodePath.join(SRC, "routes")).filter(
      (file) => file.endsWith(".tsx") && !file.startsWith("-") && !file.endsWith(".test.tsx"),
    );
    const fremd = routes.filter((file) => !ERLAUBTE_ROUTEN.some((pattern) => pattern.test(file)));
    expect(fremd, "Seiten außerhalb von Dev, Ops und Einstellungen").toEqual([]);
  });

  it("öffnet nirgends ein Dialog, Sheet, Drawer oder Popover mit Inhalt", () => {
    const funde: string[] = [];
    for (const file of walk(SRC)) {
      const rel = NodePath.relative(SRC, file);
      if (rel.startsWith("components/ui/")) continue; // die Bausteine selbst
      const text = NodeFS.readFileSync(file, "utf8");
      const imp = text.match(POPUP_IMPORT);
      if (imp) funde.push(`${rel}: importiert ui/${imp[1]}`);
      if (POPUP_ROLLE.test(text)) funde.push(`${rel}: role="dialog"`);
      if (BEFEHLSDIALOG.test(text)) funde.push(`${rel}: CommandDialog`);
    }
    expect(funde, "Popups widersprechen der Owner-Vorgabe „kein Popup“").toEqual([]);
  });
});
