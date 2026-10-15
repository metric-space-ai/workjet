import { useClientSettings } from "./useSettings";
import { projectOverviewLanguage, readSystemLanguages } from "../projectOverviewText";
export function useProjectOverviewLanguage() {
  const preference = useClientSettings((settings) => settings.interfaceLanguage);
  return projectOverviewLanguage(preference, readSystemLanguages());
}
