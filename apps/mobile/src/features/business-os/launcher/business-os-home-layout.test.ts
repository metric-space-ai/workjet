import { describe, expect, it, vi } from "vite-plus/test";

import { BUILT_IN_BUSINESS_OS_MOBILE_CATALOG } from "./business-os-app-catalog";
import {
  businessOsHomeGrid,
  businessOsWindowClass,
  createDefaultBusinessOsHomeLayout,
  decodeBusinessOsHomeLayout,
  moveBusinessOsHomeItem,
  reconcileBusinessOsHomeLayout,
} from "./business-os-home-layout";
import { addBusinessOsRecent, decodeBusinessOsRecents } from "./native-business-os-home-store";

vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn() }));

describe("Business OS native home model", () => {
  it("uses compact, medium, and expanded window classes", () => {
    expect(businessOsWindowClass(599)).toBe("compact");
    expect(businessOsWindowClass(600)).toBe("medium");
    expect(businessOsWindowClass(839)).toBe("medium");
    expect(businessOsWindowClass(840)).toBe("expanded");
  });

  it("adapts the launcher grid for 3:4 and 4:3 tablets", () => {
    expect(businessOsHomeGrid({ width: 768, height: 1024 })).toMatchObject({
      columns: 5,
      rows: 6,
      windowClass: "medium",
    });
    expect(businessOsHomeGrid({ width: 1024, height: 768 })).toMatchObject({
      columns: 8,
      rows: 4,
      windowClass: "expanded",
    });
  });

  it("creates folders when one app is dropped onto another", () => {
    const layout = createDefaultBusinessOsHomeLayout(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps, 20);
    const moved = moveBusinessOsHomeItem({
      layout,
      pageIndex: 0,
      sourceIndex: 0,
      targetIndex: 1,
    });
    expect(moved.pages[0]?.[0]).toMatchObject({ kind: "folder", appIds: ["tickets", "ctox"] });
  });

  it("keeps existing positions and leaves new apps in the App Library", () => {
    const initial = createDefaultBusinessOsHomeLayout(
      BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.slice(0, 3),
      20,
    );
    const next = reconcileBusinessOsHomeLayout(
      initial,
      BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.slice(0, 5),
    );
    expect(next.pages[0]?.map((item) => item.id)).toEqual(initial.pages[0]?.map((item) => item.id));
    expect(next.pages.flat().map((item) => item.id)).not.toContain("app:knowledge");
    expect(next.pages.flat().map((item) => item.id)).not.toContain("app:browser");
  });

  it("ships exactly the 34 native Business OS app identities without desktop", () => {
    expect(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps).toHaveLength(34);
    expect(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.map((app) => app.id)).not.toContain("desktop");
    expect(
      new Set(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.map((app) => app.iconAssetId)).size,
    ).toBe(34);
  });

  it("round-trips a bounded local layout", () => {
    const layout = createDefaultBusinessOsHomeLayout(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps, 20);
    expect(decodeBusinessOsHomeLayout(JSON.stringify(layout))).toEqual(layout);
  });

  it("keeps safe recents metadata only", () => {
    const recents = addBusinessOsRecent([], "threads", 10);
    expect(addBusinessOsRecent(recents, "tickets", 20)).toEqual([
      { appId: "tickets", lastOpenedAtMs: 20 },
      { appId: "threads", lastOpenedAtMs: 10 },
    ]);
    expect(decodeBusinessOsRecents(JSON.stringify(recents))).toEqual(recents);
    expect(() =>
      decodeBusinessOsRecents('[{"appId":"threads","lastOpenedAtMs":1,"secret":"x"}]'),
    ).not.toThrow();
  });
});
