import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  buildTrayMenuEntries,
  makeLoginItemController,
  normalizeTrayProjects,
  trayOpenProjectAction,
  type LoginItemController,
  type LoginItemState,
  type TrayMenuEntry,
  type TrayProject,
} from "./DesktopTrayPolicy.ts";

/** Marker next to desktop-settings.json: the one automatic login-item choice is done. */
const LOGIN_ITEM_MARKER_FILE = "login-item-initialized";
/** macOS template image; Electron picks `@2x` automatically and tints it for light/dark. */
const MAC_TRAY_TEMPLATE_FILE = "trayTemplate.png";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    /** After `whenReady`: applies the first-launch login item and shows the tray icon. */
    readonly configure: Effect.Effect<void>;
    readonly setProjects: (projects: unknown) => Effect.Effect<void>;
    readonly loginItemState: Effect.Effect<LoginItemState>;
    readonly setOpenAtLogin: (enabled: boolean) => Effect.Effect<LoginItemState>;
  }
>()("@workjet/desktop/tray/DesktopTray") {}

const { logInfo: logTrayInfo, logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

type DesktopTrayRuntimeServices = DesktopWindow.DesktopWindow | ElectronApp.ElectronApp;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const state = yield* DesktopState.DesktopState;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<DesktopTrayRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const markerPath = path.join(
    path.dirname(environment.desktopSettingsPath),
    LOGIN_ITEM_MARKER_FILE,
  );
  const loginItems: LoginItemController = makeLoginItemController({
    platform: environment.platform,
    api: {
      getLoginItemSettings: () => Electron.app.getLoginItemSettings(),
      setLoginItemSettings: (settings) => Electron.app.setLoginItemSettings(settings),
    },
    marker: {
      exists: fileSystem.exists(markerPath).pipe(Effect.orElseSucceed(() => false)),
      write: fileSystem.makeDirectory(path.dirname(markerPath), { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFileString(markerPath, "1\n")),
        Effect.catchCause((cause) =>
          logTrayWarning("login item marker could not be written", { cause }),
        ),
      ),
    },
  });

  const trayRef = yield* Ref.make<Option.Option<Electron.Tray>>(Option.none());
  const projectsRef = yield* Ref.make<readonly TrayProject[]>([]);

  const runAction = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopTrayRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.withSpan("desktop.tray.action", { attributes: { action } }),
        Effect.catchCause((cause) => logTrayWarning("tray action failed", { action, cause })),
      ),
    );
  };

  const toMenuItem = (entry: TrayMenuEntry): Electron.MenuItemConstructorOptions => {
    switch (entry.kind) {
      case "open":
        return {
          label: entry.label,
          click: () => {
            runAction(
              "open",
              Effect.flatMap(DesktopWindow.DesktopWindow, (window) => window.activate),
            );
          },
        };
      case "project":
        return {
          label: entry.label,
          click: () => {
            runAction(
              "open-project",
              Effect.flatMap(DesktopWindow.DesktopWindow, (window) =>
                window.dispatchMenuAction(trayOpenProjectAction(entry.key)),
              ),
            );
          },
        };
      case "separator":
        return { type: "separator" };
      case "open-at-login":
        return {
          label: entry.label,
          type: "checkbox",
          checked: entry.checked,
          click: (item) => {
            runAction("open-at-login", setOpenAtLogin(item.checked).pipe(Effect.asVoid));
          },
        };
      case "quit":
        return {
          label: entry.label,
          click: () => {
            runAction(
              "quit",
              Effect.flatMap(ElectronApp.ElectronApp, (app) => app.quit),
            );
          },
        };
    }
  };

  const rebuildMenu: Effect.Effect<void> = Effect.gen(function* () {
    const tray = yield* Ref.get(trayRef);
    if (Option.isNone(tray) || tray.value.isDestroyed()) return;
    const entries = buildTrayMenuEntries({
      projects: yield* Ref.get(projectsRef),
      loginItem: yield* loginItems.state,
    });
    tray.value.setContextMenu(Electron.Menu.buildFromTemplate(entries.map(toMenuItem)));
  });

  const setOpenAtLogin = (enabled: boolean) =>
    loginItems.setOpenAtLogin(enabled).pipe(Effect.tap(() => rebuildMenu));

  const resolveTrayImage = Effect.gen(function* () {
    if (environment.platform === "darwin") {
      const template = yield* assets
        .resolveResourcePath(MAC_TRAY_TEMPLATE_FILE)
        .pipe(Effect.orElseSucceed(() => Option.none<string>()));
      if (Option.isSome(template)) {
        const image = Electron.nativeImage.createFromPath(template.value);
        image.setTemplateImage(true);
        return image;
      }
    }
    const icons = yield* assets.iconPaths;
    const iconPath =
      environment.platform === "win32" ? Option.orElse(icons.ico, () => icons.png) : icons.png;
    if (Option.isNone(iconPath)) return Electron.nativeImage.createEmpty();
    const image = Electron.nativeImage.createFromPath(iconPath.value);
    return environment.platform === "win32" ? image : image.resize({ width: 22, height: 22 });
  });

  const configure = Effect.gen(function* () {
    const loginItem = yield* loginItems.initialize;
    yield* logTrayInfo("login item resolved", { ...loginItem });
    if (Option.isSome(yield* Ref.get(trayRef))) return;
    const image = yield* resolveTrayImage;
    const tray = new Electron.Tray(image);
    tray.setToolTip("Workjet");
    // macOS opens the context menu on click; Windows/Linux users expect a
    // left click on the tray icon to bring the window back.
    if (environment.platform !== "darwin") {
      tray.on("click", () => {
        runAction(
          "open",
          Effect.flatMap(DesktopWindow.DesktopWindow, (window) => window.activate),
        );
      });
    }
    yield* Ref.set(trayRef, Option.some(tray));
    yield* Ref.set(state.trayActive, true);
    yield* rebuildMenu;
  }).pipe(
    Effect.withSpan("desktop.tray.configure"),
    Effect.catchCause((cause) => logTrayWarning("tray could not be created", { cause })),
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const tray = yield* Ref.getAndSet(trayRef, Option.none());
      yield* Ref.set(state.trayActive, false);
      if (Option.isSome(tray) && !tray.value.isDestroyed()) tray.value.destroy();
    }),
  );

  return DesktopTray.of({
    configure,
    setProjects: (projects) =>
      Ref.set(projectsRef, normalizeTrayProjects(projects)).pipe(Effect.andThen(rebuildMenu)),
    loginItemState: loginItems.state,
    setOpenAtLogin,
  });
});

export const layer = Layer.effect(DesktopTray, make);
