import { cdpCommandError } from "./lib/cdpClient.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  INITIAL_LIFECYCLE_STATE,
  checkChildProcessProfiles,
  classifyAdvancedStatus,
  cleanupActionOrder,
  isCtoxShellGeometryContained,
  parseProcessTable,
  parseSmokeArguments,
  recursiveDescendants,
  redactSensitive,
  selectTargetByCapability,
  transitionLifecycle,
  type ProcessRecord,
} from "./ctox-packaged-smoke.ts";

const validArgv = [
  "--workjet-executable",
  "/Applications/Workjet.app/Contents/MacOS/Workjet",
  "--ctox-cli",
  "/opt/ctox/bin/ctox",
  "--ctox-instance-dir",
  "/Users/operator/real-ctox",
  "--smoke-root",
  "/Volumes/tmp/workjet-ctox-smoke-1",
] as const;

describe("packaged CTOX smoke argument validation", () => {
  it("accepts explicit absolute paths on macOS", () => {
    expect(parseSmokeArguments(validArgv, "darwin")).toEqual({
      workjetExecutable: "/Applications/Workjet.app/Contents/MacOS/Workjet",
      ctoxCli: "/opt/ctox/bin/ctox",
      ctoxInstanceDir: "/Users/operator/real-ctox",
      smokeRoot: "/Volumes/tmp/workjet-ctox-smoke-1",
    });
  });
  it.each([
    ["unsupported host", validArgv, "linux"],
    ["outside tmp", [...validArgv.slice(0, -1), "/tmp/smoke"], "darwin"],
    ["tmp root itself", [...validArgv.slice(0, -1), "/Volumes/tmp"], "darwin"],
    ["relative executable", ["--workjet-executable", "Workjet", ...validArgv.slice(2)], "darwin"],
    ["missing value", validArgv.slice(0, -1), "darwin"],
    ["unknown flag", ["--other", "/x", ...validArgv.slice(2)], "darwin"],
  ])("rejects %s", (_label, argv, platform) =>
    expect(() => parseSmokeArguments(argv, platform as NodeJS.Platform)).toThrow(),
  );
  it("rejects duplicate flags", () => {
    expect(() =>
      parseSmokeArguments([...validArgv, "--smoke-root", "/Volumes/tmp/other"], "darwin"),
    ).toThrow("duplicate");
  });
});

describe("bounded CDP target selection", () => {
  const target = (id: string) => ({
    id,
    type: "page",
    webSocketDebuggerUrl: `ws://127.0.0.1:42000/${id}`,
  });
  it("selects exactly one capability match", () => {
    expect(
      selectTargetByCapability(
        [
          { target: target("old"), capable: false },
          { target: target("navigated"), capable: true },
        ],
        "guest",
      ).id,
    ).toBe("navigated");
  });
  it("rejects absent or ambiguous matches", () => {
    expect(() => selectTargetByCapability([], "guest")).toThrow(/target selection/u);
    expect(() =>
      selectTargetByCapability(
        [
          { target: target("one"), capable: true },
          { target: target("two"), capable: true },
        ],
        "guest",
      ),
    ).toThrow(/target selection/u);
  });
});

describe("safe CDP diagnostics", () => {
  it("includes only the command and numeric protocol code", () => {
    const error = cdpCommandError("Runtime.evaluate", {
      code: -32_000,
      message: "secret expression contents",
      data: "sensitive invite",
    });
    expect(error.message).toBe("CDP Runtime.evaluate failed (code -32000)");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("sensitive");
  });
  it("omits malformed protocol codes", () => {
    expect(cdpCommandError("Runtime.evaluate", { code: "-32000" }).message).toBe(
      "CDP Runtime.evaluate failed",
    );
  });
});

describe("recursive packaged child profile checks", () => {
  const records: readonly ProcessRecord[] = [
    { pid: 10, ppid: 1, command: "/Applications/Workjet" },
    {
      pid: 11,
      ppid: 10,
      command: "helper --type=gpu-process --user-data-dir=/Volumes/tmp/s/app-data/t3code",
    },
    {
      pid: 12,
      ppid: 11,
      command: "helper --type=utility --user-data-dir=/Volumes/tmp/s/app-data/t3code",
    },
    { pid: 13, ppid: 10, command: "crashpad --database=/Volumes/tmp/s/crash" },
  ];
  it("parses ps output and discovers descendants recursively", () => {
    expect(
      parseProcessTable(" 10 1 main process\n 11 10 helper --type=renderer\ninvalid\n"),
    ).toEqual([
      { pid: 10, ppid: 1, command: "main process" },
      { pid: 11, ppid: 10, command: "helper --type=renderer" },
    ]);
    expect(recursiveDescendants(records, 10).map(({ pid }) => pid)).toEqual([11, 13, 12]);
  });
  it("requires the exact disposable profile on applicable descendants", () => {
    expect(checkChildProcessProfiles(records, 10, "/Volumes/tmp/s/app-data/t3code")).toEqual({
      applicablePids: [11, 12],
      violations: [],
    });
    const bad = records.map((record) =>
      record.pid === 12
        ? {
            ...record,
            command: "helper --type=utility --user-data-dir=/Users/operator/.t3/userdata",
          }
        : record,
    );
    expect(checkChildProcessProfiles(bad, 10, "/Volumes/tmp/s/app-data/t3code").violations).toEqual(
      [{ pid: 12, reason: "mismatch" }],
    );
  });
  it("handles expected profile paths containing spaces", () => {
    const spaced = [
      {
        pid: 2,
        ppid: 1,
        command: "helper --type=renderer --user-data-dir=/Volumes/tmp/smoke root/t3code --lang=en",
      },
    ];
    expect(
      checkChildProcessProfiles(spaced, 1, "/Volumes/tmp/smoke root/t3code").violations,
    ).toEqual([]);
  });
});

describe("visible Business OS product shell geometry", () => {
  const geometry = {
    viewport: { width: 1440, height: 900 },
    sidebar: { left: 0, top: 0, right: 320, bottom: 900, width: 320, height: 900 },
    main: { left: 320, top: 0, right: 1440, bottom: 900, width: 1120, height: 900 },
    chrome: { left: 320, top: 0, right: 1440, bottom: 48, width: 1120, height: 48 },
    host: { left: 320, top: 48, right: 1440, bottom: 900, width: 1120, height: 852 },
  };

  it("accepts a positive guest host right of the sidebar and below shell chrome", () => {
    expect(isCtoxShellGeometryContained(geometry)).toBe(true);
  });

  it("rejects sidebar, chrome, and viewport overlap", () => {
    expect(
      isCtoxShellGeometryContained({
        ...geometry,
        host: { ...geometry.host, left: 319, width: 1121 },
      }),
    ).toBe(false);
    expect(
      isCtoxShellGeometryContained({
        ...geometry,
        host: { ...geometry.host, top: 47, height: 853 },
      }),
    ).toBe(false);
    expect(
      isCtoxShellGeometryContained({
        ...geometry,
        host: { ...geometry.host, right: 1441, width: 1121 },
      }),
    ).toBe(false);
  });
});

describe("advanced status classification", () => {
  it("reads only one bounded browser device from healthy sync status", () => {
    expect(
      classifyAdvancedStatus({
        ok: true,
        sync: { browserDeviceId: "browser-device" },
        counts: { private: 2 },
      }),
    ).toEqual({
      healthy: true,
      peerRevoked: false,
      browserDeviceId: "browser-device",
    });
  });
  it("recognizes nested peer_revoked while unhealthy", () => {
    expect(
      classifyAdvancedStatus({ ok: false, sync: { errors: [{ code: "peer_revoked" }] } }),
    ).toEqual({ healthy: false, peerRevoked: true });
  });
  it("keeps only bounded non-secret advanced status diagnostics", () => {
    expect(
      classifyAdvancedStatus({
        ok: false,
        failures: ["authenticated", "bad value", "x".repeat(81)],
        sync: {
          phase: "reconnecting",
          missingRequiredCollections: ["business_commands"],
          initialSync: {
            missingInitialReplication: ["business_commands"],
            missingStreamingReady: ["ctox_queue_tasks"],
            missingCheckpointEpoch: ["business_module_catalog"],
          },
          frameTransport: {
            totals: { activePeerCount: 0 },
            unhealthyCollections: [
              { collection: "business_commands", reasons: ["no-active-peer"] },
            ],
          },
          collectionErrors: [
            { code: "instance_mismatch", message: "secret" },
            { name: "CtoxReplicationIoError", message: "invite payload" },
            { code: "bad code" },
          ],
        },
        desktopRuntime: {
          dataPlaneStatus: "pending",
          dataPlaneReason: "open-business-data-plane",
          db: true,
          syncConfig: true,
          sync: false,
          commandBus: false,
          ignored: "secret",
        },
      }).diagnostics,
    ).toEqual([
      "phase:reconnecting",
      "failure:authenticated",
      "error:instance_mismatch",
      "error:CtoxReplicationIoError",
      "missing-required:business_commands",
      "missing-initial:business_commands",
      "missing-streaming:ctox_queue_tasks",
      "missing-checkpoint:business_module_catalog",
      "active-peers:0",
      "transport:business_commands:no-active-peer",
      "data-plane:pending",
      "data-plane-reason:open-business-data-plane",
      "runtime:db",
      "runtime:syncConfig",
      "missing:sync",
      "missing:commandBus",
    ]);
  });
  it("rejects unrecognized desktop runtime diagnostic values", () => {
    expect(
      classifyAdvancedStatus({
        ok: false,
        desktopRuntime: {
          dataPlaneStatus: "secret-status",
          dataPlaneReason: "room-secret",
          db: "yes",
          syncConfig: null,
        },
      }).diagnostics,
    ).toBeUndefined();
  });
  it("rejects missing, oversized, or control-bearing device ids", () => {
    expect(classifyAdvancedStatus({ ok: true, sync: {} }).browserDeviceId).toBeUndefined();
    expect(
      classifyAdvancedStatus({ ok: true, sync: { browserDeviceId: "x".repeat(257) } })
        .browserDeviceId,
    ).toBeUndefined();
    expect(
      classifyAdvancedStatus({ ok: true, sync: { browserDeviceId: "bad\ndevice" } })
        .browserDeviceId,
    ).toBeUndefined();
  });
  it("bounds recursive signal inspection", () => {
    let value: unknown = "peer_revoked";
    for (let index = 0; index < 12; index += 1) value = { nested: value };
    expect(classifyAdvancedStatus({ ok: false, value }).peerRevoked).toBe(false);
  });
});

describe("revoke cleanup lifecycle", () => {
  it("places synchronous unrevoke and recovery before destructive cleanup", () => {
    let state = transitionLifecycle(INITIAL_LIFECYCLE_STATE, "paired");
    state = transitionLifecycle(state, "revoked");
    expect(cleanupActionOrder(state)).toEqual([
      "unrevoke",
      "recover",
      "remove-pairing",
      "stop-workjet",
      "delete-temporary-files",
    ]);
    expect(() => transitionLifecycle(state, "pairingRemoved")).toThrow(/unrevoked/u);
    expect(() => transitionLifecycle(state, "workjetStopped")).toThrow(/unrevoked/u);
    expect(() => transitionLifecycle(state, "temporaryFilesDeleted")).toThrow(/unrevoked/u);
  });
  it("requires verified unrevoke before recovery", () => {
    const revoked = transitionLifecycle(
      transitionLifecycle(INITIAL_LIFECYCLE_STATE, "paired"),
      "revoked",
    );
    expect(() => transitionLifecycle(revoked, "recovered")).toThrow(/unrevoke/u);
    const recovered = transitionLifecycle(transitionLifecycle(revoked, "unrevoked"), "recovered");
    expect(cleanupActionOrder(recovered)).toEqual([
      "remove-pairing",
      "stop-workjet",
      "delete-temporary-files",
    ]);
  });
  it("allows idempotent pre-revoke final cleanup", () => {
    const paired = transitionLifecycle(INITIAL_LIFECYCLE_STATE, "paired");
    const removed = transitionLifecycle(paired, "pairingRemoved");
    const stopped = transitionLifecycle(removed, "workjetStopped");
    expect(cleanupActionOrder(transitionLifecycle(stopped, "temporaryFilesDeleted"))).toEqual([]);
  });
});

describe("sensitive error redaction", () => {
  it("redacts exact values and sensitive URL/field forms", () => {
    const invite = '{"signaling_room_password":"secret-room"}';
    const peer = "peer-value-123";
    const output = redactSensitive(
      `failed ${invite} ctox-business-os-desktop://pair?payload=abc peer_id=${peer} capability=token`,
      [invite, peer],
    );
    expect(output).not.toContain(invite);
    expect(output).not.toContain(peer);
    expect(output).not.toContain("payload=abc");
    expect(output).not.toContain("token");
    expect(output).toContain("[REDACTED]");
  });
  it("bounds error length", () => expect(redactSensitive("x".repeat(2_000))).toHaveLength(800));
});
