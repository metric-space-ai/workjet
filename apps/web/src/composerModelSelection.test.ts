import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
  type ModelSelection,
} from "@workjet/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@workjet/contracts/settings";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { describe, expect, it, vi } from "vite-plus/test";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { createComposerModelSelectionWriter } from "./composerModelSelection";
import { buildWorkerOverviewRows } from "./components/WorkjetWorkerOverview";

const ref = scopeThreadRef(
  EnvironmentId.make("selection-computer"),
  ThreadId.make("selection-worker"),
);
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const grok = { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.7" };

function composerModel(selection: ModelSelection) {
  return deriveEffectiveComposerModelState({
    // Simulate local drafts retained across reload, including an older contrary pick.
    draft: {
      activeProvider: codex.instanceId,
      modelSelectionByProvider: { [codex.instanceId]: codex },
    },
    providers: [],
    selectedProvider: ProviderDriverKind.make(selection.instanceId),
    selectedInstanceId: selection.instanceId,
    threadModelSelection: selection,
    preferThreadModelSelection: true,
    projectModelSelection: codex,
    settings: DEFAULT_UNIFIED_SETTINGS,
  }).selectedModel;
}

describe("immediate thread model selection", () => {
  it("saves without a turn and reloads the same route in composer and worker overview", async () => {
    let persisted = JSON.stringify(codex);
    const write = vi.fn(async (_ref: ScopedThreadRef, selection: ModelSelection) => {
      persisted = JSON.stringify(selection);
    });
    const writer = createComposerModelSelectionWriter(write, vi.fn());
    await writer.save(ref, grok);
    expect(write).toHaveBeenCalledWith(ref, grok);
    const reloaded: ModelSelection = JSON.parse(persisted);
    expect(composerModel(reloaded)).toBe(grok.model);
    const parentId = ThreadId.make("selection-parent");
    const worker = {
      id: ref.threadId,
      environmentId: ref.environmentId,
      title: "Persistent worker",
      modelSelection: reloaded,
      workjetConfig: {
        schemaVersion: 1,
        role: "worker",
        parent: { environmentId: ref.environmentId, threadId: parentId },
        managedInstructions: "",
        enabledCapabilityIds: [],
      },
      session: { providerInstanceId: codex.instanceId, providerName: "Codex CLI", status: "idle" },
      latestTurn: null,
    } as EnvironmentThreadShell;
    const parent: EnvironmentThreadShell = {
      ...worker,
      id: parentId,
      workjetConfig: { ...worker.workjetConfig, role: "orchestrator", parent: null },
    };
    expect(buildWorkerOverviewRows([parent, worker], ref.environmentId, parentId)[0]).toMatchObject(
      {
        model: grok.model,
        providerName: grok.instanceId,
        environmentLabel: ref.environmentId,
      },
    );
  });

  it("does not turn a stale local draft into a valid selection after a failed save", async () => {
    const writer = createComposerModelSelectionWriter(async () => {
      throw new Error("Connection unavailable");
    }, vi.fn());
    await expect(writer.save(ref, grok)).rejects.toThrow("Connection unavailable");
    expect(writer.isPending()).toBe(false);
    expect(composerModel(codex)).toBe(codex.model);
  });

  it("keeps send and computer movement pending until all outstanding saves settle", async () => {
    const releases: Array<() => void> = [];
    const onPending = vi.fn();
    const writer = createComposerModelSelectionWriter(
      () => new Promise<void>((resolve) => releases.push(resolve)),
      onPending,
    );
    const first = writer.save(ref, grok);
    const second = writer.save(ref, codex);
    expect(writer.isPending()).toBe(true);
    releases[1]!();
    await second;
    expect(writer.isPending()).toBe(true);
    releases[0]!();
    await first;
    expect(writer.isPending()).toBe(false);
    expect(onPending.mock.calls.map(([pending]) => pending)).toEqual([true, true, true, false]);
  });

  it("ignores a contradictory draft model in the selected saved instance", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: grok.instanceId,
        modelSelectionByProvider: { [grok.instanceId]: { ...grok, model: codex.model } },
      },
      providers: [],
      selectedProvider: ProviderDriverKind.make("grok"),
      selectedInstanceId: grok.instanceId,
      threadModelSelection: grok,
      preferThreadModelSelection: true,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(state.selectedModel).toBe(grok.model);
    expect(state.modelOptions).toBeNull();
  });
});
