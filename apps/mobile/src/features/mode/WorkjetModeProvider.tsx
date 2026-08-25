import * as Linking from "expo-linking";
import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { isBusinessOsPairLink } from "../../lib/workjetLinks";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { resolveWorkjetMode, type WorkjetMode } from "./workjet-mode";

interface WorkjetModeContextValue {
  readonly mode: WorkjetMode;
  readonly isReady: boolean;
  readonly setMode: (mode: WorkjetMode) => void;
}

const WorkjetModeContext = createContext<WorkjetModeContextValue | null>(null);

export function WorkjetModeProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const mode = resolveWorkjetMode(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.workjetMode : undefined,
  );
  const isReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const setMode = useCallback(
    (nextMode: WorkjetMode) => savePreferences({ workjetMode: nextMode }),
    [savePreferences],
  );

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (url && isBusinessOsPairLink(url)) setMode("business_os");
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, [setMode]);

  const value = useMemo(() => ({ mode, isReady, setMode }), [isReady, mode, setMode]);
  return <WorkjetModeContext.Provider value={value}>{props.children}</WorkjetModeContext.Provider>;
}

export function useWorkjetMode(): WorkjetModeContextValue {
  const context = use(WorkjetModeContext);
  if (!context) throw new Error("useWorkjetMode must be used within WorkjetModeProvider");
  return context;
}
