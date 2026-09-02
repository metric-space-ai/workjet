import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  WorkjetComputerId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAutomaticCurrentComputerHydrator,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("primary Workjet settings hydration", () => {
  it("selects and persists this machine from the three-computer cold-start profile", async () => {
    const localEnvironmentId = EnvironmentId.make("385a20df-8851-44af-af9b-bf0297dbf755");
    const localComputerId = WorkjetComputerId.make("50988886-2a39-4a55-9d91-640930524b13");
    const configuration = {
      ...DEFAULT_SERVER_SETTINGS.workjet,
      computers: [
        {
          id: localComputerId,
          label: "MacBook Pro von Michael (2)",
          environmentId: localEnvironmentId,
          presentationKind: "local" as const,
          harnesses: [],
        },
        {
          id: WorkjetComputerId.make("e77cd0ca-4051-4837-847d-8e9a17424925"),
          label: "gpu3-a4500",
          environmentId: EnvironmentId.make("unpaired-gpu3-a4500"),
          presentationKind: "tailscale" as const,
          harnesses: [],
        },
        {
          id: WorkjetComputerId.make("e93e4f5f-25dc-4e21-8c62-c7f7bf568cf4"),
          label: "gpu1-a6000",
          environmentId: EnvironmentId.make("unpaired-gpu1-a6000"),
          presentationKind: "tailscale" as const,
          harnesses: [],
        },
      ],
      selectedComputerId: null,
    };
    const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const hydrate = createAutomaticCurrentComputerHydrator();
    const input = { configuration, localEnvironmentId, ready: true, update };

    // The cached ServerConfig is present before the cold-start transport can persist.
    expect(hydrate({ ...input, ready: false })).toBe(false);
    expect(update).not.toHaveBeenCalled();

    // A failed live write is not remembered as hydrated, so the next attempt persists.
    expect(hydrate(input)).toBe(true);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(hydrate(input)).toBe(true);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(hydrate(input)).toBe(false);
    expect(update).toHaveBeenLastCalledWith({
      ...configuration,
      selectedComputerId: localComputerId,
    });
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});
