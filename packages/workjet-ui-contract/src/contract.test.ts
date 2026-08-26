import { describe, expect, it } from "@effect/vitest";

import {
  UI_CATEGORIES,
  UI_THEMES,
  WORKJET_UI_CONTRACT,
  categoryAccentCssVariable,
  contrastRatio,
  findForbiddenTerms,
  getCategoryAccent,
  getCategoryThemeAccent,
  getTheme,
  isForbiddenUserTerm,
  isUserFacingCopy,
  readableForeground,
} from "./index.ts";

describe("Workjet UI contract", () => {
  it("defines both themes with the complete surface, text, border, and accent roles", () => {
    expect(UI_THEMES).toEqual(["light", "dark"]);

    for (const themeName of UI_THEMES) {
      const theme = getTheme(themeName);
      expect(Object.keys(theme.surfaces)).toEqual([
        "canvas",
        "chrome",
        "surface",
        "raised",
        "overlay",
        "sunken",
      ]);
      expect(Object.keys(theme.text)).toEqual(["primary", "secondary", "muted", "onAccent"]);
      expect(Object.keys(theme.borders)).toEqual(["subtle", "default", "strong"]);
      expect(contrastRatio(theme.text.primary, theme.surfaces.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.text.muted, theme.surfaces.canvas)).toBeGreaterThanOrEqual(3);
    }

    expect(getTheme("light").surfaces.canvas).not.toBe(getTheme("dark").surfaces.canvas);
    expect(getTheme("light").accent.value).not.toBe(getTheme("dark").accent.value);
  });

  it("keeps every canonical category on one contrast-safe accent contract", () => {
    expect(UI_CATEGORIES).toEqual([
      "Workspace",
      "Collaboration",
      "Productivity",
      "Development",
      "Engineering",
      "Knowledge",
      "Research",
      "Sales",
      "Recruiting",
      "Finance",
      "Operations",
      "Governance",
      "Security",
      "Analytics",
      "System",
      "Imported",
    ]);
    expect(new Set(UI_CATEGORIES).size).toBe(UI_CATEGORIES.length);

    for (const category of UI_CATEGORIES) {
      const token = getCategoryAccent(category);
      expect(token.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token.foreground).toBe(readableForeground(token.accent));
      expect(token.softLight).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token.softDark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token.borderLight).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token.borderDark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(token.foreground, token.accent)).toBeGreaterThanOrEqual(
        WORKJET_UI_CONTRACT.focus.minContrastRatio,
      );
      expect(getCategoryThemeAccent(category, "light")).toMatchObject({
        accent: token.accent,
        foreground: token.foreground,
        soft: token.softLight,
        border: token.borderLight,
      });
      expect(getCategoryThemeAccent(category, "dark")).toMatchObject({
        soft: token.softDark,
        border: token.borderDark,
      });
      expect(categoryAccentCssVariable(category)).toMatch(/^--workjet-category-[a-z-]+-accent$/);
    }

    expect(getCategoryAccent("Workspace").accent).toBe("#2563eb");
    expect(getCategoryAccent("Collaboration").accent).toBe("#0891b2");
    expect(getCategoryAccent("Engineering").accent).toBe("#7c3aed");
    expect(getCategoryAccent("Security").accent).toBe("#dc2626");
    expect(getCategoryAccent("Imported").accent).toBe("#71717a");
  });

  it("provides stable type, rhythm, focus, and elevation primitives", () => {
    expect(WORKJET_UI_CONTRACT.typography.scale.body).toEqual({ fontSize: 16, lineHeight: 23 });
    expect(WORKJET_UI_CONTRACT.typography.scale.display).toEqual({ fontSize: 30, lineHeight: 36 });
    expect(WORKJET_UI_CONTRACT.typography.weights).toMatchObject({
      regular: 400,
      medium: 500,
      semibold: 600,
    });
    expect(WORKJET_UI_CONTRACT.spacing).toMatchObject({ "1": 4, "2": 8, "4": 16, "8": 32 });
    expect(WORKJET_UI_CONTRACT.radii).toMatchObject({ control: 6, panel: 10, card: 14 });
    expect(WORKJET_UI_CONTRACT.focus.outlineWidth).toBe(2);
    expect(WORKJET_UI_CONTRACT.focus.outlineOffset).toBe(2);
    expect(WORKJET_UI_CONTRACT.elevation).toMatchObject({
      none: "none",
      low: expect.any(String),
      overlay: expect.any(String),
    });
  });

  it("separates approved user vocabulary from implementation terminology", () => {
    expect(WORKJET_UI_CONTRACT.vocabulary.userTerms).toContain("Settings");
    expect(WORKJET_UI_CONTRACT.vocabulary.forbiddenTerms).toContain("WebRTC");
    expect(WORKJET_UI_CONTRACT.vocabulary.forbiddenTerms).toContain("Guest");
    expect(isUserFacingCopy("Open Workjet Settings and choose Dark appearance.")).toBe(true);
    expect(isForbiddenUserTerm("The WebRTC daemon is waiting for replication.")).toBe(true);
    expect(findForbiddenTerms("Show the RxDB peer session")).not.toHaveLength(0);

    for (const term of WORKJET_UI_CONTRACT.vocabulary.forbiddenTerms) {
      expect(isForbiddenUserTerm(`A message mentions ${term}.`)).toBe(true);
    }
  });
});
