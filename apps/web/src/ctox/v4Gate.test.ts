// @effect-diagnostics nodeBuiltinImport:off - Der Gate-Test liest den vendorten Befehlsvertrag direkt.
// V4 gate: the Workjet data layer against the vendored fake core at the kernel pin
// (kernel/KERNEL_PIN). K-WJ-B2-proof: the active Workjet app manifest is published before the
// kernel opens (E35 Nr. 3), the core rejects every command type without a route with
// `unknown_command` at write time (E27.2), and the routes the core knows are exactly the Workjet
// bridge contract (contract/wjb-command-types.json, E27.6). Read paths are local queries (E32);
// a V3 instance (no bound client) keeps the desktop guest path unchanged.
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@workjet/contracts";
import type { CtoxWorkjetProjectControlResult, DesktopCtoxBridge } from "@workjet/contracts";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernelTestkit";
import type { CtoxAppApi, Kernel } from "./kernel/index";
import { bindKernelCtoxClient } from "./kernelClient";
import { bindCtoxClient, getCtoxClient } from "./ctoxClient";
import { withStubAppPrefs } from "./appPrefsStub.fixture";
import { writeAppPref } from "./appPrefs";
import { CtoxCommandError, executeCtoxCommand } from "./commands";
import {
  WORKJET_APP_ID,
  WORKJET_FOREIGN_COLLECTIONS,
  workjetAppManifest,
  workjetForeignOwnerManifests,
} from "./workjetAppManifest";
import { E25_METHODS, requestCtoxNative, type E25Method } from "./e25Native";
import { PROJECT_MUTATION_ACTIONS, projectCommandType } from "./projectCommands";
import { readWorkjetThreadDetail } from "./workjetThreadData";
import {
  listWorkjetProjects,
  readWorkjetProjectKpis,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";
import { requestWorkjetSessionControl } from "../workjetSessionControl";
import { listBusinessOsDevices } from "../components/settings/businessOsDeviceControl";
import { createComputerMembershipStore } from "../workjetComputerMembership";

type BridgeEntry = { action: string; command_types: string[]; via: string };
const CONTRACT: BridgeEntry[] = JSON.parse(
  NodeFS.readFileSync(new URL("./contract/wjb-command-types.json", import.meta.url), "utf8"),
);
const CONTRACT_TYPES = new Set(CONTRACT.flatMap((entry) => entry.command_types));
const E25 = Object.keys(E25_METHODS) as E25Method[];
const APP_VER = "v4-gate";

let sequence = 0;
const open: { kernel: Kernel; release: () => void }[] = [];
afterEach(async () => {
  for (const { kernel, release } of open.splice(0)) {
    release();
    await kernel.close();
  }
});

/** Simulated Core registry: exactly the contract routes; each answers with a value result. */
function registerRoutes(transport: MemoryCoreTransport, types: Iterable<string>) {
  for (const type of types)
    transport.handlers.set(type, (payload) => ({ route: type, payload, nullable: null }));
}

async function openGate(options: { routes?: Iterable<string>; publishManifest?: boolean } = {}) {
  const instanceId = `v4-gate-${++sequence}`;
  const transport = new MemoryCoreTransport({ namespace: instanceId, latencyMs: 0 });
  if (options.publishManifest !== false) {
    // E35 Nr. 3: the tested app's active manifest exists in the core before the kernel opens.
    await transport.push("business_app_versions", [
      {
        id: `${WORKJET_APP_ID}@${APP_VER}`,
        app_id: WORKJET_APP_ID,
        app_ver: APP_VER,
        manifest: workjetAppManifest(APP_VER),
      },
    ]);
    // Owner of the foreign collections Workjet reads (app ctox, K-WJ-1). At this kernel pin
    // PLATFORM_COLLECTIONS lacks devices/machine_enrollments, so the fixture owner carries them.
    await transport.push("business_app_versions", [...workjetForeignOwnerManifests("v4-gate")]);
    await transport.push("business_apps", [
      { id: "ctox", title: "Crew", active_ver: "v4-gate" },
      { id: "ctox-platform", title: "Platform", active_ver: "v4-gate" },
      { id: WORKJET_APP_ID, title: "Workjet", active_ver: APP_VER },
      { id: "shell", title: "Shell", active_ver: "v4-gate-shell" },
    ]);
  }
  registerRoutes(transport, options.routes ?? CONTRACT_TYPES);
  const kernel = createKernel({
    instanceId,
    userId: "gate-owner",
    storage: "memory",
    dbName: `${instanceId}-db`,
    multiTab: false,
    transport,
  });
  await kernel.ready;
  if (options.publishManifest !== false) {
    // The published app/shell facts replicate from the core; the kernel never assumes them.
    const apps = kernel.appApi("fixture-probe", "0").query<{ id: string }>("business_apps", {});
    const off = apps.subscribe(() => {});
    try {
      await vi.waitFor(
        () => {
          if (!apps.get().some((row) => row.id === "shell")) throw new Error("shell not synced");
        },
        { timeout: 2_000, interval: 5 },
      );
    } finally {
      off();
    }
  }
  const release = bindKernelCtoxClient(kernel, APP_VER);
  open.push({ kernel, release });
  const api = getCtoxClient(instanceId)!;
  /** Core commit, then wait until the kernel's live query carries every document. */
  const seed = async (collection: string, docs: { id: string; [key: string]: unknown }[]) => {
    const live = api.query<{ id: string }>(collection, {});
    const off = live.subscribe(() => {});
    try {
      // Generation 1 travels under the plain name (§16.4); the kernel subscribed on activation.
      await transport.push(collection, docs);
      await vi.waitFor(
        () => {
          const ids = new Set(live.get().map((row) => row.id));
          if (!docs.every((doc) => ids.has(doc.id))) throw new Error(`${collection} not synced`);
        },
        { timeout: 2_000, interval: 5 },
      );
    } finally {
      off();
    }
  };
  return { instanceId, api, kernel, transport, seed };
}

const noGuest: WorkjetProjectControlPort = () => {
  throw new Error("a V4 read must not reach the desktop guest");
};

async function settle(api: CtoxAppApi, type: string, payload: object) {
  try {
    return { ok: true as const, value: await executeCtoxCommand(api, type, payload) };
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof CtoxCommandError ? error.code : String(error),
    };
  }
}

describe("V4 gate: manifest and command contract (E35 Nr. 3, K-WJ-B2, E27.6)", () => {
  it("publishes the active Workjet manifest in the core before the kernel opens", async () => {
    const { transport } = await openGate();
    const versions = (transport as unknown as { core: { docs: Map<string, { data: unknown }> } })
      .core.docs;
    const active = versions.get(JSON.stringify(["business_apps", WORKJET_APP_ID]))?.data as
      | { active_ver?: string }
      | undefined;
    expect(active?.active_ver).toBe(APP_VER);
    const manifest = versions.get(
      JSON.stringify(["business_app_versions", `${WORKJET_APP_ID}@${APP_VER}`]),
    )?.data as { manifest?: { app_id?: string; min_app_api?: string } } | undefined;
    expect(manifest?.manifest).toMatchObject({ app_id: WORKJET_APP_ID, min_app_api: "4.0" });
  });

  it("rejects a command type outside the contract with unknown_command at write time", async () => {
    const { api } = await openGate();
    const handle = api.command("ctox.workjet.project.not_a_route", { probe: true });
    const write = await handle.result;
    expect(write).toMatchObject({ status: "rejected", code: "unknown_command" });
    // Never accepted first and failed later (E27.2).
    expect(write.status).not.toBe("accepted");
    expect(await settle(api, "ctox.workjet.project.not_a_route", {})).toEqual({
      ok: false,
      code: "unknown_command",
    });
  });

  it("maps every V4 project mutation to a contract route and runs it to a terminal result", async () => {
    const { api } = await openGate();
    const types = [...new Set(PROJECT_MUTATION_ACTIONS.map(projectCommandType))];
    for (const type of types) expect(CONTRACT_TYPES, type).toContain(type);
    const results = await Promise.all(types.map((type) => settle(api, type, { probe: type })));
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("keeps the contract file and the E25 acceptance list consistent", () => {
    expect(CONTRACT.length).toBeGreaterThan(0);
    for (const method of E25) expect(CONTRACT_TYPES, method).toContain(method);
    // The reserved Core namespace only; the bridge never invents app-local types here.
    for (const type of CONTRACT_TYPES) expect(type.startsWith("ctox.")).toBe(true);
  });
});

describe("V4 gate: the six E25 methods (E25, E26, E27.1)", () => {
  for (const method of E25) {
    // At pin eca39cf84 every `ctox.workjet.*.v1` type is a Core platform route (E39/E42
    // command inventory); the fake Core answers it itself with an explicit Core outcome.
    it(`${method} runs as a typed core platform command and returns the result value`, async () => {
      const { api } = await openGate();
      await expect(
        requestCtoxNative(api, method, { action: "probe", nullable: null }),
      ).resolves.toEqual({
        route: "core",
        type: method,
      });
    });
    it(`${method} needs no app handler or simulated route (platform routing)`, async () => {
      const { api } = await openGate({ routes: [] });
      await expect(requestCtoxNative(api, method, { action: "probe" })).resolves.toMatchObject({
        route: "core",
      });
    });
  }
});

describe("V4 gate: read paths are local queries on a V4 instance (E32)", () => {
  it("project.list and KPIs", async () => {
    const { instanceId, seed } = await openGate();
    await seed("workjet_projects", [
      { id: "p-1", title: "Gate project", workingCopies: [], status: "active" },
      { id: "p-2", title: "Archived", workingCopies: [], status: "archived" },
    ]);
    await seed("workjet_project_kpis", [{ id: "p-1", project_id: "p-1", revision: 4, items: [] }]);
    const list = await listWorkjetProjects(instanceId, noGuest);
    expect(list._tag === "completed" && list.response.action === "project.list").toBe(true);
    if (list._tag !== "completed" || list.response.action !== "project.list") return;
    expect(list.response.projects.map((project) => project.id)).toEqual(["p-1"]);
    const viaControl = await requestWorkjetProjectControl(
      instanceId,
      { action: "project.list" },
      noGuest,
    );
    expect(viaControl._tag).toBe("completed");
    const kpis = await readWorkjetProjectKpis(instanceId, ProjectId.make("p-1"), noGuest);
    expect(
      kpis._tag === "completed" && kpis.response.action === "project.kpis.read"
        ? kpis.response.kpis.revision
        : null,
    ).toBe(4);
  });

  it("threads", async () => {
    const { api, seed } = await openGate();
    const timestamp = "2026-10-16T00:00:00.000Z";
    await seed("workjet_threads", [
      {
        id: "t",
        environmentId: "gate-computer",
        projectId: "p-1",
        title: "Gate thread",
        modelSelection: { instanceId: "gate-provider", model: "gate-model" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ]);
    await seed("workjet_thread_messages", [
      {
        id: "m",
        thread_id: "t",
        role: "assistant",
        text: "Gate answer",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    const ref = {
      environmentId: EnvironmentId.make("gate-computer"),
      threadId: ThreadId.make("t"),
    };
    expect(readWorkjetThreadDetail(api, ref)?.messages.map((message) => message.text)).toEqual([
      "Gate answer",
    ]);
  });

  it("meetings, provider, speech and calendar settings", async () => {
    const { instanceId, seed } = await openGate();
    const read = (request: Parameters<typeof requestWorkjetProjectControl>[1]) =>
      requestWorkjetProjectControl(instanceId, request, noGuest);
    const completed = (result: CtoxWorkjetProjectControlResult) =>
      result._tag === "completed" ? result.response : result;
    const meeting = completed(
      await read({
        action: "project.jour_fixe.meeting.read",
        commandId: CommandId.make("gate-meeting"),
        projectId: ProjectId.make("p-1"),
      }),
    );
    expect(meeting).toMatchObject({ action: "project.jour_fixe.meeting.read", meeting: null });

    await seed("workjet_provider_registry", [
      {
        id: "instance",
        ok: true,
        schema: "ctox.provider-federation-registry.v1",
        revision: 1,
      },
    ]);
    const providers = completed(
      await read({
        action: "instance.providers.read",
        version: 1,
        operationId: "8d7f8a52-3c1e-4b8a-9b9e-2f4c6d1e0a11",
      }),
    );
    expect(providers).toMatchObject({
      action: "instance.providers.read",
      registry: { revision: 1, accounts: [], providers: [] },
    });

    await seed("workjet_speech_settings", [
      {
        id: "instance",
        ttsCheck: null,
        status: {
          config: { synthesis: "mistral", transcription: "mistral", voice_id: null, rate: 1 },
          mistral_credential_present: true,
          mistral_voice_configured: false,
          streaming_stt_selected: true,
          stt: "available",
          tts: "unknown",
        },
      },
    ]);
    const speech = completed(
      await read({ action: "speech.settings.read", commandId: CommandId.make("gate-speech") }),
    );
    expect(speech).toMatchObject({
      action: "speech.settings.read",
      status: { config: { rate: 1 } },
    });

    await seed("workjet_calendar_state", [{ id: "accounts", truncated: false }]);
    const calendar = completed(
      await read({
        action: "project.calendar.accounts.read",
        commandId: CommandId.make("gate-calendar"),
      }),
    );
    expect(calendar).toMatchObject({
      action: "project.calendar.accounts.read",
      calendar: { ok: true, truncated: false, accounts: [] },
    });
  });

  it("devices, computers, sessions and transfer status", async () => {
    const { instanceId, seed } = await openGate();
    await seed("devices", [
      {
        id: "pairing-1",
        kind: "desktop",
        label: "Gate Mac",
        user_id: "gate-owner",
        created_at_ms: 1_000,
        connected: true,
        last_seen_at_ms: 2_000,
      },
    ]);
    const bridge = {
      requestDeviceControl: () => {
        throw new Error("a V4 device read must not reach the desktop bridge");
      },
    } as unknown as DesktopCtoxBridge;
    expect(await listBusinessOsDevices(bridge, instanceId, "bos-1")).toEqual({
      devices: [
        {
          devicePairingId: "pairing-1",
          deviceId: "pairing-1",
          businessOsInstanceId: "bos-1",
          pairedAtMillis: 1_000,
          displayName: "Gate Mac",
        },
      ],
    });

    await seed("workjet_computers", [
      {
        id: "computer-1",
        display_name: "Gate computer",
        hosting_mode: "workstation",
        status: "assigned",
        capabilities: [],
        self_hosted_colocation: false,
      },
    ]);
    const membership = createComputerMembershipStore();
    try {
      await membership.refresh(instanceId, bridge);
      await vi.waitFor(() => {
        if (membership.getSnapshot().phase !== "ready") throw new Error("computers not ready");
      });
      expect(membership.getSnapshot().computers.map((computer) => computer.id)).toEqual([
        "computer-1",
      ]);
    } finally {
      membership.dispose();
    }

    const sessions = await requestWorkjetSessionControl(instanceId, { action: "session.list" });
    expect(sessions).toEqual({
      _tag: "completed",
      response: { action: "session.list", sessions: [] },
    });
    await seed("workjet_session_transfers", [
      {
        id: "transfer-1",
        session_id: "session-1",
        state: "running",
        retryable: false,
        error_code: null,
        updated_at_ms: 3_000,
      },
    ]);
    const transfer = await requestWorkjetSessionControl(instanceId, {
      action: "session.transfer.status",
      commandId: "gate-transfer" as never,
      transferId: "transfer-1" as never,
    });
    expect(transfer).toEqual({
      _tag: "completed",
      response: {
        action: "session.transfer.status",
        outcome: { ok: true, transferId: "transfer-1", state: "running", retryable: false },
      },
    });
  });
});

describe("V4 gate: a V3 instance keeps the desktop guest path (no bound client)", () => {
  it("routes project, KPI, session and device reads to the desktop port", async () => {
    const instanceId = `v3-instance-${++sequence}`;
    expect(getCtoxClient(instanceId)).toBeNull();
    const port = vi.fn<WorkjetProjectControlPort>(async () => ({
      _tag: "completed",
      response: { action: "project.list", projects: [], count: 0, truncated: false },
    }));
    const list = await listWorkjetProjects(instanceId, port);
    expect(list._tag).toBe("completed");
    expect(port).toHaveBeenCalledWith(
      instanceId,
      expect.objectContaining({ action: "project.list" }),
    );

    port.mockClear();
    await readWorkjetProjectKpis(instanceId, ProjectId.make("p-1"), port);
    expect(port).toHaveBeenCalledWith(
      instanceId,
      expect.objectContaining({ action: "project.kpis.read", projectId: "p-1" }),
    );

    const sessionPort = vi.fn(async () => ({
      _tag: "completed" as const,
      response: { action: "session.list" as const, sessions: [] },
    }));
    await requestWorkjetSessionControl(instanceId, { action: "session.list" }, sessionPort);
    expect(sessionPort).toHaveBeenCalledTimes(1);

    const requestDeviceControl = vi.fn(async () => ({
      _tag: "completed" as const,
      response: { bindings: [] },
    }));
    await listBusinessOsDevices(
      { requestDeviceControl } as unknown as DesktopCtoxBridge,
      instanceId,
      "bos-1",
    );
    expect(requestDeviceControl).toHaveBeenCalledWith(instanceId, { action: "binding.list" });
  });
});

describe("V4 gate: E49.4 gallery order and project feed are Workjet app data", () => {
  it("V4: gallery order is user UI state in api.prefs (E56.2), never a collection or command", async () => {
    const { instanceId, api } = await openGate({ routes: [] });
    const { api: prefsApi, prefsOf, close } = await withStubAppPrefs(api);
    open.push({ kernel: { close } as unknown as Kernel, release: () => {} });
    const command = vi.fn(() => {
      throw new Error("gallery order must not send a command");
    });
    const guarded = Object.create(prefsApi, { command: { value: command } }) as CtoxAppApi;
    open.push({
      kernel: { close: async () => {} } as unknown as Kernel,
      release: bindCtoxClient(instanceId, guarded),
    });
    const read = (id: string) =>
      requestWorkjetProjectControl(
        instanceId,
        { action: "project.gallery.order.read", commandId: CommandId.make(id) },
        noGuest,
      );
    // Nothing stored yet reads as the empty order at revision 0.
    expect(await read("gate-gallery-empty")).toMatchObject({
      _tag: "completed",
      response: { action: "project.gallery.order.read", order: { revision: 0, projectIds: [] } },
    });
    const set = (expectedRevision: number, ids: string[]) =>
      requestWorkjetProjectControl(
        instanceId,
        {
          action: "project.gallery.order.set",
          commandId: CommandId.make(`gate-gallery-${expectedRevision}`),
          operationId: `gate-gallery-op-${expectedRevision}`,
          expectedRevision,
          projectIds: ids.map((id) => ProjectId.make(id)),
        },
        noGuest,
      );
    expect(await set(0, ["p-2", "p-1"])).toMatchObject({
      _tag: "completed",
      response: { action: "project.gallery.order.set", order: { revision: 1 } },
    });
    expect(await set(1, ["p-1", "p-2"])).toMatchObject({
      _tag: "completed",
      response: { order: { revision: 2, projectIds: ["p-1", "p-2"] } },
    });
    // Optimistic revision: a stale writer is refused locally (conflict), nothing is written.
    expect(await set(1, ["p-3"])).toMatchObject({
      _tag: "failed",
      error: { code: "conflict", reason: "gallery_order_revision_mismatch" },
    });
    expect(await read("gate-gallery-read")).toMatchObject({
      _tag: "completed",
      response: {
        action: "project.gallery.order.read",
        order: { revision: 2, projectIds: ["p-1", "p-2"] },
      },
    });
    // Stored through the real E51 api.prefs: for the app workjet and this user only.
    expect(prefsOf("workjet").get("gallery.order")).toEqual({
      revision: 2,
      projectIds: ["p-1", "p-2"],
    });
    expect(prefsOf("other-app").get("gallery.order")).toBeNull();
    // E51 bounds come from the stub: an oversized value is refused as quota before any write.
    await expect(
      writeAppPref(prefsApi, "gallery.order", { blob: "x".repeat(20_000) }),
    ).rejects.toMatchObject({ code: "quota", reason: "pref_write_rejected" });
    expect(command).not.toHaveBeenCalled();
    expect(JSON.stringify(workjetAppManifest(APP_VER))).not.toContain("gallery");
  });

  it("V4: without api.prefs the gallery order is unavailable, with no collection fallback", async () => {
    const { instanceId } = await openGate({ routes: [] });
    expect(
      await requestWorkjetProjectControl(
        instanceId,
        { action: "project.gallery.order.read", commandId: CommandId.make("gate-gallery-np") },
        noGuest,
      ),
    ).toMatchObject({
      _tag: "failed",
      error: { code: "unavailable", reason: "prefs_unavailable" },
    });
  });

  it("E54.3b: the manifest owns exactly the five Workjet collections", () => {
    const manifest = workjetAppManifest(APP_VER);
    expect(Object.keys(manifest.collections).sort()).toEqual(
      [
        "workjet_luma_state",
        "workjet_mailbox_envelopes",
        "workjet_worker_dispatch_intents",
        "workjet_worker_dispatch_outcomes",
        "workjet_worker_dispatch_sources",
      ].sort(),
    );
    for (const read of [
      "workjet_projects",
      "workjet_project_kpis",
      "workjet_project_feed",
      "workjet_worker_profiles",
      "ctox_task_approval_requests",
    ])
      expect(manifest.foreign_collections, read).toHaveProperty(read, {
        owner_app: "ctox",
        ops: ["read"],
      });
    // Approval is a platform route; the restart joins once its Core route exists.
    expect(manifest.commands_out).toEqual([]);
    // The dispatch handler lives in the instance module (Shell v4), not in this manifest.
    expect(manifest.handlers).toEqual({});
    expect(JSON.stringify(manifest)).not.toContain("workjet.worker.dispatch");
  });

  it("V4: project feed is a local query", async () => {
    const { instanceId, seed } = await openGate();
    await seed("workjet_project_feed", [
      {
        id: "post-1",
        post_id: "post-1",
        project_id: "p-1",
        kind: "owner_note",
        author_kind: "owner",
        author_thread: null,
        author_label: "Owner",
        harness: null,
        headline: "Gate note",
        body: "Local feed",
        open_items: null,
        sources: [],
        action: null,
        thread_ref: null,
        occurred_at_ms: 5_000,
      },
    ]);
    const feed = await requestWorkjetProjectControl(
      instanceId,
      {
        action: "project.feed.read",
        commandId: CommandId.make("gate-feed"),
        projectId: ProjectId.make("p-1"),
      },
      noGuest,
    );
    expect(feed).toMatchObject({
      _tag: "completed",
      response: { action: "project.feed.read", posts: [{ post_id: "post-1" }] },
    });
  });

  it("V3: gallery order set and feed read still go to the desktop port", async () => {
    const instanceId = `v3-gallery-${++sequence}`;
    const port = vi.fn<WorkjetProjectControlPort>(async () => ({
      _tag: "failed",
      code: "not_active",
    }));
    await requestWorkjetProjectControl(
      instanceId,
      {
        action: "project.gallery.order.set",
        commandId: CommandId.make("v3-gallery"),
        operationId: "v3-gallery-op",
        expectedRevision: 0,
        projectIds: [],
      },
      port,
    );
    await requestWorkjetProjectControl(
      instanceId,
      {
        action: "project.feed.read",
        commandId: CommandId.make("v3-feed"),
        projectId: ProjectId.make("p-1"),
      },
      port,
    );
    expect(port.mock.calls.map(([, request]) => request.action)).toEqual([
      "project.gallery.order.set",
      "project.feed.read",
    ]);
  });
});
