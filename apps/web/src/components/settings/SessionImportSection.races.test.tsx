import {
  EnvironmentId,
  ProviderInstanceId,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportInspection,
} from "@workjet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  scope: { selectedInstanceId: "instance-a", selectionRevision: 1, mode: "instance" },
  inspect: vi.fn(),
  importSessions: vi.fn(),
  createProject: vi.fn(),
  queryInput: vi.fn((input: unknown) => input),
  refresh: vi.fn(),
  inspectCommand: Symbol("inspect"),
  importCommand: Symbol("import"),
  createCommand: Symbol("create"),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: reactHookHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../activeWorkjetScope", () => ({
  useActiveWorkjetScope: () => state.scope,
  readActiveWorkjetScope: () => state.scope,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ workjet: { computers: [] } }),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "environment-a" }));
vi.mock("../../state/projects", () => ({
  environmentProjects: { environmentProjectsAtom: () => null },
  projectEnvironment: { create: state.createCommand },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    workjetSessionImport: state.queryInput,
    inspectWorkjetSessions: state.inspectCommand,
    importWorkjetSessions: state.importCommand,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { candidates: [], sources: [], truncated: false, nextOffset: null },
    isPending: false,
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === state.inspectCommand
      ? state.inspect
      : command === state.importCommand
        ? state.importSessions
        : state.createProject,
}));
vi.mock("../../workjetProjectCreation", () => ({
  workjetProjectCreationFailureMessage: vi.fn(),
  runWorkjetProjectCreation: vi.fn(),
}));
vi.mock("../../workjetProjectControl", () => ({ listWorkjetProjects: vi.fn() }));
vi.mock("../../workjetProjectRegistry", () => ({
  recordWorkjetProjectProjection: vi.fn(),
  useWorkjetProjectRegistry: () => ({ projects: [] }),
}));

import { SessionImportBrowser, type SessionImportBrowserProps } from "./SessionImportBrowser";
import { SessionImportSection } from "./SessionImportSection";

const environmentId = EnvironmentId.make("environment-a");
const candidate = (id: number): WorkjetSessionImportCandidate => ({
  candidateId: `wjsi_${id.toString(16).padStart(32, "0")}`,
  source: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  title: `Conversation ${id}`,
  workspaceRoot: "/workspace/source",
  workspaceAvailable: true,
  createdAt: "2026-10-04T08:00:00Z",
  updatedAt: "2026-10-04T08:00:00Z",
  sourceSizeBytes: 42,
  importedThreadId: null,
});
const success = (candidates: readonly WorkjetSessionImportCandidate[] = []) => ({
  _tag: "Success" as const,
  value: {
    sources: [],
    candidates,
    discoveryVersion: "a".repeat(64),
    truncated: false,
    nextOffset: null,
  } satisfies WorkjetSessionImportInspection,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function render(): SessionImportBrowserProps {
  hooks.beginRender();
  const tree = SessionImportSection({ environmentId, readOnly: false });
  const browser = visitElements(tree, (element) => element.type === SessionImportBrowser);
  if (!browser) throw new Error("Missing import browser");
  return browser.props as unknown as SessionImportBrowserProps;
}
async function settle() {
  // The public callback intentionally returns void; drain its bounded async page chain.
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function switchInstance(selectedInstanceId: string, selectionRevision: number) {
  state.scope = { ...state.scope, selectedInstanceId, selectionRevision };
  render();
  return render();
}

describe("session import scope and search races", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    state.scope = { selectedInstanceId: "instance-a", selectionRevision: 1, mode: "instance" };
    state.inspect.mockReset().mockResolvedValue(success());
    state.importSessions.mockReset();
    state.createProject.mockReset();
    state.queryInput.mockClear();
    state.refresh.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    hooks.reset();
  });

  it("selects the visible search before the 250 ms inspection debounce finishes", async () => {
    render().onOpenChange(true);
    render().onQueryChange("Archived planning");
    let browser = render();
    expect(browser.query).toBe("Archived planning");
    expect(state.queryInput.mock.lastCall?.[0]).toMatchObject({ input: { query: "" } });
    await vi.advanceTimersByTimeAsync(249);

    browser.onSelectAll();
    await settle();
    expect(state.inspect).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { query: "Archived planning", limit: 100, offset: 0 },
    });
    expect(state.queryInput.mock.lastCall?.[0]).toMatchObject({ input: { query: "" } });

    await vi.advanceTimersByTimeAsync(1);
    browser = render();
    expect(state.queryInput.mock.lastCall?.[0]).toMatchObject({
      input: { query: "Archived planning" },
    });
    expect(browser.progress).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "ignores an old %s reply after A → B → A without unlocking the new selection",
    async (outcome) => {
      const oldRequest = deferred<ReturnType<typeof success>>();
      const newRequest = deferred<ReturnType<typeof success>>();
      state.inspect
        .mockImplementationOnce(() => oldRequest.promise)
        .mockImplementationOnce(() => newRequest.promise);
      render().onSelectAll();
      await settle();
      expect(state.inspect).toHaveBeenCalledTimes(1);

      switchInstance("instance-b", 2);
      let browser = switchInstance("instance-a", 3);
      browser.onSelectAll();
      await settle();
      browser = render();
      expect(state.inspect).toHaveBeenCalledTimes(2);
      expect(browser.progress).toBe("Selecting conversations…");

      if (outcome === "success") oldRequest.resolve(success([candidate(1)]));
      else oldRequest.reject(new Error("Old instance request failed"));
      await settle();
      browser = render();
      expect(browser.selected.size).toBe(0);
      expect(browser.error).toBeNull();
      expect(browser.progress).toBe("Selecting conversations…");

      browser.onSelectAll();
      await settle();
      expect(state.inspect).toHaveBeenCalledTimes(2);

      newRequest.resolve(success([candidate(2)]));
      await settle();
      browser = render();
      expect([...browser.selected.keys()]).toEqual([candidate(2).candidateId]);
      expect(browser.progress).toBeNull();
      expect(browser.error).toBeNull();
    },
  );
});
