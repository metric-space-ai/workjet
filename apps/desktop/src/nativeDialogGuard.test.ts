// @effect-diagnostics nodeBuiltinImport:off - reads desktop sources as text to guard native dialogs statically.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// FIX-DLG: nothing outside the app. Native message boxes are gone; the single
// remaining native box is the fatal startup error before Electron can create a
// window (`whenReady` failed). Any new native dialog must be justified here.
const ALLOWED: Readonly<Record<string, ReadonlyArray<string>>> = {
  // The wrapper itself.
  "electron/ElectronDialog.ts": ["showErrorBox"],
  // handleFatalStartupError, only when no window can show the in-app line.
  "app/DesktopApp.ts": ["showErrorBox"],
};
const NATIVE = /\b(showMessageBoxSync|showMessageBox|showErrorBox|showCertificateTrustDialog)\b/g;

const sourceFiles = (root: string): string[] =>
  NodeFS.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [full]
      : [];
  });

describe("native dialog guard", () => {
  it("allows native dialogs only in the justified places", () => {
    const root = NodePath.dirname(new URL(import.meta.url).pathname);
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const relative = NodePath.relative(root, file).split(NodePath.sep).join("/");
      const allowed = ALLOWED[relative] ?? [];
      for (const match of NodeFS.readFileSync(file, "utf8").matchAll(NATIVE)) {
        if (!allowed.includes(match[1] ?? "")) offenders.push(`${relative}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("calls showErrorBox outside the wrapper exactly once", () => {
    const root = NodePath.dirname(new URL(import.meta.url).pathname);
    const app = NodeFS.readFileSync(NodePath.join(root, "app/DesktopApp.ts"), "utf8");
    expect(app.match(/\.showErrorBox\(/g)?.length).toBe(1);
  });
});
