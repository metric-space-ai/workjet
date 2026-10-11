import { ExternalLinkIcon, PaletteIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
} from "../../openVsxThemes";
import {
  getCustomThemes,
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../../themePalette";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOWNLOAD_FORMAT = new Intl.NumberFormat("de-DE", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: string }> = [
  { value: "downloadCount", label: "Meiste Downloads" },
  { value: "rating", label: "Beste Bewertung" },
  { value: "timestamp", label: "Neueste" },
  { value: "relevance", label: "Relevanz" },
];

function ThemeExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon className="size-4" />
      )}
    </div>
  );
}

export function ThemeSearchSection({
  open,
  onInstalled,
}: {
  open: boolean;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // Eine Suche endet sichtbar: nach 10 s Statuszeile mit „Erneut versuchen“.
  const [isSearchSlow, setIsSearchSlow] = useState(false);

  useEffect(() => {
    setIsSearchSlow(false);
    if (!isSearching) return;
    const timer = setTimeout(() => setIsSearchSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [isSearching]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (open) {
      setQuery("");
      setSortBy("downloadCount");
      setResults(null);
      setError(null);
      setIsSearching(false);
      setInstallingId(null);
      setPendingUpdate(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open]);

  const runSearch = useCallback(
    async (searchText: string, nextSort = sortBy) => {
      const trimmed = searchText.trim();
      if (!trimmed) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setQuery(trimmed);
      setIsSearching(true);
      setError(null);
      setResults(null);
      try {
        const nextResults = await searchOpenVsxThemes(trimmed, {
          signal: controller.signal,
          sortBy: nextSort,
        });
        if (!controller.signal.aborted) setResults(nextResults);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Suche fehlgeschlagen.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    },
    [sortBy],
  );

  // Enter sucht, statt das umgebende Import-Formular abzusenden.
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void runSearch(query);
    },
    [query, runSearch],
  );

  const handleSortChange = useCallback(
    (value: OpenVsxThemeSort | null) => {
      const nextSort = SORT_OPTIONS.find((option) => option.value === value)?.value;
      if (!nextSort) return;
      setSortBy(nextSort);
      if ((results !== null || isSearching) && query.trim()) {
        void runSearch(query, nextSort);
      }
    },
    [isSearching, query, results, runSearch],
  );

  const handleInstall = useCallback(
    async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
      setError(null);
      let installedCollection: ReadonlyArray<ThemeDefinition>;
      try {
        installedCollection = getStoredCustomThemeCollection(extension.collectionId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Installierte Themes nicht lesbar.");
        return;
      }
      const updated = installedCollection.length > 0;
      if (updated && !allowUpdate) {
        setPendingUpdate(extension);
        return;
      }

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setInstallingId(extension.id);
      try {
        const themes = await importOpenVsxThemeExtension(extension, controller.signal);
        if (!controller.signal.aborted) {
          const imported = replaceCustomThemeCollection(extension.collectionId, themes, {
            expectedCollection: installedCollection,
          });
          onInstalled(imported, { updated });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Theme nicht hinzugefügt.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setInstallingId(null);
      }
    },
    [onInstalled],
  );

  return (
    <section aria-label="Theme-Suche" className="space-y-3">
      <div className="relative flex gap-2" role="search">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Themes durchsuchen"
          className="[&_input]:pl-9"
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Theme suchen"
          type="search"
          value={query}
        />
        <Button
          disabled={!query.trim() || isSearching || installingId !== null}
          type="button"
          variant="outline"
          onClick={() => void runSearch(query)}
        >
          {isSearching ? <Spinner /> : <SearchIcon />}
          Suchen
        </Button>
      </div>

      {!isSearching ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {SUGGESTED_SEARCHES.map((suggestion) => (
              <Button
                key={suggestion}
                size="xs"
                variant="outline"
                onClick={() => void runSearch(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          {results && results.length > 0 ? (
            <Select
              disabled={installingId !== null}
              value={sortBy}
              onValueChange={handleSortChange}
            >
              <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Sortierung">
                <SelectValue>
                  {SORT_OPTIONS.find((option) => option.value === sortBy)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} hideIndicator value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" role="status">
        {isSearching ? "Sucht…" : results ? `${results.length} Treffer` : ""}
      </div>

      {error ? (
        <div aria-live="polite" className="text-destructive text-xs" role="alert">
          {error}
        </div>
      ) : null}

      {isSearching ? (
        <div className="flex min-h-12 items-center gap-2 text-muted-foreground text-xs">
          {isSearchSlow ? (
            <>
              <span>Keine Antwort erhalten</span>
              <Button size="xs" variant="outline" onClick={() => void runSearch(query)}>
                Erneut versuchen
              </Button>
            </>
          ) : (
            <>
              <Spinner /> Sucht…
            </>
          )}
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <p className="text-muted-foreground text-xs">Keine Treffer</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((extension) => {
              const isInstalling = installingId === extension.id;
              const isInstalled = getCustomThemes().some(
                (theme) => theme.collection?.id === extension.collectionId,
              );
              const isConfirmingUpdate = pendingUpdate?.id === extension.id;
              const action = isInstalled ? "Aktualisieren" : "Hinzufügen";
              const progressAction = isInstalled ? "Aktualisiert…" : "Fügt hinzu…";
              return (
                <article
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-card/60 p-2.5"
                  key={extension.id}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <ThemeExtensionIcon key={extension.iconUrl} extension={extension} />
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-[13.5px] font-medium">{extension.name}</h4>
                      <p className="truncate text-muted-foreground text-xs">
                        {extension.publisher} · {DOWNLOAD_FORMAT.format(extension.downloadCount)}{" "}
                        Downloads · {extension.license}
                      </p>
                    </div>
                    {extension.sourceUrl ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              aria-label={`Quelle von ${extension.name}`}
                              render={
                                <a href={extension.sourceUrl} rel="noreferrer" target="_blank" />
                              }
                              size="icon-xs"
                              variant="ghost"
                            >
                              <ExternalLinkIcon />
                            </Button>
                          }
                        />
                        <TooltipPopup>Quelle</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                  {isConfirmingUpdate ? (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className="min-w-0 flex-1 text-muted-foreground text-xs">
                        Ersetzt installierte Varianten.
                      </span>
                      <Button size="xs" variant="outline" onClick={() => setPendingUpdate(null)}>
                        Abbrechen
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => {
                          setPendingUpdate(null);
                          void handleInstall(extension, true);
                        }}
                      >
                        Wirklich aktualisieren?
                      </Button>
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <Button
                        aria-label={`${extension.name}: ${isInstalling ? progressAction : action}`}
                        disabled={installingId !== null}
                        size="xs"
                        variant="outline"
                        onClick={() => void handleInstall(extension, false)}
                      >
                        {isInstalling ? (
                          <Spinner />
                        ) : isInstalled ? (
                          <RefreshCwIcon />
                        ) : (
                          <PlusIcon />
                        )}
                        {isInstalling ? progressAction : action}
                      </Button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )
      ) : null}
    </section>
  );
}
