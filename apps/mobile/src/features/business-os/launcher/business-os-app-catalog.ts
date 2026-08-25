import type { AppSymbolName } from "../../../components/AppSymbol";

export const BUSINESS_OS_MOBILE_CATALOG_TYPE = "workjet.business-os-mobile-apps.v1" as const;

export type BusinessOsMobilePresentation = "list-detail" | "feed" | "form" | "canvas" | "document";

export interface BusinessOsMobileAppDescriptor {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly icon: AppSymbolName;
  readonly accent: string;
  readonly mobilePresentation: BusinessOsMobilePresentation;
  readonly phoneReady: boolean;
  readonly tabletReady: boolean;
  readonly desktopOnly?: boolean;
}

export interface BusinessOsMobileAppCatalog {
  readonly type: typeof BUSINESS_OS_MOBILE_CATALOG_TYPE;
  readonly revision: string;
  readonly apps: readonly BusinessOsMobileAppDescriptor[];
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_ACCENT = /^#[0-9a-f]{6}$/u;
const PRESENTATIONS = new Set<BusinessOsMobilePresentation>([
  "list-detail",
  "feed",
  "form",
  "canvas",
  "document",
]);

const BUILT_IN_APPS: readonly BusinessOsMobileAppDescriptor[] = [
  {
    id: "ctox",
    title: "CTOX Backend",
    category: "System",
    icon: "bolt.horizontal.circle",
    accent: "#2563eb",
    mobilePresentation: "feed",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "tickets",
    title: "Tickets",
    category: "Operations",
    icon: "checkmark.circle",
    accent: "#0f766e",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "threads",
    title: "Threads",
    category: "System",
    icon: "text.bubble",
    accent: "#7c3aed",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "knowledge",
    title: "Knowledge",
    category: "Knowledge",
    icon: "doc.text",
    accent: "#0891b2",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "browser",
    title: "Browser",
    category: "Workspace",
    icon: "safari",
    accent: "#0284c7",
    mobilePresentation: "canvas",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "credentials",
    title: "Credentials",
    category: "Security",
    icon: "server.rack",
    accent: "#475569",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "mail",
    title: "Mail",
    category: "Collaboration",
    icon: "text.bubble",
    accent: "#2563eb",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "app-store",
    title: "App Store",
    category: "Development",
    icon: "folder.fill",
    accent: "#db2777",
    mobilePresentation: "feed",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "importer",
    title: "App Importer",
    category: "Development",
    icon: "arrow.down.circle",
    accent: "#ea580c",
    mobilePresentation: "form",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "reports",
    title: "Bugs & Features",
    category: "Governance",
    icon: "chart.bar.xaxis",
    accent: "#ca8a04",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "appsec-pentest",
    title: "Penetration Testing",
    category: "Security",
    icon: "exclamationmark.triangle",
    accent: "#dc2626",
    mobilePresentation: "canvas",
    phoneReady: false,
    tabletReady: true,
    desktopOnly: true,
  },
  {
    id: "coding-agents",
    title: "Coding Agents",
    category: "Development",
    icon: "chevron.left.forwardslash.chevron.right",
    accent: "#4f46e5",
    mobilePresentation: "feed",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "conversations",
    title: "Conversations",
    category: "Collaboration",
    icon: "text.bubble",
    accent: "#7c3aed",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "customers",
    title: "Kunden",
    category: "Sales",
    icon: "person.crop.circle",
    accent: "#059669",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "invoices",
    title: "Rechnungen",
    category: "Finance",
    icon: "doc.text",
    accent: "#16a34a",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "buchhaltung",
    title: "Buchhaltung",
    category: "Finance",
    icon: "chart.bar.xaxis",
    accent: "#15803d",
    mobilePresentation: "list-detail",
    phoneReady: true,
    tabletReady: true,
  },
  {
    id: "documents",
    title: "Documents",
    category: "Knowledge",
    icon: "doc.text",
    accent: "#2563eb",
    mobilePresentation: "document",
    phoneReady: true,
    tabletReady: true,
  },
] as const;

export const BUILT_IN_BUSINESS_OS_MOBILE_CATALOG: BusinessOsMobileAppCatalog = Object.freeze({
  type: BUSINESS_OS_MOBILE_CATALOG_TYPE,
  revision: "workjet-builtin-2026-08-25",
  apps: Object.freeze(BUILT_IN_APPS.map((app) => Object.freeze({ ...app }))),
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function decodeBusinessOsMobileAppCatalog(value: unknown): BusinessOsMobileAppCatalog {
  const candidate = record(value);
  if (
    candidate?.type !== BUSINESS_OS_MOBILE_CATALOG_TYPE ||
    typeof candidate.revision !== "string" ||
    candidate.revision.length < 1 ||
    candidate.revision.length > 256 ||
    !Array.isArray(candidate.apps) ||
    candidate.apps.length > 256
  ) {
    throw new Error("Business OS mobile app catalog is invalid.");
  }
  const ids = new Set<string>();
  const apps = candidate.apps.map((raw) => {
    const app = record(raw);
    if (
      !app ||
      typeof app.id !== "string" ||
      !SAFE_ID.test(app.id) ||
      ids.has(app.id) ||
      typeof app.title !== "string" ||
      app.title.length < 1 ||
      app.title.length > 80 ||
      typeof app.category !== "string" ||
      app.category.length < 1 ||
      app.category.length > 48 ||
      typeof app.accent !== "string" ||
      !SAFE_ACCENT.test(app.accent) ||
      typeof app.mobilePresentation !== "string" ||
      !PRESENTATIONS.has(app.mobilePresentation as BusinessOsMobilePresentation) ||
      typeof app.phoneReady !== "boolean" ||
      typeof app.tabletReady !== "boolean"
    ) {
      throw new Error("Business OS mobile app descriptor is invalid.");
    }
    ids.add(app.id);
    return Object.freeze({
      id: app.id,
      title: app.title,
      category: app.category,
      // Runtime catalogs never provide native symbol names. Untrusted inline
      // SVG/HTML is deliberately reduced to a deterministic safe fallback.
      icon: "folder" as AppSymbolName,
      accent: app.accent,
      mobilePresentation: app.mobilePresentation as BusinessOsMobilePresentation,
      phoneReady: app.phoneReady,
      tabletReady: app.tabletReady,
      desktopOnly: app.desktopOnly === true,
    });
  });
  return Object.freeze({
    type: BUSINESS_OS_MOBILE_CATALOG_TYPE,
    revision: candidate.revision,
    apps: Object.freeze(apps),
  });
}

export function mergeBusinessOsMobileCatalog(
  runtime: BusinessOsMobileAppCatalog | null,
): BusinessOsMobileAppCatalog {
  if (!runtime) return BUILT_IN_BUSINESS_OS_MOBILE_CATALOG;
  const builtIn = new Map(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.map((app) => [app.id, app]));
  return Object.freeze({
    ...runtime,
    apps: Object.freeze(
      runtime.apps.map((app) => {
        const trusted = builtIn.get(app.id);
        return trusted ? Object.freeze({ ...app, icon: trusted.icon }) : app;
      }),
    ),
  });
}
