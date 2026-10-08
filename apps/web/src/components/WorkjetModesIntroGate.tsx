import { isElectron } from "../env";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../hooks/useSettings";
import { WorkjetModesIntroDialog } from "./WorkjetModesIntro";
import { resolveWorkjetModesIntroOpen } from "./WorkjetModesIntro.logic";

/**
 * Opens the introduction for an empty, hydrated desktop profile. Existing work
 * stays immediately usable after an upgrade; Settings, General can open the
 * same introduction explicitly.
 */
export function WorkjetModesIntroGate() {
  const settingsHydrated = useClientSettingsHydrated();
  const workspaceHydrated = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const seen = useClientSettings((settings) => settings.workjetModesIntroSeen);
  const updateClientSettings = useUpdateClientSettings();
  return (
    <WorkjetModesIntroDialog
      open={resolveWorkjetModesIntroOpen({
        isElectron,
        settingsHydrated,
        seen,
        workspaceHydrated,
        hasExistingWork: projects.length > 0 || threads.length > 0,
      })}
      onDismiss={() => updateClientSettings({ workjetModesIntroSeen: true })}
    />
  );
}
