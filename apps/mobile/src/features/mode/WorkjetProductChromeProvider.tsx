import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useWorkjetMode } from "./WorkjetModeProvider";
import type { WorkjetMode } from "./workjet-mode";

export interface WorkjetProductSidebarController {
  readonly available: boolean;
  readonly visible: boolean;
  readonly toggle: () => void;
}

interface WorkjetProductChromeContextValue {
  readonly sidebar: WorkjetProductSidebarController | null;
  readonly registerSidebar: (
    mode: WorkjetMode,
    controller: WorkjetProductSidebarController,
  ) => () => void;
}

const WorkjetProductChromeContext = createContext<WorkjetProductChromeContextValue | null>(null);

export function WorkjetProductChromeProvider(props: { readonly children: ReactNode }) {
  const { mode } = useWorkjetMode();
  const ownerRef = useRef<Partial<Record<WorkjetMode, symbol>>>({});
  const [sidebars, setSidebars] = useState<
    Partial<Record<WorkjetMode, WorkjetProductSidebarController>>
  >({});

  const registerSidebar = useCallback(
    (targetMode: WorkjetMode, controller: WorkjetProductSidebarController) => {
      const owner = Symbol("workjet-product-sidebar");
      ownerRef.current[targetMode] = owner;
      setSidebars((current) => ({ ...current, [targetMode]: controller }));
      return () => {
        if (ownerRef.current[targetMode] !== owner) return;
        delete ownerRef.current[targetMode];
        setSidebars((current) => {
          const next = { ...current };
          delete next[targetMode];
          return next;
        });
      };
    },
    [],
  );

  const sidebar = sidebars[mode] ?? null;
  const value = useMemo(() => ({ registerSidebar, sidebar }), [registerSidebar, sidebar]);
  return (
    <WorkjetProductChromeContext.Provider value={value}>
      {props.children}
    </WorkjetProductChromeContext.Provider>
  );
}

export function useWorkjetProductChrome(): WorkjetProductChromeContextValue {
  const context = use(WorkjetProductChromeContext);
  if (!context) {
    throw new Error("useWorkjetProductChrome must be used within WorkjetProductChromeProvider");
  }
  return context;
}

export function useRegisterWorkjetProductSidebar(
  mode: WorkjetMode,
  controller: WorkjetProductSidebarController,
): void {
  const { registerSidebar } = useWorkjetProductChrome();
  useEffect(
    () => registerSidebar(mode, controller),
    [controller.available, controller.toggle, controller.visible, mode, registerSidebar],
  );
}
