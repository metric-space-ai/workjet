import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { resolveSettingsInstanceContext } from "./settingsInstanceContext";
import {
  SETTINGS_SECTION_ICONS,
  settingsNavItems,
  type SettingsNavItem,
} from "./settingsNavigation";
export { SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import {
  WorkjetConnectSidebarAvatar,
  WorkjetConnectSidebarSignIn,
} from "../clerk/WorkjetConnectSidebarSignIn";
import { useClientSettings } from "../../hooks/useSettings";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  settingsPageForPath,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { cn } from "~/lib/utils";

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />;
}

/**
 * Navigation and search state shared by the wide sidebar and the narrow head.
 * Search hits never replace the navigation (#603): they list above it, and the
 * page on the right follows the highlighted hit.
 */
function useSettingsNavigation(pathname: string) {
  const { discovery, selectedId } = useCtoxMode();
  const instanceContext = resolveSettingsInstanceContext(
    discovery,
    selectedId,
    typeof window !== "undefined" && window.desktopBridge?.ctox !== undefined,
  );
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const developerMode = useClientSettings((settings) => settings.developerMode);
  const items = settingsNavItems(developerMode);
  const results = useMemo(() => searchSettings(query, { developerMode }), [developerMode, query]);
  const isSearching = query.trim().length > 0;
  const activePage = settingsPageForPath(pathname);
  const isEnabled = useCallback(
    (to: SettingsPath) => to === "/settings/business-os" || instanceContext.canEditInstanceSettings,
    [instanceContext.canEditInstanceSettings],
  );

  const goToResult = useCallback(
    (item: SettingsSearchItem) => {
      if (!isEnabled(item.to)) return;
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({ to: item.to, hash: targetId, replace: true, hashScrollIntoView: false });
    },
    [currentHash, isEnabled, navigate, pathname],
  );

  // The right side follows the highlighted hit.
  const activeResult = isSearching ? results[activeResultIndex] : undefined;
  const lastFollowedRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeResult === undefined) {
      lastFollowedRef.current = null;
      return;
    }
    if (lastFollowedRef.current === activeResult.id) return;
    lastFollowedRef.current = activeResult.id;
    goToResult(activeResult);
    document
      .getElementById(`settings-search-result-${activeResult.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResult, goToResult]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);

  const selectPage = useCallback(
    (to: SettingsPath) => {
      if (!isEnabled(to)) return;
      clearSearch();
      void navigate({ to, hash: "", replace: true, hashScrollIntoView: false });
    },
    [clearSearch, isEnabled, navigate],
  );

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) {
          goToResult(result);
          clearSearch();
        }
      }
    },
    [activeResultIndex, clearSearch, goToResult, isSearching, results],
  );

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside open dialogs and popups instead of escaping
          // their focus trap into the settings search.
          target.closest('[data-slot$="popup"]') !== null)
      ) {
        return;
      }
      const input = searchInputRef.current;
      if (input === null || input.offsetParent === null) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return {
    activePage,
    activeResultIndex,
    clearSearch,
    goToResult,
    handleSearchKeyDown,
    isEnabled,
    isSearching,
    items,
    query,
    results,
    searchInputRef,
    selectPage,
    setActiveResultIndex,
    setQuery,
  };
}

type SettingsNavigationState = ReturnType<typeof useSettingsNavigation>;

function SettingsSearchField({
  nav,
  className,
}: {
  nav: SettingsNavigationState;
  className?: string;
}) {
  const hasResults = nav.results.length > 0;
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-md border border-border/70 px-2 text-sm",
        className,
      )}
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground/80" />
      <Input
        ref={nav.searchInputRef}
        nativeInput
        unstyled
        type="search"
        value={nav.query}
        onChange={(event) => {
          nav.setQuery(event.currentTarget.value);
          nav.setActiveResultIndex(0);
        }}
        onKeyDown={nav.handleSearchKeyDown}
        placeholder="Suchen"
        aria-label="Einstellungen suchen"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={nav.isSearching && hasResults}
        aria-controls={nav.isSearching && hasResults ? "settings-search-results" : undefined}
        aria-activedescendant={
          nav.isSearching && nav.results[nav.activeResultIndex]
            ? `settings-search-result-${nav.results[nav.activeResultIndex]!.id}`
            : undefined
        }
        className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:text-foreground [&_[data-slot=input]]:placeholder:text-muted-foreground"
      />
      {nav.isSearching ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 shrink-0 rounded-sm"
          aria-label="Suche zurücksetzen"
          title="Suche zurücksetzen"
          onClick={() => {
            nav.clearSearch();
            nav.searchInputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : (
        <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[11px]">/</Kbd>
      )}
    </div>
  );
}

function SettingsSearchResults({
  nav,
  className,
}: {
  nav: SettingsNavigationState;
  className?: string;
}) {
  if (!nav.isSearching) return null;
  if (nav.results.length === 0) {
    return (
      <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
        Keine Treffer
      </p>
    );
  }
  return (
    <div
      id="settings-search-results"
      role="listbox"
      aria-label="Suchergebnisse"
      data-settings-search-results=""
      className={cn("flex max-h-72 flex-col gap-px overflow-y-auto", className)}
    >
      {nav.results.map((item, index) => {
        const active = index === nav.activeResultIndex;
        return (
          <button
            key={item.id}
            type="button"
            id={`settings-search-result-${item.id}`}
            role="option"
            aria-selected={active}
            tabIndex={-1}
            disabled={!nav.isEnabled(item.to)}
            onMouseMove={() => nav.setActiveResultIndex(index)}
            onClick={() => {
              nav.goToResult(item);
              nav.clearSearch();
            }}
            className={cn(
              "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none disabled:opacity-50",
              active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
            )}
          >
            <SettingsSectionIcon to={item.to} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{item.title}</span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {SETTINGS_SECTION_LABELS[item.to]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Wide layout: search on top, hits above the always visible page list. */
export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const nav = useSettingsNavigation(pathname);
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <SettingsSearchField nav={nav} />
          <SettingsSearchResults nav={nav} className="border-b border-sidebar-border pb-2" />
          <SidebarMenu className="ps-px" aria-label="Einstellungsseiten">
            {nav.items.map((item: SettingsNavItem) => {
              const Icon = item.icon;
              const isActive = nav.activePage === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isActive}
                    aria-current={isActive ? "page" : undefined}
                    data-settings-nav-item={item.to}
                    onClick={() => nav.selectPage(item.to)}
                    disabled={!nav.isEnabled(item.to)}
                  >
                    <Icon />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <WorkjetConnectSidebarSignIn />
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1" />
          <WorkjetConnectSidebarAvatar />
        </div>
      </SidebarFooter>
    </>
  );
}

/** Narrow layout (420 px): one head row with the page list as a select. */
export function SettingsCompactNav({ pathname }: { pathname: string }) {
  const nav = useSettingsNavigation(pathname);
  const current = nav.items.find((item) => item.to === nav.activePage) ?? null;
  return (
    <div
      className="flex flex-col gap-2 border-b border-border px-3 py-2"
      data-settings-compact-nav=""
    >
      <div className="flex min-w-0 items-center gap-2 pe-11">
        <Select
          value={current?.to ?? ""}
          onValueChange={(value) => {
            const target = nav.items.find((item) => item.to === value);
            if (target) nav.selectPage(target.to);
          }}
        >
          <SelectTrigger aria-label="Einstellungsseite" className="w-36 shrink-0">
            <SelectValue>{current?.label ?? "Einstellungen"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {nav.items.map((item) => (
              <SelectItem
                key={item.to}
                value={item.to}
                disabled={!nav.isEnabled(item.to)}
                hideIndicator
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <SettingsSearchField nav={nav} className="flex-1" />
      </div>
      <SettingsSearchResults nav={nav} />
    </div>
  );
}
