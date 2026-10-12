import { useCallback } from "react";

import { useTheme } from "../../hooks/useTheme";
import { getThemeDefinition, type ThemeAppearance, type ThemeDefinition } from "../../themePalette";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { useThemeEditorStore } from "./themeEditorStore";

/**
 * Früher schwebte der Editor über dem Router. Er sitzt jetzt inline auf der
 * Seite Darstellung (ThemeEditorSection in ThemeLibrary); dieser Host rendert
 * nichts mehr und bleibt nur, bis die Einbindung in routes/__root.tsx entfällt.
 */
export function ThemeEditorHost() {
  return null;
}

/**
 * Der Theme-Editor als Abschnitt auf der Seite Darstellung. Die Sitzung liegt
 * im Store, damit ein Befehl (Befehlspalette) den Editor öffnen kann; sichtbar
 * ist er nur dort, wo dieser Abschnitt gerendert wird.
 */
export function ThemeEditorSection() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();

  // The panel reports which path it actually took: a theme removed while its
  // editor is open resolves to null there, so the save becomes a create even
  // though the session still names it.
  const handleSaved = useCallback(
    (
      savedTheme: ThemeDefinition,
      { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
    ) => {
      // A merge completed an existing theme's light/dark pair; activating the
      // whole theme shows the new palette right away.
      if (mergedAppearance) {
        if (!setTheme(savedTheme.id)) {
          toastManager.add(stackedThreadToast({ type: "error", title: "Theme nicht gespeichert" }));
          return false;
        }
        toastManager.add(
          stackedThreadToast({ type: "success", title: `${savedTheme.label} aktualisiert` }),
        );
        return true;
      }
      if (!created) {
        // The edited theme may be showing through the base preference or either
        // half of the mix; the preference itself is untouched (a setTheme here
        // would clear the mix), the palette just needs re-applying.
        const wasActive =
          getThemeDefinition(theme)?.id === savedTheme.id ||
          themeHalves?.light === savedTheme.id ||
          themeHalves?.dark === savedTheme.id;
        if (wasActive) refreshTheme();
        toastManager.add(
          stackedThreadToast({ type: "success", title: `${savedTheme.label} gespeichert` }),
        );
        return true;
      }

      if (!setTheme(savedTheme.id)) {
        toastManager.add(stackedThreadToast({ type: "error", title: "Theme nicht gespeichert" }));
        return false;
      }
      toastManager.add(
        stackedThreadToast({ type: "success", title: `${savedTheme.label} erstellt` }),
      );
      return true;
    },
    [refreshTheme, setTheme, theme, themeHalves],
  );

  if (!session) return null;

  // Resolve on every render: an edit or import can change the stored
  // definitions while a session is open.
  const editingTheme = session.editingThemeId
    ? (getThemeDefinition(session.editingThemeId) ?? null)
    : null;
  const seedTheme = session.seedThemeId ? (getThemeDefinition(session.seedThemeId) ?? null) : null;

  return (
    <ThemeEditorPanel
      editingTheme={editingTheme}
      initialAppearance={session.initialAppearance}
      key={session.id}
      onOpenChange={(open) => {
        if (!open) closeThemeEditor();
      }}
      onSaved={handleSaved}
      open
      restoreTheme={refreshTheme}
      seedName={session.seedName ?? undefined}
      seedTheme={seedTheme}
    />
  );
}
