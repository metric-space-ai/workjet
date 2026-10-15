import { useProjectOverviewLanguage } from "./useProjectOverviewLanguage";

/** Picks the German or English string for the current UI language. */
export type UiText = (de: string, en: string) => string;

export function useUiText(): UiText {
  const language = useProjectOverviewLanguage();
  return (de, en) => (language === "en" ? en : de);
}
