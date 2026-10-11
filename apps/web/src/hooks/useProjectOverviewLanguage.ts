import { useClientSettings } from "./useSettings";
import { projectOverviewLanguage } from "../projectOverviewText";
export function useProjectOverviewLanguage() {
  const preference = useClientSettings((settings) => settings.interfaceLanguage);
  return projectOverviewLanguage(
    preference,
    typeof navigator === "undefined" ? "de" : navigator.language,
  );
}
