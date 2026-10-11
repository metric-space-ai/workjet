import { MousePointer2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createVividThemeColors,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import {
  clearThemeInspectorHover,
  clearThemeInspectorHighlights,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

const THEME_EDITOR_PRIMARY_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "chrome",
  "sidebar",
  "surface",
  "text",
  "textMuted",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "accent",
  "messageSurface",
  "messageAction",
];

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

const THEME_EDITOR_STATUS_ROLES: ReadonlyArray<ThemeColorRole> = [
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
];

const THEME_EDITOR_ADVANCED_ROLES = THEME_COLOR_ROLES.filter(
  (role) => !THEME_EDITOR_PRIMARY_ROLES.includes(role) && !THEME_EDITOR_STATUS_ROLES.includes(role),
);

const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  roles: ReadonlyArray<ThemeColorRole>;
}> = [
  {
    id: "main",
    title: "Hauptfarben",
    roles: THEME_EDITOR_PRIMARY_ROLES,
  },
  {
    id: "status",
    title: "Statusfarben",
    roles: THEME_EDITOR_STATUS_ROLES,
  },
  {
    id: "additional",
    title: "Weitere Farben",
    roles: THEME_EDITOR_ADVANCED_ROLES,
  },
];

type ThemeEditorColors = Record<ThemeColorRole, string>;
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

// A draft with no source theme starts as the standard Workjet look — the
// palette on screen when no theme is installed — so creating from the default
// theme changes nothing until the user edits a color.
function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

function paletteAdjective(appearance: ThemeAppearance): string {
  return appearance === "light" ? "helle" : "dunkle";
}

function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getStandardThemeColors(appearance);
  // The editor keeps the user's exact picks and derives the rest through the
  // perceptual vivid engine, so a two-color theme carries its own identity.
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      /** Set when a create merged its palette into an existing theme. */
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  /** The theme a new theme starts from, so tuning what you already use is a
   *  matter of editing rather than rebuilding. Null starts from the defaults. */
  seedTheme?: ThemeDefinition | null;
  /** Prefilled name for an explicit duplicate; a plain create stays unnamed. */
  seedName?: string | undefined;
  /** Reapplies the stored theme once the draft stops being previewed. */
  restoreTheme: () => void;
}) {
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [showAllColors, setShowAllColors] = useState(false);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });
  const [error, setError] = useState<string | null>(null);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The draft only reaches the live app once this open has been seeded;
  // previewing in the seeding commit would paint the previous session's
  // colors for a frame.
  const [isDraftSeeded, setIsDraftSeeded] = useState(false);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      // Editing works on the theme itself; creating starts from the theme
      // that is currently in use, so tuning what you already run is an edit
      // away instead of a rebuild from the defaults.
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;
      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Themes saved by the guided editor carry the managed flag; anything
      // else (imports, hand-edited files, older saves) opens on "Alle Farben"
      // so guided regeneration cannot silently discard hand-tuned colors. A
      // seeded new theme follows the same rule: its palette is only safe to
      // regenerate when the guided editor produced it.
      setShowAllColors(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setColorsByAppearance(nextColors);
      setSelectedRole(null);
      setUsageCount(null);
      setIsInspecting(false);
      setError(null);
      setIsDraftSeeded(true);
    }
    if (!open && isDraftSeeded) setIsDraftSeeded(false);
    previousOpenRef.current = open;
  }, [editingTheme, initialAppearance, isDraftSeeded, open, seedName, seedTheme]);

  // A name an installed theme already uses combines instead of failing:
  // creating adds the new palette to that theme, and renaming an existing
  // theme onto it folds the edited palette in and retires the old entry —
  // light "My Theme" plus a dark "My Theme" become one theme with both modes.
  // Labels are matched as well as derived ids: a rename keeps a theme's
  // original id, so its label is the only name a user can see and retype.
  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();
  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  // The appearance a mode button would produce can be blocked two ways: the
  // merge target already has that palette, or the theme being edited never
  // had it (adding one is a create-with-same-name away).
  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return `„${editingTheme?.label}“ hat keine ${paletteAdjective(appearance)} Palette.`;
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return `„${mergeTarget?.label}“ hat bereits eine ${paletteAdjective(appearance)} Palette.`;
    }
    return null;
  };

  // Typing a name whose theme already owns the selected appearance flips the
  // draft to the free side, so the merge affordance works without a manual
  // toggle. Both sides taken leaves the selection alone; save is blocked with
  // an explanation instead.
  const mergeTargetId = mergeTarget?.id ?? null;
  const takenAppearancesKey = takenAppearances.join(",");
  useEffect(() => {
    if (isEditing || mergeTargetId === null) return;
    const taken = takenAppearancesKey.split(",").filter(Boolean) as ThemeAppearance[];
    if (taken.length !== 1) return;
    setActiveAppearance((current) => {
      if (!taken.includes(current)) return current;
      return taken[0] === "light" ? "dark" : "light";
    });
  }, [isEditing, mergeTargetId, takenAppearancesKey]);

  // The whole app wears the draft while the editor is open, so a role change
  // is judged on the real interface rather than a miniature. The stored theme
  // comes back when the editor closes, including on cancel.
  useEffect(() => {
    if (!open || !isDraftSeeded) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, isDraftSeeded, open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = useCallback(
    (role: ThemeColorRole, value: string) => {
      setColorsByAppearance((current) => {
        const nextColors = { ...current[activeAppearance], [role]: value };
        const shouldManageColors =
          !showAllColors && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

        return {
          ...current,
          [activeAppearance]: shouldManageColors
            ? getManagedEditorColors(activeAppearance, nextColors)
            : nextColors,
        };
      });
      if (!showAllColors && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
        setSimpleColorsDirtyByAppearance((current) => ({
          ...current,
          [activeAppearance]: true,
        }));
      }
    },
    [activeAppearance, showAllColors],
  );

  const selectThemeRole = useCallback((role: ThemeColorRole, reveal = false) => {
    setSelectedRole(role);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(role)) {
      setShowAllColors(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector(`[data-theme-color-role="${role}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const toggleThemeRole = useCallback((role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  }, []);

  const clearInspectorSelection = useCallback(() => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  }, []);

  const selectedHighlightRoles = selectedRole
    ? !showAllColors && THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
      ? THEME_COLOR_ROLES.filter(
          (role) =>
            colorsByAppearance[activeAppearance][role].trim().toLowerCase() ===
            colorsByAppearance[activeAppearance][selectedRole].trim().toLowerCase(),
        )
      : [selectedRole]
    : [];
  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  useEffect(() => {
    clearThemeInspectorHighlights();
    if (!open || selectedRole === null) {
      setUsageCount(null);
      return;
    }
    // Picking a new element needs the unobscured app, so suspend the existing
    // spotlight while the picker is armed.
    if (isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // A refresh snapshots computed styles for the whole tree twice, so it is
    // throttled rather than run per frame: a streaming reply or a virtualized
    // list mutates the DOM continuously and would otherwise stall the main
    // thread for as long as the inspector is open.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();
    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));
      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };
      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }
      scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;
    const scheduleSpotlightRefresh = () => {
      spotlightFrame ??= requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  useEffect(() => {
    if (!open || !isInspecting) {
      clearThemeInspectorHover();
      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(inspection, getThemeRoleLabel(inspection.role));
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }

      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }

      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      selectThemeRole(inspection.role, true);
      shouldDisarmAfterClick = true;
    };
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearHover();
      clearInspectorSelection();
    };
    const refreshHover = () => {
      if (!hoverInspection) return;
      hoverFrame ??= requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection) {
          showThemeInspectorHover(hoverInspection, getThemeRoleLabel(hoverInspection.role));
        }
      });
    };
    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [clearInspectorSelection, isInspecting, open, selectThemeRole]);

  const handleShowAllColorsChange = useCallback(
    (checked: boolean) => {
      setShowAllColors(checked);
      if (checked) return;
      if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
        setSelectedRole(null);
      }

      // Regenerate every appearance the theme will save, not just the visible
      // one, so the palettes shown after toggling match what gets saved.
      const managedAppearances: ReadonlyArray<ThemeAppearance> =
        editingTheme && getThemeModes(editingTheme).length > 1
          ? ["light", "dark"]
          : [activeAppearance];
      setSimpleColorsDirtyByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) next[appearance] = true;
        return next;
      });
      setColorsByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) {
          next[appearance] = getManagedEditorColors(appearance, current[appearance]);
        }
        return next;
      });
    },
    [activeAppearance, editingTheme, selectedRole],
  );

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name fehlt.");
      return;
    }

    try {
      // Only regenerate palettes the user actually touched in guided mode, so
      // untouched appearances save exactly what the editor displayed.
      const colorsForSave = !showAllColors
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;
      if (editingTheme && mergeTarget) {
        // Renamed onto another installed theme: this theme's palettes fold
        // into it and the edited entry retires, so both cards become one.
        // Colliding palettes cannot merge — neither side should be silently
        // overwritten.
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(
            `„${mergeTarget.label}“ hat bereits eine ${paletteAdjective(collision)} Palette. Anderer Name.`,
          );
          return;
        }
        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !showAllColors ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
        retiredTheme = editingTheme;
        try {
          removeCustomTheme(editingTheme.id);
        } catch (cause) {
          // The merge already persisted. Leaving it while the edited theme
          // survives would collide on every retry, so the target goes back to
          // its pre-merge palettes before the failure surfaces.
          try {
            updateCustomTheme(mergeTarget);
          } catch {
            // Storage is failing wholesale; the rethrow below reports it.
          }
          throw cause;
        }
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(showAllColors ? {} : { managed: true }),
          }),
          ...(editingTheme.collection ? { collection: editingTheme.collection } : {}),
        });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(`„${mergeTarget.label}“ hat bereits helle und dunkle Paletten. Anderer Name.`);
          return;
        }
        // The new palette joins the existing theme as its other mode; its
        // stored palettes are untouched. The guided (managed) flag only
        // survives when every palette in the theme came from the guided
        // editor.
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !showAllColors ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(showAllColors ? {} : { managed: true }),
          }),
        );
      }
      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          // Roll the install back so a retry can run it again instead of
          // failing on the already-taken theme id.
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        } else if (mergeTarget && mergedAppearance !== null) {
          // Put the pre-merge definitions back for the same reason.
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        }
        setError("Gespeichert, aber nicht aktiviert. Erneut versuchen.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? "Theme nicht gespeichert."
            : "Theme nicht erstellt.",
      );
    }
  };

  const renderNameField = () => (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-[13.5px] font-medium">Name</span>
      <Input
        autoFocus
        onChange={(event) => {
          setName(event.currentTarget.value);
          // Most save failures are name collisions; retyping is the fix, so
          // the stale message goes with the old name.
          setError(null);
        }}
        placeholder={isEditing ? "Name" : "z. B. Aurora"}
        value={name}
      />
    </label>
  );

  const renderSegmentButton = ({
    isActive,
    label,
    onClick,
    lockReason = null,
  }: {
    isActive: boolean;
    label: string;
    onClick: () => void;
    lockReason?: string | null;
  }) => {
    // A locked mode stays hoverable so the tooltip can say why it is off;
    // a real disabled attribute would swallow the pointer events.
    const button = (
      <Button
        aria-disabled={lockReason !== null}
        aria-pressed={isActive}
        className={cn(isActive && "bg-accent", lockReason !== null && "opacity-50")}
        size="sm"
        style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
        variant="outline"
        onClick={() => {
          if (lockReason === null) onClick();
        }}
      >
        {label}
      </Button>
    );
    if (lockReason === null) return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup>{lockReason}</TooltipPopup>
      </Tooltip>
    );
  };

  const renderAppearanceButtons = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-[13.5px] font-medium">Modus</span>
      <div aria-label="Modus" className="grid grid-cols-2 gap-2" role="group">
        {(["light", "dark"] as const).map((appearance) => (
          <span className="contents" key={appearance}>
            {renderSegmentButton({
              isActive: activeAppearance === appearance,
              label: appearance === "light" ? "Hell" : "Dunkel",
              lockReason: appearanceLockReason(appearance),
              onClick: () => setActiveAppearance(appearance),
            })}
          </span>
        ))}
      </div>
    </div>
  );

  // „Hauptfarben“ zeigt die zwei Leitfarben, der Rest wird abgeleitet und als
  // managed gespeichert; „Alle Farben“ zeigt jede Rolle und speichert sie so.
  const renderColorsHeader = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-[13.5px] font-medium">Farben</span>
      <div aria-label="Farben" className="grid grid-cols-2 gap-2" role="group">
        {renderSegmentButton({
          isActive: !showAllColors,
          label: "Hauptfarben",
          onClick: () => {
            if (showAllColors) handleShowAllColorsChange(false);
          },
        })}
        {renderSegmentButton({
          isActive: showAllColors,
          label: "Alle Farben",
          onClick: () => {
            if (!showAllColors) handleShowAllColorsChange(true);
          },
        })}
      </div>
    </div>
  );

  const renderRoleFields = (
    roles: ReadonlyArray<ThemeColorRole>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {roles.map((role) => (
        <ThemeColorField
          key={role}
          onChange={updateColor}
          onSelect={selectThemeRole}
          onToggleSelected={toggleThemeRole}
          role={role}
          selected={selectedRole === role}
          value={colorsByAppearance[activeAppearance][role]}
        />
      ))}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      roles: group.roles.filter(
        (role) => !query || getThemeRoleLabel(role).toLowerCase().includes(query),
      ),
    })).filter((group) => group.roles.length > 0);
    return showAllColors ? (
      <div className="space-y-4">
        <Input
          aria-label="Farben filtern"
          onChange={(event) => setRoleQuery(event.currentTarget.value)}
          placeholder="Farben filtern"
          size="sm"
          value={roleQuery}
        />
        {groups.map((group) => (
          <section className="space-y-1" key={group.id}>
            <h4 className="text-xs font-medium text-muted-foreground">{group.title}</h4>
            {renderRoleFields(group.roles, "grid gap-1 sm:grid-cols-2")}
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">Keine Treffer</p>
        ) : null}
      </div>
    ) : (
      <div className="grid gap-1 sm:grid-cols-2">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={updateColor}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            label={role === "canvas" ? "Hintergrund" : "Akzent"}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
    );
  };

  const title = isEditing ? "Theme bearbeiten" : "Theme erstellen";
  const inspectorStatus = isInspecting
    ? "Element wählen · Esc beendet"
    : selectedRole
      ? `${getThemeRoleLabel(selectedRole)} · ${usageCount ?? 0} ${usageCount === 1 ? "Verwendung" : "Verwendungen"}`
      : null;

  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-lg border bg-card/40 p-3"
      data-theme-editor-panel
      ref={panelRef}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium text-[13.5px]">{title}</h3>
        {inspectorStatus ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
            {inspectorStatus}
          </span>
        ) : null}
        <Button
          aria-pressed={isInspecting}
          size="sm"
          variant="outline"
          onClick={() => {
            if (isInspecting) {
              clearInspectorSelection();
              return;
            }
            setIsInspecting(true);
          }}
        >
          <MousePointer2Icon />
          {isInspecting ? "Auswahl beenden" : "Aus App wählen"}
        </Button>
      </div>
      {renderNameField()}
      {renderAppearanceButtons()}
      {renderColorsHeader()}
      {renderColorFields()}
      {error ? (
        <div aria-live="polite" className="text-xs text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
          Abbrechen
        </Button>
        <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
          {mergeTarget
            ? isEditing
              ? `In „${mergeTarget.label}“ zusammenführen`
              : "Palette hinzufügen"
            : "Speichern"}
        </Button>
      </div>
    </section>
  );
}
