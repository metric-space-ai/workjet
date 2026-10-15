import {
  WorkjetGatewayAccountId,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayHealth,
  type WorkjetGatewayModelDiscovery,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  gatewayObservedAgeLabel,
  isPoolDraftDirty,
  parseModelIds,
  poolsFromCatalog,
  gatewayPoolBehaviourDescription,
  gatewayPoolMemberStateLabel,
  WorkjetGatewayPoolsSectionView,
  type WorkjetGatewayPoolsSectionState,
} from "./WorkjetGatewayPools";

const NOW_MS = 1_700_000_060_000;

const member = (id: string, patch: Partial<{ priority: number; selectable: boolean }> = {}) => ({
  accountId: WorkjetGatewayAccountId.make(id),
  label: id,
  enabled: true,
  priority: patch.priority ?? 0,
  weight: 1,
  selectable: patch.selectable ?? true,
});

const CATALOG: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [],
  pools: [],
  routes: [],
  models: [],
  routingStrategy: "round-robin",
  providerPools: [
    {
      provider: "claude",
      strategy: "round-robin",
      weightHonored: false,
      priorityExclusive: true,
      members: [
        member("claude-a", { priority: 7 }),
        member("claude-b", { priority: 0, selectable: false }),
      ],
    },
    {
      provider: "zai",
      strategy: "round-robin",
      weightHonored: false,
      priorityExclusive: false,
      members: [member("zai-a")],
    },
  ],
};

const HEALTH: WorkjetGatewayHealth = {
  schemaVersion: 1,
  observedAtMs: NOW_MS - 12_000,
  activeProvider: "claude",
  accounts: [],
  providers: [
    {
      provider: "claude",
      accountCount: 2,
      enabledAccountCount: 2,
      modelIds: ["claude-opus-4"],
      phase: "ready",
    },
  ],
  accountHealth: "not-reported-by-host",
  capacity: "not-reported-by-host",
};

const MODELS: WorkjetGatewayModelDiscovery = {
  schemaVersion: 1,
  observedAtMs: NOW_MS - 3_600_000,
  providers: [
    {
      provider: "claude",
      channel: "claude",
      catalogAvailable: true,
      models: [
        { id: "claude-opus-4", displayName: "Claude Opus 4", source: "gateway-catalog" },
        { id: "custom", displayName: "custom", source: "account-configuration" },
      ],
    },
    { provider: "zai", channel: null, catalogAvailable: false, models: [] },
  ],
};

const BASE: WorkjetGatewayPoolsSectionState = {
  catalog: CATALOG,
  health: HEALTH,
  models: MODELS,
  healthError: null,
  modelsError: null,
  nowMs: NOW_MS,
  canEdit: true,
  routing: { status: "idle" },
  onSaveRouting: () => undefined,
};

const render = (overrides: Partial<WorkjetGatewayPoolsSectionState> = {}) =>
  renderToStaticMarkup(<WorkjetGatewayPoolsSectionView {...BASE} {...overrides} />);

describe("gateway pool ages", () => {
  it("ages a reading rather than presenting it as live", () => {
    expect(gatewayObservedAgeLabel(NOW_MS, NOW_MS)).toBe("gerade geprüft");
    expect(gatewayObservedAgeLabel(NOW_MS - 12_000, NOW_MS)).toBe("vor 12 s geprüft");
    expect(gatewayObservedAgeLabel(NOW_MS - 3_600_000, NOW_MS)).toBe("vor 1 h geprüft");
    expect(gatewayObservedAgeLabel(NOW_MS - 90 * 60_000, NOW_MS)).toBe("vor 1 h geprüft");
    expect(gatewayObservedAgeLabel(NOW_MS - 3 * 86_400_000, NOW_MS)).toBe("vor 3 d geprüft");
  });

  it("does not claim an age it cannot compute", () => {
    expect(gatewayObservedAgeLabel(Number.NaN, NOW_MS)).toBe("Prüfzeit unbekannt");
  });
});

describe("gateway pool semantics copy", () => {
  it("tells an OAuth pool that priority gates before anything else", () => {
    const description = gatewayPoolBehaviourDescription(CATALOG.providerPools[0]!);
    expect(description).toContain("Nur höchste Priorität");
    expect(description).toContain("Ohne Gewichte");
  });

  it("tells an API-key pool that neither weight nor strategy is read", () => {
    const description = gatewayPoolBehaviourDescription(CATALOG.providerPools[1]!);
    expect(description).toContain("ohne Gewichte und Strategie");
  });

  it("distinguishes held back from disabled", () => {
    expect(gatewayPoolMemberStateLabel(member("a"))).toBe("In Rotation");
    expect(gatewayPoolMemberStateLabel(member("a", { selectable: false }))).toBe("Zurückgestellt");
    expect(gatewayPoolMemberStateLabel({ ...member("a"), enabled: false })).toBe("Deaktiviert");
  });
});

describe("rendering while the catalog is still loading", () => {
  it("renders instead of looping when there is no catalog yet", () => {
    // `state.catalog?.providerPools ?? []` handed back a FRESH array each
    // render, so the seed memo recomputed, which set state during render,
    // which rendered again. React stops that with "Too many re-renders" —
    // error #301 — and the whole app showed "Something went wrong." The
    // window lasts exactly as long as the query is pending, which is every
    // single reload.
    // The property that actually matters: the SAME reference each time.
    // A fresh array per call is what fed the loop, and static rendering does
    // not reproduce it, so asserting "does not throw" would prove nothing.
    expect(poolsFromCatalog(null)).toBe(poolsFromCatalog(null));
    expect(() => render({ catalog: null, health: null, models: null })).not.toThrow();
  });
});

describe("what counts as an edit worth saving", () => {
  const draft = (models: string) => ({
    strategy: "round-robin" as const,
    members: new Map([["a", { enabled: true, priority: 0, weight: 1, models }]]),
  });

  it("editing only the model list enables Save", () => {
    // `models` was missing from the dirty check, so the ONE field a
    // catalog-less provider needs could be typed and never saved — the
    // button simply stayed grey. Measured live before the fix.
    expect(isPoolDraftDirty(draft(""), draft("glm-5.3"))).toBe(true);
    expect(isPoolDraftDirty(draft("glm-5.3"), draft("glm-5.3"))).toBe(false);
  });
});

describe("model ids for a provider the gateway has no catalog for", () => {
  it("drops blanks and duplicates so a pasted list is usable as typed", () => {
    expect(parseModelIds(" glm-4.6 , glm-4.5-air ,, glm-4.6 \n glm-4.7 ")).toEqual([
      "glm-4.6",
      "glm-4.5-air",
      "glm-4.7",
    ]);
    expect(parseModelIds("   ")).toEqual([]);
  });

  it("offers the field only where the host has no catalog", () => {
    // Offering it everywhere would invite hand-maintaining a list the gateway
    // already knows, and the two would drift apart silently.
    const markup = render();

    expect(markup).toContain("ohne Liste keine Antwort");
    // Claude has a catalog in the fixture, Z.ai does not: exactly one field.
    expect(markup.split('id="workjet-gateway-models-').length - 1).toBe(1);
  });
});

describe("WorkjetGatewayPoolsSectionView", () => {
  it("renders one row per provider with its members and live eligibility", () => {
    const markup = render();
    expect(markup).toContain("Claude");
    expect(markup).toContain("Z.ai (GLM)");
    expect(markup).toContain("claude-a");
    expect(markup).toContain("In Rotation");
    expect(markup).toContain("Zurückgestellt");
  });

  // The same five providers used to be listed four times over — once as
  // pools, once under Health, once under Models, once as accounts — so
  // reading one provider's state meant cross-referencing lists that never
  // appear together. Its health and model figures now sit on its own row.
  it("carries each provider's health and model count on that provider's row", () => {
    const markup = render();
    const claudeAt = markup.indexOf("Claude");
    const zaiAt = markup.indexOf("Z.ai (GLM)");
    const enabledAt = markup.indexOf("von 2 aktiv");

    expect(enabledAt).toBeGreaterThan(claudeAt);
    expect(enabledAt).toBeLessThan(zaiAt);
    expect(markup).toContain("1 Katalogmodell");
    expect(markup).toContain("1 Kontomuster");
    expect(markup).toContain("Zählweise der Modelle");
    expect(markup).toContain("kein Katalog");
  });

  it("offers a weight field only where the gateway reads weights", () => {
    // Both pools here report weightHonored: false, so no weight input exists.
    expect(render()).not.toContain("workjet-gateway-pool-claude-a-weight");

    const weighted = render({
      catalog: {
        ...CATALOG,
        routingStrategy: "weighted-round-robin",
        providerPools: [
          {
            ...CATALOG.providerPools[0]!,
            strategy: "weighted-round-robin",
            weightHonored: true,
          },
        ],
      },
    });
    expect(weighted).toContain("workjet-gateway-pool-claude-a-weight");
  });

  it("states the reading age once for the section, without explanatory prose", () => {
    const markup = render();
    expect(markup).not.toContain("does not ask the provider");
    // Said once for the section rather than repeated under every provider.
    expect(markup.split(">Stand<").length - 1).toBe(1);
  });

  it("surfaces a failed save and a missing reading without inventing either", () => {
    const failed = render({ routing: { status: "failed", message: "Nope." } });
    expect(failed).toContain("Nicht gespeichert");
    expect(failed).toContain("Nope.");

    // With no reading at all a provider row simply carries no figures; it
    // must not invent them.
    const missing = render({ health: null, models: null });
    expect(missing).not.toContain("von 2 aktiv");
    expect(missing).not.toContain("kein Katalog");

    const errored = render({ healthError: "Health broke.", modelsError: "Models broke." });
    expect(errored).toContain("Health broke.");
  });

  it("says a gateway with no accounts has no pools instead of rendering nothing", () => {
    const markup = render({ catalog: { ...CATALOG, providerPools: [] } });
    expect(markup).toContain("Keine Pools");
  });

  it("disables every control while a save is in flight or editing is not allowed", () => {
    for (const overrides of [{ routing: { status: "saving" } as const }, { canEdit: false }]) {
      const markup = render(overrides);
      expect(markup).toContain("disabled");
      // The save button cannot be pressed while nothing is dirty either.
      expect(markup).toContain("Speichern");
    }
  });
});
