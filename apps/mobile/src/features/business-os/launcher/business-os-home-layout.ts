import type { BusinessOsMobileAppDescriptor } from "./business-os-app-catalog";

export const BUSINESS_OS_HOME_LAYOUT_TYPE = "workjet.business-os-home-layout.v1" as const;

export type BusinessOsHomeItem =
  | { readonly kind: "app"; readonly id: string; readonly appId: string }
  | {
      readonly kind: "folder";
      readonly id: string;
      readonly title: string;
      readonly appIds: readonly string[];
    };

export interface BusinessOsHomeLayout {
  readonly type: typeof BUSINESS_OS_HOME_LAYOUT_TYPE;
  readonly pages: readonly (readonly BusinessOsHomeItem[])[];
  readonly dock: readonly string[];
  readonly updatedAtMs: number;
}

export type BusinessOsWindowClass = "compact" | "medium" | "expanded";

export function businessOsWindowClass(width: number): BusinessOsWindowClass {
  if (width < 600) return "compact";
  if (width < 840) return "medium";
  return "expanded";
}

export function businessOsHomeGrid(input: { readonly width: number; readonly height: number }) {
  const windowClass = businessOsWindowClass(input.width);
  const landscape = input.width > input.height;
  if (windowClass === "expanded") {
    return { columns: landscape ? 8 : 6, rows: landscape ? 4 : 6, windowClass } as const;
  }
  if (windowClass === "medium") {
    return { columns: landscape ? 7 : 5, rows: landscape ? 4 : 6, windowClass } as const;
  }
  return { columns: landscape ? 6 : 4, rows: landscape ? 3 : 5, windowClass } as const;
}

export function createDefaultBusinessOsHomeLayout(
  apps: readonly BusinessOsMobileAppDescriptor[],
  capacity = 20,
): BusinessOsHomeLayout {
  const visible = apps.filter((app) => !app.desktopOnly);
  const dock = ["ctox", "threads", "tickets", "mail"].filter((id) =>
    visible.some((app) => app.id === id),
  );
  const pages: BusinessOsHomeItem[][] = [];
  for (let index = 0; index < visible.length; index += capacity) {
    pages.push(
      visible.slice(index, index + capacity).map((app) => ({
        kind: "app",
        id: `app:${app.id}`,
        appId: app.id,
      })),
    );
  }
  return Object.freeze({
    type: BUSINESS_OS_HOME_LAYOUT_TYPE,
    pages: Object.freeze((pages.length ? pages : [[]]).map((page) => Object.freeze(page))),
    dock: Object.freeze(dock),
    updatedAtMs: Date.now(),
  });
}

export function reconcileBusinessOsHomeLayout(
  layout: BusinessOsHomeLayout,
  apps: readonly BusinessOsMobileAppDescriptor[],
): BusinessOsHomeLayout {
  const known = new Set(apps.map((app) => app.id));
  const placed = new Set<string>();
  const pages = layout.pages.map((page) =>
    page.flatMap((item): BusinessOsHomeItem[] => {
      if (item.kind === "app") {
        if (!known.has(item.appId) || placed.has(item.appId)) return [];
        placed.add(item.appId);
        return [item];
      }
      const appIds = item.appIds.filter((appId) => known.has(appId) && !placed.has(appId));
      appIds.forEach((appId) => placed.add(appId));
      return appIds.length > 0 ? [{ ...item, appIds: Object.freeze(appIds) }] : [];
    }),
  );
  const missing = apps
    .filter((app) => !app.desktopOnly && !placed.has(app.id))
    .map((app): BusinessOsHomeItem => ({ kind: "app", id: `app:${app.id}`, appId: app.id }));
  if (missing.length) pages.push(missing);
  const dock = layout.dock.filter(
    (appId, index) => known.has(appId) && layout.dock.indexOf(appId) === index,
  );
  return Object.freeze({
    ...layout,
    pages: Object.freeze((pages.length ? pages : [[]]).map((page) => Object.freeze(page))),
    dock: Object.freeze(dock),
    updatedAtMs: Date.now(),
  });
}

export function moveBusinessOsHomeItem(input: {
  readonly layout: BusinessOsHomeLayout;
  readonly pageIndex: number;
  readonly sourceIndex: number;
  readonly targetIndex: number;
}): BusinessOsHomeLayout {
  const pages = input.layout.pages.map((page) => [...page]);
  const page = pages[input.pageIndex];
  if (!page || input.sourceIndex === input.targetIndex) return input.layout;
  const source = page[input.sourceIndex];
  const target = page[input.targetIndex];
  if (!source || !target) return input.layout;
  if (source.kind === "app" && target.kind === "app") {
    page.splice(Math.max(input.sourceIndex, input.targetIndex), 1);
    page.splice(Math.min(input.sourceIndex, input.targetIndex), 1, {
      kind: "folder",
      id: `folder:${target.appId}:${source.appId}`,
      title: "Ordner",
      appIds: Object.freeze([target.appId, source.appId]),
    });
  } else if (source.kind === "app" && target.kind === "folder") {
    page.splice(input.sourceIndex, 1);
    const folderIndex = page.findIndex((item) => item.id === target.id);
    if (folderIndex >= 0) {
      page[folderIndex] = {
        ...target,
        appIds: Object.freeze([...target.appIds, source.appId]),
      };
    }
  } else {
    page.splice(input.sourceIndex, 1);
    page.splice(input.targetIndex, 0, source);
  }
  return Object.freeze({
    ...input.layout,
    pages: Object.freeze(pages.map((next) => Object.freeze(next))),
    updatedAtMs: Date.now(),
  });
}

export function decodeBusinessOsHomeLayout(payload: string): BusinessOsHomeLayout {
  const parsed = JSON.parse(payload) as Partial<BusinessOsHomeLayout>;
  if (
    parsed.type !== BUSINESS_OS_HOME_LAYOUT_TYPE ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length < 1 ||
    parsed.pages.length > 12 ||
    !Array.isArray(parsed.dock) ||
    parsed.dock.length > 8 ||
    !Number.isSafeInteger(parsed.updatedAtMs)
  ) {
    throw new Error("Business OS home layout is invalid.");
  }
  const ids = new Set<string>();
  const safeId = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
  const pages = parsed.pages.map((page) => {
    if (!Array.isArray(page) || page.length > 80)
      throw new Error("Business OS home page is invalid.");
    return page.map((raw) => {
      if (!raw || typeof raw !== "object") throw new Error("Business OS home item is invalid.");
      const item = raw as Partial<BusinessOsHomeItem>;
      if (typeof item.id !== "string" || !safeId.test(item.id) || ids.has(item.id)) {
        throw new Error("Business OS home item identity is invalid.");
      }
      ids.add(item.id);
      if (item.kind === "app" && typeof item.appId === "string" && safeId.test(item.appId)) {
        return Object.freeze({ kind: "app", id: item.id, appId: item.appId }) as BusinessOsHomeItem;
      }
      if (
        item.kind === "folder" &&
        typeof item.title === "string" &&
        item.title.length > 0 &&
        item.title.length <= 48 &&
        Array.isArray(item.appIds) &&
        item.appIds.length > 0 &&
        item.appIds.length <= 32 &&
        item.appIds.every((id) => typeof id === "string" && safeId.test(id))
      ) {
        return Object.freeze({
          kind: "folder",
          id: item.id,
          title: item.title,
          appIds: Object.freeze([...new Set(item.appIds)]),
        }) as BusinessOsHomeItem;
      }
      throw new Error("Business OS home item is invalid.");
    });
  });
  if (!parsed.dock.every((id) => typeof id === "string" && safeId.test(id))) {
    throw new Error("Business OS home dock is invalid.");
  }
  const dock = parsed.dock as string[];
  const updatedAtMs = parsed.updatedAtMs as number;
  return Object.freeze({
    type: BUSINESS_OS_HOME_LAYOUT_TYPE,
    pages: Object.freeze(pages.map((page) => Object.freeze(page))),
    dock: Object.freeze([...new Set(dock)]),
    updatedAtMs,
  });
}
