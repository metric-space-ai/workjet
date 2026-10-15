import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    /** True while the menu-bar/tray icon exists; closing the last window then keeps the app running. */
    readonly trayActive: Ref.Ref<boolean>;
  }
>()("@workjet/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  trayActive: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
