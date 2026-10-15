import * as Effect from "effect/Effect";

/**
 * Decision logic for the menu-bar (tray) icon and "open at login".
 *
 * Kept free of Electron so the rules are unit-testable with a mocked `app`
 * login-item API. `DesktopTray.ts` wires the real Electron objects.
 */

export const TRAY_PROJECT_LIMIT = 5;
const TRAY_PROJECT_LABEL_MAX = 48;

export interface TrayProject {
  readonly key: string;
  readonly title: string;
}

export interface LoginItemState {
  /** False where Electron has no login-item API (Linux). */
  readonly supported: boolean;
  readonly openAtLogin: boolean;
}

/**
 * Platform gate: Electron implements `app.setLoginItemSettings` only on macOS
 * and Windows. On Linux autostart needs an XDG `.desktop` file in
 * `~/.config/autostart`, which Electron does not manage, so the menu item and
 * the settings row are hidden there and the tray still works.
 */
export function loginItemSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** Exactly what is handed to `app.setLoginItemSettings`. */
export function loginItemSettingsFor(openAtLogin: boolean): {
  readonly openAtLogin: boolean;
  readonly openAsHidden: boolean;
} {
  return { openAtLogin, openAsHidden: true };
}

/** Subset of `Electron.App` the login-item controller needs; mocked in tests. */
export interface LoginItemApi {
  readonly getLoginItemSettings: () => { readonly openAtLogin: boolean };
  readonly setLoginItemSettings: (settings: {
    readonly openAtLogin: boolean;
    readonly openAsHidden: boolean;
  }) => void;
}

/**
 * Durable "the app has already made its one automatic choice" marker. Once it
 * exists, only the user (tray item or settings row) changes the login item.
 */
export interface LoginItemMarker {
  readonly exists: Effect.Effect<boolean>;
  readonly write: Effect.Effect<void>;
}

export interface LoginItemController {
  /** First launch only: enable open-at-login once, then never again on its own. */
  readonly initialize: Effect.Effect<LoginItemState>;
  readonly state: Effect.Effect<LoginItemState>;
  /** User choice; recorded so later launches never override it. */
  readonly setOpenAtLogin: (enabled: boolean) => Effect.Effect<LoginItemState>;
}

export function makeLoginItemController(input: {
  readonly platform: NodeJS.Platform;
  readonly api: LoginItemApi;
  readonly marker: LoginItemMarker;
}): LoginItemController {
  const supported = loginItemSupported(input.platform);
  const state: Effect.Effect<LoginItemState> = Effect.sync(() =>
    supported
      ? { supported: true, openAtLogin: input.api.getLoginItemSettings().openAtLogin === true }
      : { supported: false, openAtLogin: false },
  );
  return {
    initialize: Effect.gen(function* () {
      if (!supported) return yield* state;
      if (!(yield* input.marker.exists)) {
        input.api.setLoginItemSettings(loginItemSettingsFor(true));
        yield* input.marker.write;
      }
      return yield* state;
    }),
    state,
    setOpenAtLogin: (enabled) =>
      Effect.gen(function* () {
        if (!supported) return yield* state;
        input.api.setLoginItemSettings(loginItemSettingsFor(enabled));
        yield* input.marker.write;
        return yield* state;
      }),
  };
}

/** Accepts only well-formed entries, keeps order, drops duplicates, caps at five. */
export function normalizeTrayProjects(value: unknown): readonly TrayProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const projects: TrayProject[] = [];
  for (const entry of value) {
    if (projects.length >= TRAY_PROJECT_LIMIT) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { key, title } = entry as { key?: unknown; title?: unknown };
    if (typeof key !== "string" || typeof title !== "string") continue;
    const trimmedKey = key.trim();
    const trimmedTitle = title.trim();
    if (trimmedKey.length === 0 || trimmedTitle.length === 0 || seen.has(trimmedKey)) continue;
    seen.add(trimmedKey);
    projects.push({
      key: trimmedKey,
      title:
        trimmedTitle.length > TRAY_PROJECT_LABEL_MAX
          ? `${trimmedTitle.slice(0, TRAY_PROJECT_LABEL_MAX - 1)}…`
          : trimmedTitle,
    });
  }
  return projects;
}

export type TrayMenuEntry =
  | { readonly kind: "open"; readonly label: string }
  | { readonly kind: "project"; readonly label: string; readonly key: string }
  | { readonly kind: "separator" }
  | { readonly kind: "open-at-login"; readonly label: string; readonly checked: boolean }
  | { readonly kind: "quit"; readonly label: string };

export const TRAY_OPEN_PROJECT_ACTION_PREFIX = "open-project:";

export function trayOpenProjectAction(key: string): string {
  return `${TRAY_OPEN_PROJECT_ACTION_PREFIX}${key}`;
}

export function buildTrayMenuEntries(input: {
  readonly projects: readonly TrayProject[];
  readonly loginItem: LoginItemState;
}): readonly TrayMenuEntry[] {
  return [
    { kind: "open", label: "Workjet öffnen" },
    ...input.projects
      .slice(0, TRAY_PROJECT_LIMIT)
      .map(
        (project): TrayMenuEntry => ({ kind: "project", label: project.title, key: project.key }),
      ),
    { kind: "separator" },
    ...(input.loginItem.supported
      ? [
          {
            kind: "open-at-login",
            label: "Beim Anmelden starten",
            checked: input.loginItem.openAtLogin,
          } as const,
        ]
      : []),
    { kind: "quit", label: "Beenden" },
  ];
}

/**
 * With a tray icon the app stays reachable after its last window closes, so
 * closing the window no longer quits on Windows/Linux either. Without a tray
 * the previous rule applies: macOS keeps running, other platforms quit.
 */
export function shouldQuitWhenAllWindowsClosed(input: {
  readonly platform: NodeJS.Platform;
  readonly quitting: boolean;
  readonly trayActive: boolean;
}): boolean {
  if (input.quitting || input.trayActive) return false;
  return input.platform !== "darwin";
}
