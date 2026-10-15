import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildTrayMenuEntries,
  makeLoginItemController,
  normalizeTrayProjects,
  shouldQuitWhenAllWindowsClosed,
  trayOpenProjectAction,
  type LoginItemApi,
  type LoginItemMarker,
} from "./DesktopTrayPolicy.ts";

/** Mocked `app` login-item API plus a durable marker that survives "relaunches". */
function makeFakeSystem() {
  const calls: Array<{ openAtLogin: boolean; openAsHidden: boolean }> = [];
  let openAtLogin = false;
  let markerExists = false;
  const api: LoginItemApi = {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (settings) => {
      calls.push({ ...settings });
      openAtLogin = settings.openAtLogin;
    },
  };
  const marker: LoginItemMarker = {
    exists: Effect.sync(() => markerExists),
    write: Effect.sync(() => {
      markerExists = true;
    }),
  };
  return {
    api,
    marker,
    calls,
    get markerExists() {
      return markerExists;
    },
  };
}

describe("login item", () => {
  for (const platform of ["darwin", "win32"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`first launch enables open-at-login exactly once on ${platform}`, () =>
      Effect.gen(function* () {
        const system = makeFakeSystem();
        const first = yield* makeLoginItemController({ platform, ...system }).initialize;
        assert.deepStrictEqual(first, { supported: true, openAtLogin: true });
        assert.deepStrictEqual(system.calls, [{ openAtLogin: true, openAsHidden: true }]);
        assert.isTrue(system.markerExists);

        // Second launch: the marker exists, so the app does not touch it again.
        const second = yield* makeLoginItemController({ platform, ...system }).initialize;
        assert.deepStrictEqual(second, { supported: true, openAtLogin: true });
        assert.strictEqual(system.calls.length, 1);
      }),
    );

    it.effect(`keeps the user's choice across launches on ${platform}`, () =>
      Effect.gen(function* () {
        const system = makeFakeSystem();
        const controller = makeLoginItemController({ platform, ...system });
        yield* controller.initialize;
        const disabled = yield* controller.setOpenAtLogin(false);
        assert.deepStrictEqual(disabled, { supported: true, openAtLogin: false });
        assert.deepStrictEqual(system.calls.at(-1), { openAtLogin: false, openAsHidden: true });

        const relaunched = yield* makeLoginItemController({ platform, ...system }).initialize;
        assert.deepStrictEqual(relaunched, { supported: true, openAtLogin: false });
        assert.strictEqual(system.calls.length, 2);
      }),
    );

    it.effect(`a choice made before the first automatic step also wins on ${platform}`, () =>
      Effect.gen(function* () {
        const system = makeFakeSystem();
        yield* makeLoginItemController({ platform, ...system }).setOpenAtLogin(false);
        const launched = yield* makeLoginItemController({ platform, ...system }).initialize;
        assert.deepStrictEqual(launched, { supported: true, openAtLogin: false });
        assert.deepStrictEqual(system.calls, [{ openAtLogin: false, openAsHidden: true }]);
      }),
    );
  }

  it.effect("is gated off on linux and never calls the login-item API", () =>
    Effect.gen(function* () {
      const system = makeFakeSystem();
      const controller = makeLoginItemController({ platform: "linux", ...system });
      assert.deepStrictEqual(yield* controller.initialize, {
        supported: false,
        openAtLogin: false,
      });
      assert.deepStrictEqual(yield* controller.setOpenAtLogin(true), {
        supported: false,
        openAtLogin: false,
      });
      assert.deepStrictEqual(system.calls, []);
      assert.isFalse(system.markerExists);
    }),
  );
});

describe("tray menu", () => {
  it("lists open, at most five projects, separator, login toggle, quit", () => {
    const projects = normalizeTrayProjects(
      Array.from({ length: 7 }, (_, index) => ({ key: `k${index}`, title: `Projekt ${index}` })),
    );
    const entries = buildTrayMenuEntries({
      projects,
      loginItem: { supported: true, openAtLogin: true },
    });
    assert.deepStrictEqual(
      entries.map((entry) => ("label" in entry ? entry.label : entry.kind)),
      [
        "Workjet öffnen",
        "Projekt 0",
        "Projekt 1",
        "Projekt 2",
        "Projekt 3",
        "Projekt 4",
        "separator",
        "Beim Anmelden starten",
        "Beenden",
      ],
    );
    const toggle = entries.find((entry) => entry.kind === "open-at-login");
    assert.isTrue(toggle?.kind === "open-at-login" && toggle.checked);
  });

  it("omits the login toggle where the platform has no login item", () => {
    const entries = buildTrayMenuEntries({
      projects: [],
      loginItem: { supported: false, openAtLogin: false },
    });
    assert.deepStrictEqual(
      entries.map((entry) => entry.kind),
      ["open", "separator", "quit"],
    );
  });

  it("drops malformed and duplicate projects and shortens long titles", () => {
    const projects = normalizeTrayProjects([
      { key: "a", title: " Alpha " },
      { key: "a", title: "Duplicate" },
      { key: "", title: "No key" },
      { key: "b", title: "   " },
      "nonsense",
      null,
      { key: "c", title: "x".repeat(80) },
    ]);
    assert.deepStrictEqual(
      projects.map((project) => project.key),
      ["a", "c"],
    );
    assert.strictEqual(projects[0]?.title, "Alpha");
    assert.strictEqual(projects[1]?.title.length, 48);
    assert.strictEqual(normalizeTrayProjects("not a list").length, 0);
  });

  it("routes project clicks through a prefixed menu action", () => {
    assert.strictEqual(trayOpenProjectAction("inst:p1"), "open-project:inst:p1");
  });
});

describe("closing the last window", () => {
  it("keeps the app in the tray on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
      assert.isFalse(
        shouldQuitWhenAllWindowsClosed({ platform, quitting: false, trayActive: true }),
      );
    }
  });

  it("falls back to the previous rule without a tray", () => {
    assert.isFalse(
      shouldQuitWhenAllWindowsClosed({ platform: "darwin", quitting: false, trayActive: false }),
    );
    assert.isTrue(
      shouldQuitWhenAllWindowsClosed({ platform: "win32", quitting: false, trayActive: false }),
    );
    assert.isFalse(
      shouldQuitWhenAllWindowsClosed({ platform: "linux", quitting: true, trayActive: false }),
    );
  });
});
