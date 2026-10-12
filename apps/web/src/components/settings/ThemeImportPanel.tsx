import { FileUpIcon } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  getCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import {
  humanizeThemeName,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "../../vscodeThemeImport";
import { Button } from "../ui/button";
import { InlinePanel } from "../ui/inline-panel";
import { ThemeSearchSection } from "./ThemeSearchSection";

/**
 * A full theme export is a few KB, so anything past this is not a theme file.
 * The guard runs on the size before the bytes are ever read: a large file
 * would otherwise be pulled into memory, highlighted, and rendered, which
 * locks the UI for as long as that takes.
 */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} Byte`;
}

/** Fehlerzeile für eine Datei, die zu groß für ein Theme ist, sonst null. */
export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `Datei zu groß: ${formatByteSize(bytes)} (Grenze ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
}

/** What the import pipeline needs from a file; DOM File satisfies it. */
type ImportableThemeFile = { name: string; size: number; text: () => Promise<string> };

export function ThemeImportPanel({
  open,
  onOpenChange,
  onImported,
  onImportedMany,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => boolean;
  /** Batch imports install without activating; the caller reports them. */
  onImportedMany: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [isPasted, setIsPasted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Imports whose id is already installed wait here for an update-or-copy
  // decision instead of failing.
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    // Reset on close too: a dialog dismissed mid-drag would otherwise reopen
    // still wearing the drop highlight.
    setIsDropTarget(false);
    if (!open) return;
    setJson("");
    setFileName(null);
    setIsPasted(false);
    setError(null);
    setIsReading(false);
    setConflicts(null);
  }, [open]);

  const readThemeFile = useCallback(async (file: ImportableThemeFile) => {
    // Check the size first: reading a large file is what locks the UI, so it
    // never gets read at all.
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setError(oversized);
      return;
    }

    const requestId = ++importRequestRef.current;
    setIsReading(true);
    try {
      const fileText = await file.text();
      if (requestId !== importRequestRef.current) return;
      setJson(fileText);
      setFileName(file.name);
      setIsPasted(false);
      setError(null);
      setConflicts(null);
    } catch {
      if (requestId !== importRequestRef.current) return;
      setError("Datei nicht lesbar.");
    } finally {
      if (requestId === importRequestRef.current) setIsReading(false);
    }
  }, []);

  // Several files at once import as a batch: VS Code families pair their
  // light and dark variants, everything installs without activating, and the
  // single-file flow keeps filling the editor for review.
  const readThemeBatch = useCallback(
    async (files: ReadonlyArray<ImportableThemeFile>) => {
      const requestId = ++importRequestRef.current;
      setIsReading(true);
      const failures: string[] = [];
      const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
      try {
        for (const file of files) {
          const oversized = describeOversizedThemeFile(file.size);
          if (oversized) {
            failures.push(`${file.name}: zu groß`);
            continue;
          }
          try {
            const value: unknown = JSON.parse(await file.text());
            parsed.push({
              sourceName: file.name,
              theme: isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value),
            });
          } catch (cause) {
            failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "kein Theme"}`);
          }
        }
        if (requestId !== importRequestRef.current) return;
        const installed: ThemeDefinition[] = [];
        const conflicting: ThemeDefinition[] = [];
        for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
          if (getCustomThemes().some((existing) => existing.id === theme.id)) {
            conflicting.push(theme);
            continue;
          }
          try {
            installed.push(installCustomTheme(theme));
          } catch (cause) {
            failures.push(
              `${theme.label}: ${cause instanceof Error ? cause.message : "nicht installiert"}`,
            );
          }
        }
        if (installed.length > 0) onImportedMany(installed, { updated: false });
        if (failures.length > 0) {
          setError(failures.join(" — "));
        } else if (conflicting.length > 0) {
          setConflicts(conflicting);
        } else if (installed.length > 0) {
          onOpenChange(false);
        }
      } finally {
        if (requestId === importRequestRef.current) setIsReading(false);
      }
    },
    [onImportedMany, onOpenChange],
  );

  const readThemeFiles = useCallback(
    (files: ReadonlyArray<ImportableThemeFile>) => {
      if (files.length === 0) return;
      if (files.length === 1) void readThemeFile(files[0]!);
      else void readThemeBatch(files);
    },
    [readThemeBatch, readThemeFile],
  );

  // On desktop the native picker opens in ~/.vscode/extensions (when it
  // exists) and reads the files in the main process; the browser input is
  // the fallback everywhere else.
  const openFilePicker = useCallback(() => {
    const bridge = window.desktopBridge;
    if (bridge?.pickThemeFiles) {
      void bridge.pickThemeFiles().then((picked) => {
        if (!picked || picked.length === 0) return;
        readThemeFiles(
          picked.map((file) => ({
            name: file.name,
            size: file.size,
            text: () => Promise.resolve(file.text),
          })),
        );
      });
      return;
    }
    fileInputRef.current?.click();
  }, [readThemeFiles]);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = "";
      readThemeFiles(files);
    },
    [readThemeFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      readThemeFiles([...event.dataTransfer.files]);
    },
    [readThemeFiles],
  );

  /** Copy of an already-installed theme under the source file's name when
   *  that differs (Dracula Soft), else the next free "Name (1)". */
  const versionedCopy = (
    theme: ThemeDefinition,
    preferredName?: string | null,
  ): ThemeDefinition => {
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: preferredName.slice(0, 48),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (!getCustomThemes().some((existing) => existing.id === candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: `${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`,
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (getCustomThemes().some((existing) => existing.id === candidate.id)) continue;
      return candidate;
    }
    throw new Error(`Zu viele Kopien von „${theme.label}“.`);
  };

  const resolveConflicts = useCallback(
    (mode: "update" | "copy") => {
      if (!conflicts) return;
      const resolved: ThemeDefinition[] = [];
      const failures: string[] = [];
      const preferredName =
        conflicts.length === 1 && fileName
          ? humanizeThemeName(fileName.replace(/\.[^.]+$/, ""))
          : null;
      for (const theme of conflicts) {
        try {
          const existingTheme =
            mode === "update"
              ? getCustomThemes().find((candidate) => candidate.id === theme.id)
              : undefined;
          const themeToUpdate = existingTheme?.collection
            ? { ...theme, collection: existingTheme.collection }
            : theme;
          resolved.push(
            mode === "update"
              ? updateCustomTheme(themeToUpdate)
              : installCustomTheme(versionedCopy(theme, preferredName)),
          );
        } catch (cause) {
          failures.push(
            `${theme.label}: ${cause instanceof Error ? cause.message : "fehlgeschlagen"}`,
          );
        }
      }
      if (resolved.length > 0) onImportedMany(resolved, { updated: mode === "update" });
      setConflicts(null);
      if (failures.length > 0) setError(failures.join(" — "));
      else onOpenChange(false);
    },
    [conflicts, fileName, onImportedMany, onOpenChange],
  );

  const handleSubmit = useCallback(() => {
    // Pasted text bypasses the file guard, so the same limit applies here.
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      // VS Code themes are converted on the way in; anything else has to be
      // one of our own files.
      const theme = isVsCodeThemeFile(parsed)
        ? parseVsCodeThemeFile(parsed)
        : parseThemeFile(parsed);
      if (getCustomThemes().some((existing) => existing.id === theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      const installedTheme = installCustomTheme(theme);
      if (!onImported(installedTheme)) {
        // Roll the install back so a retry can run it again instead of
        // failing on the already-taken theme id.
        try {
          removeCustomTheme(installedTheme.id);
        } catch {
          // Storage is failing wholesale; the error below covers it.
        }
        setError("Hinzugefügt, aber nicht aktiviert. Erneut versuchen.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ungültige Theme-Datei.");
    }
  }, [json, onImported, onOpenChange]);

  // Eingefügter Text läuft durch dieselbe Prüfung wie eine Datei, ohne den
  // Quelltext anzuzeigen.
  const handlePaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text");
    if (!text.trim()) return;
    event.preventDefault();
    importRequestRef.current += 1;
    setIsReading(false);
    setJson(text);
    setFileName(null);
    setIsPasted(true);
    setError(null);
    setConflicts(null);
  }, []);

  if (!open) return null;

  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      // Wechsel zwischen Kindelementen der Ablagefläche ignorieren.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsDropTarget(false);
    },
    onDrop: handleDrop,
  };

  return (
    <InlinePanel
      busy={isReading}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
      onSubmit={handleSubmit}
      open
      status={error}
      statusTone="error"
      submitDisabled={!json.trim() || conflicts !== null}
      submitLabel="Importieren"
      triggerLabel="Theme importieren"
    >
      <ThemeSearchSection
        onInstalled={(themes, context) => {
          onImportedMany(themes, context);
          onOpenChange(false);
        }}
        open={open}
      />
      <div
        aria-label="Theme-Datei"
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
        )}
        onPaste={handlePaste}
        role="group"
        tabIndex={0}
        {...dropHandlers}
      >
        <div className="flex min-w-0 items-center gap-2 text-[13.5px]">
          <span className="font-medium">Datei</span>
          <span className="truncate text-muted-foreground">
            {fileName ?? (isPasted ? "Eingefügt" : "—")}
          </span>
        </div>
        <Button
          disabled={isReading}
          size="sm"
          type="button"
          variant="outline"
          onClick={openFilePicker}
        >
          <FileUpIcon />
          {isReading ? "Liest…" : "Datei wählen"}
        </Button>
        <input
          ref={fileInputRef}
          accept=".json,application/json"
          className="sr-only"
          onChange={handleFileChange}
          multiple
          tabIndex={-1}
          type="file"
        />
      </div>
      {conflicts ? (
        <div className="flex flex-wrap items-center gap-2" role="group">
          <span className="min-w-0 flex-1 truncate text-[13.5px]">
            Bereits installiert: {conflicts.map((theme) => theme.label).join(", ")}
          </span>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => resolveConflicts("copy")}
          >
            Beide behalten
          </Button>
          <Button size="sm" type="button" onClick={() => resolveConflicts("update")}>
            Aktualisieren
          </Button>
        </div>
      ) : null}
    </InlinePanel>
  );
}
