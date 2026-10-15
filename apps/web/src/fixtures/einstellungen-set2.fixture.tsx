/**
 * Isolierte Fixture für WP-SET2 (Screenshots, kein Backend): Navigation ohne
 * „Projekte“, Presets statt Lumas, Presets-Seite bei abgelaufener Anmeldung
 * und die Arbeitskopien-Zeilen unter Rechner › Dieser Rechner.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { useState } from "react";

import { ProjectCheckoutRow } from "../components/settings/ProjectSettingsPanel";
import { settingsNavItems } from "../components/settings/settingsNavigation";
import { searchSettings } from "../components/settings/settingsSearch";
import { WorkjetPresetsUnavailableView } from "../components/settings/WorkjetSettings";
import "../index.css";

const view = new URLSearchParams(window.location.search).get("view") ?? "nav";

function Nav() {
  return (
    <div className="flex flex-wrap gap-6 p-4">
      <nav className="w-56 shrink-0 space-y-0.5" data-fixture="nav">
        {settingsNavItems(true).map((item) => (
          <div key={item.to} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px]">
            <item.icon className="size-3.5 text-muted-foreground/70" />
            {item.label}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1 space-y-1 text-[13.5px]" data-fixture="search">
        {["lumas", "presets", "projekte", "arbeitskopie"].map((query) => (
          <div key={query}>
            <span className="text-muted-foreground">Suche „{query}“: </span>
            {searchSettings(query, { developerMode: true })
              .map((hit) => hit.title)
              .join(" · ") || "—"}
          </div>
        ))}
      </div>
    </div>
  );
}

const CHECKOUTS = [
  { name: "CTOX", scripts: ["Build", "Tests"], places: ["Dieser Rechner"] },
  { name: "Workjet", scripts: ["vp check"], places: ["Dieser Rechner", "gpu3-a4500"] },
  { name: "Molecularity", scripts: [], places: ["Dieser Rechner"] },
];

function Checkouts() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="p-5">
      <h1 className="mb-4 text-[22px] font-semibold">Dieser Rechner</h1>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {CHECKOUTS.map((entry) => (
          <ProjectCheckoutRow
            key={entry.name}
            name={entry.name}
            open={open === entry.name}
            onToggle={() => setOpen(open === entry.name ? null : entry.name)}
            group={
              {
                projectKey: entry.name,
                memberProjects: entry.places.map((place) => ({
                  environmentLabel: place,
                  scripts: entry.scripts.map((script) => ({ name: script })),
                })),
              } as unknown as Parameters<typeof ProjectCheckoutRow>[0]["group"]
            }
          />
        ))}
      </div>
    </div>
  );
}

function Fixture() {
  return (
  <div className="flex min-h-screen flex-col bg-background text-foreground">
    {view === "presets" ? (
      <WorkjetPresetsUnavailableView
        title="Presets"
        state="authentication"
        onRetry={() => undefined}
        onReconnect={() => undefined}
      />
    ) : view === "projects" ? (
      <Checkouts />
    ) : (
      <Nav />
    )}
  </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
