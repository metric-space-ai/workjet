/**
 * Wächter zum UI-Vertrag §8 (Pflicht, im Repo).
 *
 * Schlägt fehl bei neuen Verstößen gegen:
 * (a) DialogDescription, EmptyDescription oder SettingsRow `description`
 *     mit einem Satz über 12 Wörter;
 * (b) `hover:underline` bzw. `underline` auf button/a mit onClick
 *     (unterstrichene Textaktionen);
 * (c) den verbotenen Icon-Zuordnungen aus §5;
 * (d) englischen Literal-Strings in JSX der Einstellungen, Dialoge und
 *     Leerzustände, nach einer Allowlist für Eigennamen.
 *
 * Bestehende Verstöße stehen in uiContractBaseline.json. Die Baseline darf
 * nur schrumpfen: Eintrag löschen, sobald der Verstoß abgebaut ist.
 */
// @effect-diagnostics nodeBuiltinImport:off - Der Wächter liest Quelldateien und die Baseline direkt.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { collectUiContractViolations } from "./uiContract.guard";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

interface Baseline {
  readonly verstoesse: ReadonlyArray<string>;
}

function readBaseline(): ReadonlySet<string> {
  const raw = readFileSync(join(SRC_ROOT, "uiContractBaseline.json"), "utf8");
  const parsed = JSON.parse(raw) as Baseline;
  return new Set(parsed.verstoesse);
}

describe("UI-Vertrag §8 Wächter", () => {
  it("meldet keine neuen Verstöße über der Baseline", () => {
    const baseline = readBaseline();
    const current = collectUiContractViolations(SRC_ROOT);
    const neueVerstoesse = current.filter((v: string) => !baseline.has(v));
    expect(
      neueVerstoesse,
      `Neue Verstöße gegen den UI-Vertrag (§8):\n${neueVerstoesse.join("\n")}\n\n` +
        "Beheben, nicht in die Baseline aufnehmen. Die Baseline darf nur schrumpfen.",
    ).toEqual([]);
  });

  it("Baseline enthält keine Phantom-Einträge mit Zeilenangaben", () => {
    const baseline = readBaseline();
    for (const entry of baseline) {
      expect(entry.split("|").length).toBe(3);
    }
  });
});
