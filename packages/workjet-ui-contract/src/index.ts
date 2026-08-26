import contract from "./contract.json" with { type: "json" };

export type UiTheme = "light" | "dark";

export type UiCategory =
  | "System"
  | "Workspace"
  | "Operations"
  | "Knowledge"
  | "Security"
  | "Collaboration"
  | "Development"
  | "Engineering"
  | "Governance"
  | "Finance"
  | "Productivity"
  | "Sales"
  | "Recruiting"
  | "Research"
  | "Analytics"
  | "Imported";

export interface SurfaceTokens {
  readonly canvas: string;
  readonly chrome: string;
  readonly surface: string;
  readonly raised: string;
  readonly overlay: string;
  readonly sunken: string;
}

export interface TextTokens {
  readonly primary: string;
  readonly secondary: string;
  readonly muted: string;
  readonly onAccent: string;
}

export interface BorderTokens {
  readonly subtle: string;
  readonly default: string;
  readonly strong: string;
}

export interface AccentTokens {
  readonly value: string;
  readonly foreground: string;
  readonly soft: string;
  readonly focus: string;
}

export interface ThemeTokens {
  readonly surfaces: SurfaceTokens;
  readonly text: TextTokens;
  readonly borders: BorderTokens;
  readonly accent: AccentTokens;
}

export interface TypeScaleStep {
  readonly fontSize: number;
  readonly lineHeight: number;
}

export interface TypographyTokens {
  readonly fontFamily: {
    readonly sans: string;
    readonly mono: string;
  };
  readonly scale: Record<
    "micro" | "caption" | "label" | "body" | "headline" | "title" | "display",
    TypeScaleStep
  >;
  readonly weights: Record<"regular" | "medium" | "semibold" | "bold", number>;
  readonly tracking: Record<"tight" | "normal" | "wide", string>;
}

export interface CategoryAccent {
  readonly accent: string;
  readonly foreground: string;
  readonly softLight: string;
  readonly softDark: string;
  readonly borderLight: string;
  readonly borderDark: string;
}

export interface UiContract {
  readonly schema: "workjet.ui.contract.v1";
  readonly version: 1;
  readonly product: "Workjet";
  readonly themes: Record<UiTheme, ThemeTokens>;
  readonly typography: TypographyTokens;
  readonly spacing: Record<string, number>;
  readonly radii: Record<"none" | "control" | "panel" | "card" | "pill", number>;
  readonly focus: {
    readonly outlineWidth: number;
    readonly outlineOffset: number;
    readonly ringAlpha: number;
    readonly minContrastRatio: number;
  };
  readonly elevation: Record<"none" | "low" | "panel" | "overlay", string>;
  readonly categories: Record<UiCategory, CategoryAccent>;
  readonly vocabulary: {
    readonly userTerms: readonly string[];
    readonly forbiddenTerms: readonly string[];
    readonly forbiddenPatterns: readonly string[];
  };
}

export const WORKJET_UI_CONTRACT = contract as unknown as UiContract;
export const UI_CONTRACT_VERSION = WORKJET_UI_CONTRACT.version;
export const UI_THEMES = Object.freeze(["light", "dark"] as const);
export const UI_CATEGORIES = Object.freeze(
  Object.keys(WORKJET_UI_CONTRACT.categories) as readonly UiCategory[],
);

const WHITE = "#ffffff";
const DARK_FOREGROUND = "#111827";

const parseHex = (hex: string): readonly [number, number, number] => {
  const normalized = hex.trim().toLowerCase();
  const value = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : value;

  if (!/^[0-9a-f]{6}$/.test(expanded)) {
    throw new RangeError(`Expected a 3- or 6-digit hexadecimal color, received ${hex}.`);
  }

  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
};

const linearChannel = (channel: number): number => {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex: string): number => {
  const [red, green, blue] = parseHex(hex);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
};

/** Returns the WCAG contrast ratio for two opaque hexadecimal colors. */
export const contrastRatio = (foreground: string, background: string): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Selects the higher-contrast standard foreground for an accent fill. */
export const readableForeground = (accent: string): string =>
  contrastRatio(WHITE, accent) >= contrastRatio(DARK_FOREGROUND, accent) ? WHITE : DARK_FOREGROUND;

export const getTheme = (theme: UiTheme): ThemeTokens => WORKJET_UI_CONTRACT.themes[theme];

export const getCategoryAccent = (category: UiCategory): CategoryAccent =>
  WORKJET_UI_CONTRACT.categories[category];

export const getCategoryThemeAccent = (
  category: UiCategory,
  theme: UiTheme,
): Readonly<{ accent: string; foreground: string; soft: string; border: string }> => {
  const token = getCategoryAccent(category);
  return {
    accent: token.accent,
    foreground: token.foreground,
    soft: theme === "dark" ? token.softDark : token.softLight,
    border: theme === "dark" ? token.borderDark : token.borderLight,
  };
};

export const categoryAccentCssVariable = (category: UiCategory): string =>
  `--workjet-category-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-accent`;

export const findForbiddenTerms = (copy: string): readonly string[] => {
  const normalizedCopy = copy.toLocaleLowerCase();
  const terms = WORKJET_UI_CONTRACT.vocabulary.forbiddenTerms.filter((term) =>
    normalizedCopy.includes(term.toLocaleLowerCase()),
  );
  const patterns = WORKJET_UI_CONTRACT.vocabulary.forbiddenPatterns
    .map((pattern) => new RegExp(pattern, "iu"))
    .filter((pattern) => pattern.test(copy))
    .map((pattern) => pattern.source);

  return Object.freeze([...new Set([...terms, ...patterns])]);
};

export const isForbiddenUserTerm = (copy: string): boolean => findForbiddenTerms(copy).length > 0;

export const isUserFacingCopy = (copy: string): boolean => !isForbiddenUserTerm(copy);
