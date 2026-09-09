import { createContext, useContext, type ComponentProps } from "react";
import { createPortal } from "react-dom";

// undefined means a standalone surface; null means the shared header is mounting.
export const WorkjetHeaderSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export function useSharedWorkjetHeader(): boolean {
  return useContext(WorkjetHeaderSlotContext) !== undefined;
}

/** Keep surface-owned actions and state in their original React tree. */
export function WorkjetHeaderContent({ children, ...props }: ComponentProps<"header">) {
  const slot = useContext(WorkjetHeaderSlotContext);
  if (slot === undefined) return <header {...props}>{children}</header>;
  if (slot === null) return null;
  return createPortal(
    <div {...props} data-workjet-header-content="">
      {children}
    </div>,
    slot,
  );
}
