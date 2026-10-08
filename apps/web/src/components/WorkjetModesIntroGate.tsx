import { isElectron } from "../env";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../hooks/useSettings";
import { WorkjetModesIntroDialog } from "./WorkjetModesIntro";
import { resolveWorkjetModesIntroOpen } from "./WorkjetModesIntro.logic";

/**
 * Opens the Dev / Ops introduction once per desktop install. Dismissing it
 * stores the choice in client settings; Settings, General can reset that flag
 * to show it again.
 */
export function WorkjetModesIntroGate() {
  const settingsHydrated = useClientSettingsHydrated();
  const seen = useClientSettings((settings) => settings.workjetModesIntroSeen);
  const updateClientSettings = useUpdateClientSettings();
  return (
    <WorkjetModesIntroDialog
      open={resolveWorkjetModesIntroOpen({ isElectron, settingsHydrated, seen })}
      onDismiss={() => updateClientSettings({ workjetModesIntroSeen: true })}
    />
  );
}
