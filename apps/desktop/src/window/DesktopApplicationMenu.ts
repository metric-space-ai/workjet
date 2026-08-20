import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSupportBundle from "../support/DesktopSupportBundle.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedErrorClass<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopSupportBundle.DesktopSupportBundle
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog
  | ElectronShell.ElectronShell;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const checkForUpdatesFromMenu = Effect.fn("desktop.menu.checkForUpdates")(function* (
  appName: string,
) {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `${appName} ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
});

const handleCheckForUpdatesMenuClick = Effect.fn("desktop.menu.handleCheckForUpdatesClick")(
  function* (appName: string) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const disabledReason = yield* updates.disabledReason;
    if (Option.isSome(disabledReason)) {
      yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
        disabledReason: disabledReason.value,
      });
      yield* electronDialog.showMessageBox({
        type: "info",
        title: "Updates unavailable",
        message: "Automatic updates are not available right now.",
        detail: disabledReason.value,
        buttons: ["OK"],
      });
      return;
    }

    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.ensureMain;
    yield* checkForUpdatesFromMenu(appName);
  },
);

/**
 * Builds a support bundle from the Help menu and TELLS THE USER THE PATH.
 *
 * The dialog is the delivery mechanism, not a courtesy: a bundle the user
 * cannot find is a bundle they cannot inspect before sharing, and inspecting
 * it is the whole safety story. "Copy Path" is offered because a path inside
 * an application-support directory is not something anyone retypes.
 *
 * Nothing here sends anything. The message says so explicitly, so the user
 * does not have to infer it from the absence of a progress bar.
 */
const createSupportBundleFromMenu = Effect.fn("desktop.menu.createSupportBundle")(function* () {
  const supportBundle = yield* DesktopSupportBundle.DesktopSupportBundle;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronShell = yield* ElectronShell.ElectronShell;

  const result = yield* supportBundle.create.pipe(Effect.option);
  if (Option.isNone(result)) {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Support bundle failed",
      message: "The support bundle could not be written.",
      detail: "Check that the application state directory is writable, then try again.",
      buttons: ["OK"],
    });
    return;
  }

  const { filePath, byteLength, redactedFieldCount, omittedFieldCount } = result.value;
  const choice = yield* electronDialog.showMessageBox({
    type: "info",
    title: "Support bundle created",
    message: "The support bundle was saved on this computer. Nothing was uploaded.",
    detail: [
      filePath,
      "",
      `${Math.max(1, Math.round(byteLength / 1024))} KB - ${redactedFieldCount} field(s) redacted, ${omittedFieldCount} omitted.`,
      "Open the file and read it before sending it to anyone.",
    ].join("\n"),
    buttons: ["Copy Path", "OK"],
    defaultId: 1,
    cancelId: 1,
  });

  if (choice.response === 0) {
    yield* electronShell.copyText(filePath);
  }
});

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    // Read the name here, not at layer construction: DesktopAppIdentity
    // configures the CTOX app name and About panel after this service is
    // acquired, so an early read would label the menu with Electron's default.
    const appName = yield* electronApp.name;
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick(appName));
    };
    // macOS gets the About entry from the { role: "about" } app-menu item.
    // Windows and Linux have no app menu, so the Help menu carries it and
    // opens the same native panel, which DesktopAppIdentity.configure has
    // already filled with this build's name, version, and commit hash.
    const showAboutPanelClick = () => {
      runMenuEffect("show-about-panel", electronApp.showAboutPanel);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const createSupportBundleClick = () => {
      runMenuEffect("create-support-bundle", createSupportBundleFromMenu());
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          { role: environment.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
          { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: "Zoom In",
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Create Support Bundle...",
            click: createSupportBundleClick,
          },
          ...(environment.platform === "darwin"
            ? []
            : [
                { type: "separator" as const },
                {
                  label: `About ${appName}`,
                  click: showAboutPanelClick,
                },
              ]),
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
